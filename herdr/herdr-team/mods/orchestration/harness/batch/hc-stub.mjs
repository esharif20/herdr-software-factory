#!/usr/bin/env node
// Stand-in for `hc` in batch tests. Scenario: $STUB_DIR/scenario.json = { "T-1": [action, ...] }, one action per run/send for that ticket.
// action: { first: false|'hang', writes: { rel: text }, foreign: { rel: text } (written by someone else), bash: [command] (Bash calls in its transcript),
//          usd_tokens: n (output tokens billed to claude-sonnet-5-5), hang: bool (stays working), reply: text (the Worker's last message),
//          ready: false (ends its turn without running the ready command) }
// A finished action (not hanging, not ready: false) runs the ready command its task or latest message gave it, as a real Worker does.
// STUB_SEND_FAIL: addresses whose sends fail.
// A send runs the address's next action in the folder its session was started in (a lane's worktree).
// STUB_NO: templates whose launch fails (e.g. codex not installed).
// Every call is appended to $STUB_DIR/calls.log as "<cmd> <args...>".
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.STUB_DIR;
const [cmd, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'calls.log'), `${Date.now()} ${cmd} ${args.join(' ').replace(/\n/g, ' ⏎ ')}\n`);
const scenario = existsSync(join(dir, 'scenario.json')) ? JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) : {};
const stateFile = (t) => join(dir, `state-${t}.json`);
const load = (t) => (existsSync(stateFile(t)) ? JSON.parse(readFileSync(stateFile(t), 'utf8')) : { n: 0, runs: 0, hang: false });
const save = (t, s) => writeFileSync(stateFile(t), JSON.stringify(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const positional = (a) => { const out = []; for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) { if (['--name', '--cwd', '--timeout'].includes(a[i])) i++; } else out.push(a[i]); } return out; };
const ticketOf = (addr) => /^x(.+)_\d+$/.exec(addr)?.[1];

// Apply the ticket's next scripted action: files written, tokens billed, hang flag.
function act(ticket, addr, cwd, task, msg) {
  const s = load(ticket);
  const r = /batch\.mjs ready (\S+) (\S+) --project (\S+?)[.,;]?(?=\s|$)/.exec(task || msg || '');
  if (r) s.ready = r.slice(1);
  const a = (scenario[ticket] || [])[s.n++] || {};
  for (const [rel, text] of Object.entries({ ...a.writes, ...a.foreign })) { // foreign: written by someone else (the Lead), not in the Worker's transcript
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  }
  const tdir = join(process.env.CLAUDE_PROJECTS, realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const file = join(tdir, `${addr}.jsonl`);
  if (task) writeFileSync(file, JSON.stringify({ type: 'user', message: { content: task } }) + '\n');
  for (const rel of Object.keys(a.writes || {})) appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(cwd, rel) } }] } }) + '\n');
  for (const command of a.bash || []) appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }) + '\n');
  if (a.usd_tokens) appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: `${addr}-${s.n}`, timestamp: new Date().toISOString(), message: { id: `${addr}-${s.n}`, model: 'claude-sonnet-5-5', usage: { output_tokens: a.usd_tokens } } }) + '\n');
  if (a.reply) appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: `${addr}-r${s.n}`, message: { content: [{ type: 'text', text: a.reply }] } }) + '\n');
  s.hang = !!a.hang;
  if (s.ready && !a.hang && a.ready !== false && a.first !== false) {
    const [lane, t, project] = s.ready;
    mkdirSync(join(project, '.tsf/batches/decisions'), { recursive: true });
    writeFileSync(join(project, '.tsf/batches/decisions', `${lane}.${t}.ready`), String(Date.now()));
  }
  save(ticket, s);
  return a;
}

if (cmd === 'run') {
  const p = positional(args); // [role, task]
  if ((process.env.STUB_NO || '').split(',').includes(p[0])) { console.error(`no agent for ${p[0]}`); process.exit(1); } // a seat whose program is missing
  const task = p[1];
  const ticket = /\[batch \S+ (\S+)\]/.exec(task)?.[1];
  const cwd = args[args.indexOf('--cwd') + 1];
  const s = load(ticket); const addr = `x${ticket}_${++s.runs}`; s.cwd = cwd; save(ticket, s);
  const a = act(ticket, addr, cwd, task);
  if (a.first === 'hang') await sleep(5000);
  if (a.first === false) console.log(JSON.stringify({ address: addr, first_message: { sent: false, reason: "it never reported its status, so it may be showing a dialog..." } }));
  else console.log(JSON.stringify({ address: addr, first_message: { sent: true } }));
} else if (cmd === 'send') {
  const [t, text] = positional(args);
  if ((process.env.STUB_SEND_FAIL || '').split(',').includes(t)) { console.error(`no terminal ${t}`); process.exit(1); }
  const ticket = ticketOf(t);
  if (ticket) act(ticket, t, load(ticket).cwd || process.env.STUB_PROJECT, undefined, text);
} else if (cmd === 'wait') {
  const t = positional(args)[0];
  const ticket = ticketOf(t);
  if (ticket && load(ticket).hang) { await sleep(1000); console.log(JSON.stringify({ reason: 'timeout', ended: false })); }
  else console.log(JSON.stringify({ reason: 'idle', ended: false }));
} else if (cmd === 'get') {
  const t = positional(args)[0];
  if (t === 'tstarter' && process.env.STUB_SPACE) console.log(JSON.stringify({ address: t, state: 'live', labels: { 'herdr.space': process.env.STUB_SPACE } }));
  else if (t === process.env.STUB_FACTORY) console.log(JSON.stringify({ address: t, state: 'live', template: 'factory', parent: 'tlead' }));
  else if ((process.env.STUB_LIVE || '').split(',').includes(t)) console.log(JSON.stringify({ address: t, state: 'live', parent: 'tstarter' }));
  else { console.log(JSON.stringify({ error: { kind: 'not_found' } })); process.exit(3); }
}
