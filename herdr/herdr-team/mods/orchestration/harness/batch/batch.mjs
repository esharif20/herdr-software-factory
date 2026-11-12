#!/usr/bin/env node
// Runs a batch of tickets as Workers. Models never wait, code waits: this script is the only thing that polls.
//   node batch.mjs <batch-id> [--project <dir>] [--starter <terminal>] [--shared]
// Start it as its own hc terminal (`hc run --bg --outlive-parent --name lane-<id> -- node batch.mjs ...`) so it outlives whoever started it.
// Reads <project>/.tsf/batches/<id>.tsv (ticket, depends-on, role, writes, gated, brief[, review, race, isolate]), writes <id>.summary.md,
// keeps <id>.live.json current for the team display (pid + heartbeat), and sends the starter one hc message at the end.
// Holds and alerts go to the Lead (the starter's parent when the starter is a factory, else the starter).
// In a git repo the lane builds in its own worktree, <project>/.tsf/lanes/<id> on branch lane/<id>, and commits each finished ticket there;
// --shared builds in the project folder itself. isolate=yes: that row builds in its own worktree <lane worktree>.t/<ticket> on branch
// ticket/<lane>/<ticket> from the lane HEAD, its checks run there, and on pass it is one commit merged into the lane (at most 2 live per lane).
// Every row is done when its session runs `batch.mjs ready <lane> <ticket>` (the task says so), never when it goes idle or sends a message.
// review=full (or yes): a Reviewer starts with the Worker, writes adversarial tests while it builds, reviews once the build is green,
// and its defects go back to the same warm Worker, at most reviewRounds times. full-codex: the same on a Codex Reviewer (Opus if codex
// will not start). light: one Sonnet pass over the green diff, real defects only, no tests, one fix round, then a hold.
// role=builder: no Worker; the factory that started the lane builds the row itself in the lane's folder and says
//   node batch.mjs ready <lane> <ticket> --project <dir>   when done; the same checks run, and failures go back to the factory.
//   node batch.mjs add <lane> <ticket> --role <tier> --writes '<globs>' --brief <path> [--deps T-x,..] [--review no|light|full] [--isolate] --project <dir>:
// a new row for a running lane (the lane re-reads its tsv each poll). Refuses a duplicate id or writes that overlap a running row's.
//   node batch.mjs verify --project <dir>: the project's whole suite (HARNESS suite, else test) once after the last merge;
// prints PASS, or FAIL with the lanes that own the failing files, and writes the output to .tsf/verify.txt.
// Knobs: team.js HARNESS, overridden per job in .tsf/settings.json. Overrides for tests: HC, TICKET_SH, GATE_SH, CAPACITY_SH,
// CLAUDE_PROJECTS, BATCH_POLL_MS, BATCH_FIRST_MS, BATCH_HOLD_MS, BATCH_NUDGE_MS, BATCH_ALERT_MS, BATCH_STALL_MS.
// shortcuts: fix-round counts and the scope snapshot restart when a stopped batch is rerun; a lost Worker is restarted from scratch.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, realpathSync, renameSync, rmSync, openSync, readSync, closeSync, symlinkSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, resolve, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { STATIONS, CREW, BUDGET, HARNESS } from '../../team.js';

const HERE = dirname(fileURLToPath(import.meta.url)), HERE_BATCH = join(HERE, 'batch.mjs');
const ORCH = resolve(HERE, '..');
const HC = process.env.HC || 'hc';
const TICKET_SH = process.env.TICKET_SH || join(ORCH, 'tickets/ticket.sh');
const GATE_SH = process.env.GATE_SH || join(ORCH, 'gate/gate.sh');
const CAPACITY_SH = process.env.CAPACITY_SH || join(ORCH, 'capacity/capacity.sh');
const POLL_MS = +process.env.BATCH_POLL_MS || 5000;
const BRIEF_MS = +process.env.BATCH_BRIEF_MS || 300000; // a row waiting this long for its brief is reported once
const FIRST_MS = +process.env.BATCH_FIRST_MS || 75000; // hc gives a template 60 s to become ready, and many launching at once take longer
// A session idle with no ready file is nudged once, then the Lead hears of it; a row with no stage change and no transcript growth is a stall.
const NUDGE_MS = +process.env.BATCH_NUDGE_MS || 90000, ALERT_MS = +process.env.BATCH_ALERT_MS || 180000, STALL_MS = +process.env.BATCH_STALL_MS || 240000;
const ISOLATE_MAX = 2; // isolated worktrees live per lane at once: each is a full checkout
const decisionFile = (project, lane, ticket) => join(project, '.tsf/batches/decisions', `${lane}.${ticket}`);
const DEFAULT_BUDGET = BUDGET;
const GATES = join(homedir(), '.config/herdr-app/tickets/gates'); // where gate.sh keeps its hidden tests
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_'); // gate.sh's folder-name rule
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// USD per million tokens (same table as the benchmark meter). Unknown models are priced as Opus, the dearest, so a cap never under-counts.
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, w: 5, r: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, w: 2.5, r: 0.1 },
  'claude-fable-5-1': { in: 10, out: 50, w: 12.5, r: 0.25 },
  'claude-fable-5-2': { in: 10, out: 50, w: 12.5, r: 0.25 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, w: 0.125, r: 0.01 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a command, collect stdout. Never throws: { code, out, err, timedOut }.
function run(cmd, args, { timeout, cwd, env } = {}) {
  return new Promise((done) => {
    let out = '', err = '', timedOut = false;
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = timeout && setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); done({ code: 127, out, err: String(e), timedOut }); });
    p.on('close', (code) => { clearTimeout(timer); done({ code: code ?? 1, out, err, timedOut }); });
  });
}
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
// The lane never kills the factory that started it (a builder row's "Worker" is that factory).
const KEEP = new Set();
// Every send is retried once; one that still fails goes to `lost` (set by the lane: its events log and the next digest).
let lost = () => {};
const hc = async (...a) => {
  if (a[0] === 'kill' && KEEP.has(a[1])) return { code: 0, out: '', err: '', timedOut: false };
  let r = await run(HC, a);
  if (a[0] === 'send' && r.code) { r = await run(HC, a); if (r.code) lost(a[1], a[2], r); }
  return r;
};

// ---------- input ----------
// The review column: no, light, full (yes in old tsvs) or full-codex.
const reviewKind = (v = '') => /^(yes|y|true|full)$/i.test(v) ? 'full' : /^(light|full-codex)$/i.test(v) ? v.toLowerCase() : false;
export function parseTsv(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [ticket, deps, role, writes, gated, brief, review, race, isolate] = line.split('\t').map((s) => s.trim());
    if (ticket === 'ticket') continue; // header
    const list = (s) => (!s || s === '-' ? [] : s.split(',').map((x) => x.trim()).filter(Boolean));
    rows.push({ ticket, deps: list(deps), role: role || 'worker', writes: list(writes), gated: /^(yes|y|true)$/i.test(gated || ''), brief, review: reviewKind(review), race: /^(yes|y|true|race)$/i.test(race || ''), isolate: /^(yes|y|true)$/i.test(isolate || '') });
  }
  return rows;
}

export function globToRe(glob) {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matches = (globs, path) => globs.some((g) => globToRe(g).test(path));

export function readSettings(project) {
  return json(existsSync(join(project, '.tsf/settings.json')) ? readFileSync(join(project, '.tsf/settings.json'), 'utf8') : '') || {};
}
export function budgetFor(settings, role, seats = [...STATIONS, ...CREW]) {
  return { ...DEFAULT_BUDGET, ...seats.find((s) => s.id === role)?.budget, ...settings.budgets?.[role] };
}

// ---------- transcripts and cost ----------
const claudeRoot = () => process.env.CLAUDE_PROJECTS || join(homedir(), '.claude/projects');

// Each transcript is parsed once: later polls read only the bytes appended since (other sessions' transcripts grow all run long).
const scanned = new Map(); // path -> { size, head, rest: Buffer, msgs: Map(key -> { model, usage, at }) }
function scan(path, size) {
  let c = scanned.get(path);
  if (!c || size < c.size) c = { size: 0, head: '', rest: Buffer.alloc(0), msgs: new Map() };
  if (size > c.size) {
    const fd = openSync(path, 'r'), add = Buffer.alloc(size - c.size);
    try { readSync(fd, add, 0, add.length, c.size); } finally { closeSync(fd); }
    const buf = Buffer.concat([c.rest, add]), cut = buf.lastIndexOf(10) + 1; // whole lines only; a half-written one waits for the next poll
    const text = buf.subarray(0, cut).toString('utf8');
    c.rest = buf.subarray(cut);
    if (c.head.length < 20000) c.head = (c.head + text).slice(0, 20000);
    for (const line of text.split('\n')) {
      const d = line && json(line), m = d?.message;
      if (d?.type !== 'assistant' || !m?.usage) continue;
      const key = m.id || d.requestId || d.uuid, prev = c.msgs.get(key);
      if (!prev || (m.usage.output_tokens || 0) >= (prev.usage.output_tokens || 0)) c.msgs.set(key, { model: m.model, usage: m.usage, at: d.timestamp ? Date.parse(d.timestamp) : 0 });
    }
    c.size = size;
  }
  scanned.set(path, c);
  return c;
}

// Cost of everything the ticket's Workers have done: transcripts that carry the ticket's marker in their opening lines.
// `project` is the folder the Workers run in (a lane's worktree has its own transcript folder).
export function ticketUsage(project, marker, since = 0, from = 0, exclude = []) {
  let files = [], dir;
  try { dir = join(claudeRoot(), realpathSync(project).replace(/[^A-Za-z0-9]/g, '-')); files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return { usd: 0, files: [] }; }
  let usd = 0;
  const used = [];
  for (const f of files) {
    const path = join(dir, f), st = statSync(path);
    if (st.mtimeMs < since || exclude.includes(path)) continue; // a crashed earlier run's Worker spent that, not this one
    const c = scan(path, st.size);
    if (!c.head.includes(marker)) continue;
    used.push(path);
    for (const { model, usage: u, at } of c.msgs.values()) {
      if (from && at && at < from) continue; // a warm Worker's earlier tickets paid for those turns
      const p = PRICES[model] || PRICES['claude-opus-5-5'];
      usd += ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_creation_input_tokens || 0) * p.w + (u.cache_read_input_tokens || 0) * p.r) / 1e6;
    }
  }
  return { usd, files: used };
}

// The Worker's last message, if it challenges a gate test with a line `CONTRADICTS <test>: <reason>`.
// shortcut: the first colon ends the test name, so a name containing one splits early; the wake still carries the whole line.
export function contradiction(files) {
  const newest = files.map((f) => [statSync(f).mtimeMs, f]).sort((a, b) => b[0] - a[0])[0]?.[1];
  if (!newest) return null;
  const last = readFileSync(newest, 'utf8').split('\n').filter(Boolean).map(json).filter((d) => d?.type === 'assistant').at(-1);
  const text = [].concat(last?.message?.content || []).map((b) => b.text || '').join('\n');
  const m = /^CONTRADICTS\s+(.+?):\s*(.+)$/m.exec(text);
  return m && { test: m[1], reason: m[2] };
}
// The last 150 characters a session said, for alerts about it.
export function lastWords(files) {
  const newest = files.map((f) => { try { return [statSync(f).mtimeMs, f]; } catch { return [0, f]; } }).sort((a, b) => b[0] - a[0])[0]?.[1];
  if (!newest) return '';
  const said = readFileSync(newest, 'utf8').split('\n').filter(Boolean).map(json).filter((d) => d?.type === 'assistant')
    .map((d) => [].concat(d.message?.content || []).map((b) => b?.text || '').join(' ').trim()).filter(Boolean);
  return (said.at(-1) || '').replace(/\s+/g, ' ').slice(-150);
}

// ---------- scope check ----------
const SKIP = (rel) => rel.startsWith('.git/') || rel.includes('node_modules/') || /^\.tsf\/(batches|briefs|traces|handoff|lanes)\//.test(rel) || rel === NOTES; // briefs: the Lead rewrites them mid-run for a change request
// In a git repo, the files git sees (so ignored build output such as target/, dist/ or .venv never counts); elsewhere a walk.
export function snapshot(project) {
  const snap = new Map();
  const add = (rel) => { if (SKIP(rel)) return; try { const s = statSync(join(project, rel)); if (s.isFile()) snap.set(rel, `${s.mtimeMs}:${s.size}`); } catch {} };
  const g = spawnSync('git', ['-C', project, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (g.status === 0) { for (const rel of g.stdout.split('\0')) if (rel) add(rel); return snap; }
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = relative(project, join(d, e.name));
      if (e.isDirectory()) { if (!SKIP(rel + '/')) walk(join(d, e.name)); }
      else if (e.isFile()) add(rel);
    }
  };
  walk(project);
  return snap;
}
const NOTES = '.tsf/notes.md'; // the shared notes board: one-line facts Workers leave for each other, never a scope violation
// An isolated row's `before` carries its base commit: every file changed since, committed or not, written by anyone (ignored files never count).
const gitChanged = (dir, base) => {
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout || '';
  return [...new Set([...g('diff', '--name-only', '--no-renames', '-z', base).split('\0'), ...g('ls-files', '-z', '-o', '--exclude-standard').split('\0')])].filter((f) => f && !SKIP(f));
};
const changedSince = (dir, before) => { if (before.base) return gitChanged(dir, before.base); const after = snapshot(dir); return [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f)); };
const REVIEW = '.tsf/review.md'; // the one .tsf file a reviewer row writes: its findings
const reviewFileOf = (t) => `.tsf/review/${t}.md`; // a review=yes row's Reviewer writes its findings here
const reviewTestsOf = (t) => `**/*${t.toLowerCase().replace(/[^a-z0-9]/g, '?')}?review*`; // and its adversarial tests, in any language's test folder
const isProtected = (rel, gateDirRel) => rel.startsWith('.tsf/') || basename(rel) === 'gate.sh' || (gateDirRel && rel.startsWith(gateDirRel));

// The files a shell command writes: redirect targets, tee, sed/perl -i, and cp/mv/rm/touch/git checkout|restore targets.
// Only targets, never every path a command names: `cp CHANGE.md /tmp/x` reads CHANGE.md (a Worker was told to revert a file it had only copied).
// shortcut: paths are taken from the Worker's own folder, so a write after `cd sub`, or by a script that names no path, goes unseen.
const TOKEN = /\n|&&|\|\||[|;&()]|(?:\d|&)?>>?|<<-?|<|(?:[^\s|;&()<>'"]+|'[^']*'|"(?:\\.|[^"\\])*")+/g;
const unquote = (w) => w.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_, a, b) => a ?? b);
export function writeTargets(command) {
  const out = [];
  let words = [];
  const done = () => {
    const [cmd = '', ...args] = words, name = basename(cmd), files = args.filter((a) => a && !a.startsWith('-'));
    words = [];
    if (['tee', 'rm', 'touch', 'mv', 'unlink', 'truncate'].includes(name)) out.push(...files);
    else if (['cp', 'install', 'ln', 'rsync'].includes(name) && files.length > 1) out.push(files.at(-1));
    else if (name === 'git' && ['checkout', 'restore', 'rm', 'mv'].includes(files[0])) out.push(...files.slice(1));
    else if ((name === 'sed' || name === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) {
      let script = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('-')) { if (/^-[a-zA-Z]*e$/.test(a) || a === '--expression') { i++; script = true; } continue; }
        if (!a) continue; // BSD `sed -i ''`
        if (script) out.push(a); else script = true;
      }
    }
  };
  const toks = command.match(TOKEN) || [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^(?:\d|&)?>>?$/.test(t)) { const n = toks[i + 1]; if (n && !/^[|;&()<>\n]/.test(n)) { out.push(unquote(n)); i++; } }
    else if (/^<<?-?$/.test(t)) i++; // input file or heredoc word
    else if (/^(\n|&&|\|\||[|;&()])$/.test(t)) done();
    else words.push(unquote(t));
  }
  done();
  return out.filter((p) => p && !p.startsWith('/dev/'));
}

// The files a Worker's own transcripts show it writing: Write/Edit paths and the targets of its shell writes.
// Others (the Lead folding in a change request) edit the same folder, and their files are not this Worker's violations.
export function touchedBy(project, files) {
  const roots = [...new Set([project, realpathSync(project)])], paths = new Set();
  const claim = (p) => { for (const r of roots) paths.add(relative(r, resolve(r, p))); };
  for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
    const d = line && json(line);
    if (d?.type !== 'assistant') continue;
    for (const b of [].concat(d.message?.content || [])) {
      if (b?.type !== 'tool_use') continue;
      const p = b.input?.file_path || b.input?.notebook_path;
      if (p) claim(p);
      if (typeof b.input?.command === 'string') writeTargets(b.input.command).forEach(claim);
    }
  }
  return (rel) => paths.has(rel) || [...paths].some((p) => p && !p.startsWith('..') && rel.startsWith(p + '/')); // a directory it moved or removed
}

// Files that changed since `before`, minus those that belong to this ticket or to another ticket of the batch (they share the folder),
// and, when `mine` is given, minus those this Worker never wrote.
export function violations(project, before, row, allRows, gateDir, mine) {
  const changed = changedSince(project, before);
  const gateRel = gateDir && !relative(project, gateDir).startsWith('..') ? relative(project, gateDir) + '/' : '';
  const others = before.base ? [] : allRows.filter((r) => r !== row).flatMap((r) => r.writes); // no other row writes in an isolated worktree
  const bad = [];
  for (const f of changed) {
    if (mine && !mine(f)) continue;
    if (f === REVIEW && row.role === 'reviewer') continue;
    // Any review=yes row's Reviewer files: parallel reviews write them while other tickets build (bench8).
    if (allRows.some((r) => r.review && (f === reviewFileOf(r.ticket) || matches([reviewTestsOf(r.ticket)], f)))) continue;
    if (isProtected(f, gateRel)) bad.push(`${f} (protected)`);
    else if (!matches(row.writes, f) && !matches(others, f)) bad.push(`${f} (outside writes)`);
  }
  return bad;
}

// ---------- the batch ----------
// Two glob lists that could name the same file. shortcut: compares literal prefixes before the first wildcard, so
// `src/*.js` and `src/a*` count as overlapping; precise enough to keep a new row off a running row's files.
const overlaps = (a, b) => a.some((p) => b.some((q) => {
  const base = (g) => g.replace(/^\.\//, '').split(/[*?[]/)[0];
  return p === q || globToRe(p).test(q) || globToRe(q).test(p) || (/[*?]/.test(p + q) && (base(p).startsWith(base(q)) || base(q).startsWith(base(p))));
}));
// `batch.mjs add`: one more row for a lane, appended atomically; the running lane picks it up on its next poll.
async function addTo(project, lane, ticket, { role, writes, brief, deps, review, isolate }) {
  const dir = join(project, '.tsf/batches'), tsv = join(dir, `${lane}.tsv`);
  const no = (why) => { throw Object.assign(new Error(why), { refused: true }); };
  if (!lane || !ticket || !writes || !brief) { console.error("usage: batch.mjs add <lane> <ticket> --role <tier> --writes '<globs>' --brief <path> [--deps T-x,..] [--review no|light|full] [--isolate] [--project dir]"); process.exit(2); }
  if (!existsSync(tsv)) no(`no lane ${lane} (${tsv})`);
  if (!/^[A-Za-z0-9][\w.-]*$/.test(ticket)) no(`bad ticket id ${ticket}`);
  role ||= 'worker';
  if (role === 'builder' || ![...STATIONS, ...CREW].some((x) => x.id === role)) no(`role ${role} is not a Worker tier (a lane has one builder row, its factory's own)`);
  if (review && !/^(no|light|full|full-codex|yes)$/i.test(review)) no(`review ${review}: use no, light, full or full-codex`);
  const list = writes.split(',').map((x) => x.trim()).filter(Boolean);
  const lock = `${tsv}.lock`;
  for (let i = 0; ; i++) { try { closeSync(openSync(lock, 'wx')); break; } catch { if (i > 100) no(`${lock} is held; remove it if no add is running`); await sleep(50); } }
  try {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.tsv'))) {
      const other = parseTsv(readFileSync(join(dir, f), 'utf8')).find((r) => r.ticket === ticket);
      if (other) no(`${ticket} already exists in lane ${basename(f, '.tsv')}`);
    }
    const st = json(existsSync(join(dir, `${lane}.live.json`)) ? readFileSync(join(dir, `${lane}.live.json`), 'utf8') : '') || { rows: [] };
    const rows = parseTsv(readFileSync(tsv, 'utf8'));
    for (const r of rows) {
      const lv = st.rows?.find((x) => x.ticket === r.ticket);
      // a row that waits on the running one never edits at the same time
      if (lv?.started && !lv.ended && !(deps || '').split(',').includes(r.ticket) && overlaps(list, r.writes)) no(`writes ${list.join(', ')} overlap running ${r.ticket} (${r.writes.join(', ')}); build that part yourself or give it other files`);
    }
    const text = readFileSync(tsv, 'utf8');
    const line = [ticket, deps || '-', role, list.join(','), 'no', brief, review || 'no', 'no', isolate ? 'yes' : 'no'].join('\t');
    writeFileSync(`${tsv}.tmp`, `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`);
    renameSync(`${tsv}.tmp`, tsv);
  } finally { rmSync(lock, { force: true }); }
  const pid = existsSync(join(dir, `${lane}.pid`)) ? +readFileSync(join(dir, `${lane}.pid`), 'utf8') : 0;
  console.log(pid && alive(pid) ? `${lane} ${ticket}: added; the lane starts it once its deps are done and capacity allows` : `${lane} ${ticket}: added, but lane ${lane} is not running: start it to build the row`);
}

// The final whole-suite run, once after the last lane merges: a failure names the lanes whose rows write the failing files.
async function verify(project) {
  const knobs = { ...HARNESS, ...readSettings(project) }, cmd = knobs.suite || knobs.test;
  if (!cmd) { console.error('batch verify: no test command; set "suite" (or "test") in .tsf/settings.json'); process.exit(2); }
  const r = await run('sh', ['-c', cmd], { cwd: project, timeout: 1800000 });
  const out = `${r.out}${r.err}`, file = join(project, '.tsf/verify.txt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `$ ${cmd}\nexit ${r.code}${r.timedOut ? ' (timed out)' : ''}\n\n${out}`);
  if (r.code === 0) { console.log(`PASS: ${cmd}`); return; }
  // Files named on failing lines, relative to the project, that exist there.
  const files = new Set();
  for (const line of out.split('\n').filter((l) => /fail|error|✖|not ok/i.test(l)))
    for (const m of line.matchAll(/[\w@.\/-]*[\w-]\.[A-Za-z]{1,5}\b/g)) {
      const f = relative(project, resolve(project, m[0].replace(/^file:\/\//, '')));
      if (f && !f.startsWith('..') && existsSync(join(project, f)) && statSync(join(project, f)).isFile()) files.add(f);
    }
  const dir = join(project, '.tsf/batches'), owners = new Map();
  const lanes = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.tsv'))
    .map((f) => [basename(f, '.tsv'), (() => { try { return parseTsv(readFileSync(join(dir, f), 'utf8')); } catch { return []; } })()]);
  for (const f of files) {
    const lane = lanes.find(([, rs]) => rs.some((x) => matches([...x.writes, reviewTestsOf(x.ticket)], f)))?.[0] ?? 'unowned';
    owners.set(lane, [...(owners.get(lane) || []), f]);
  }
  console.log(`FAIL (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${cmd}`);
  for (const [lane, fs] of owners) console.log(`${lane === 'unowned' ? 'unowned' : `lane ${lane}`}: ${fs.join(', ')}`);
  if (!owners.size) console.log('unowned: no failing file named in the output');
  console.log(`Output: ${file}\n${out.trim().slice(-1500)}`);
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv.splice(i, 2)[1]; };
  const project = resolve(opt('--project') || process.cwd());
  let starter = opt('--starter');
  const shared = argv.includes('--shared');
  if (shared) argv.splice(argv.indexOf('--shared'), 1);
  // `batch.mjs decide <lane> <ticket> retry "<guidance>" [--role <tier>] | allow | drop --project <dir>`: the Lead's answer to a held ticket.
  // --role: retry on another tier (e.g. worker-strong) in a fresh session from a handoff note.
  const role = opt('--role');
  if (argv[0] === 'decide') {
    const [, lane, ticket, act, ...note] = argv;
    if (!lane || !ticket || !['retry', 'allow', 'drop'].includes(act) || (role && ![...STATIONS, ...CREW].some((x) => x.id === role))) { console.error('usage: batch.mjs decide <lane> <ticket> retry "<guidance>" [--role <tier>]|allow|drop [--project dir]'); process.exit(2); }
    mkdirSync(join(project, '.tsf/batches/decisions'), { recursive: true });
    writeFileSync(decisionFile(project, lane, ticket), JSON.stringify({ act, note: note.join(' '), ...(role ? { role } : {}) }));
    console.log(`${lane} ${ticket}: ${act}`);
    return;
  }
  if (argv[0] === 'verify') return verify(project);
  if (argv[0] === 'ready') {
    const [, lane, ticket] = argv;
    if (!lane || !ticket) { console.error('usage: batch.mjs ready <lane> <ticket> [--project dir]'); process.exit(2); }
    mkdirSync(join(project, '.tsf/batches/decisions'), { recursive: true });
    writeFileSync(`${decisionFile(project, lane, ticket)}.ready`, String(Date.now()));
    console.log(`${lane} ${ticket}: ready, the lane checks it now`);
    return;
  }
  const isolate = argv.includes('--isolate');
  if (isolate) argv.splice(argv.indexOf('--isolate'), 1);
  if (argv[0] === 'add') return addTo(project, argv[1], argv[2], { role: opt('--role') ?? role, writes: opt('--writes'), brief: opt('--brief'), deps: opt('--deps'), review: opt('--review'), isolate })
    .catch((e) => { if (!e.refused) throw e; console.error(`batch add: ${e.message}`); process.exitCode = 1; });
  const id = argv[0];
  if (!id) { console.error('usage: batch.mjs <batch-id> [--project dir] [--starter terminal]'); process.exit(2); }

  const batchDir = join(project, '.tsf/batches');
  const settings = readSettings(project);
  const knobs = { ...HARNESS, ...settings };
  // The floater: a lane with no rows of its own whose one spare Worker steals ready rows from any live lane.
  const floater = id === 'floater';
  if (floater && !knobs.floater) { console.error('batch: the floater is off; set "floater": true in .tsf/settings.json'); process.exit(2); }
  if (floater) knobs.workers = 1;
  const rows = floater ? [] : parseTsv(readFileSync(join(batchDir, `${id}.tsv`), 'utf8'));
  const HOLD_MS = process.env.BATCH_HOLD_MS !== undefined ? +process.env.BATCH_HOLD_MS : knobs.holdMinutes * 60000;
  // One controller per lane: a second run would kill the first one's Workers and race it for the same rows.
  const pidFile = join(batchDir, `${id}.pid`);
  const other = existsSync(pidFile) ? +readFileSync(pidFile, 'utf8') : 0;
  if (other && other !== process.pid && alive(other)) { console.error(`batch: lane ${id} is already running (pid ${other})`); process.exit(1); }
  writeFileSync(pidFile, String(process.pid));
  process.on('exit', () => { try { if (+readFileSync(pidFile, 'utf8') === process.pid) rmSync(pidFile); } catch {} });
  // Other lanes' rows (sibling .tsv files): in a shared folder their Workers write at the same time, so their files are not this ticket's violations.
  const siblings = () => readdirSync(batchDir).filter((f) => f.endsWith('.tsv') && f !== `${id}.tsv`)
    .map((f) => { try { return [basename(f, '.tsv'), parseTsv(readFileSync(join(batchDir, f), 'utf8'))]; } catch { return [basename(f, '.tsv'), []]; } });
  const lanes = () => [...rows, ...siblings().flatMap(([, rs]) => rs)];
  const laneOf = (t) => siblings().find(([, rs]) => rs.some((r) => r.ticket === t))?.[0];
  const runStart = Date.now();
  if (!starter && process.env.HC_TERMINAL_ID) starter = json((await hc('get', process.env.HC_TERMINAL_ID, '--json')).out)?.parent;
  // The board and the gate tests are keyed by the Herdr space id, which the team's terminals carry as a label.
  let board = settings.board;
  // A background session (a factory) has no space label: walk up its parents to the tab that has one (bench9).
  for (let t of [starter, process.env.HC_TERMINAL_ID]) for (let hop = 0; !board && t && hop < 5; hop++) { const g = json((await hc('get', t, '--json')).out); board = g?.labels?.['herdr.space']; t = g?.parent; }
  if (!board) { console.error('batch: no board id. Run from a Herdr session, pass --starter, or set "board" in .tsf/settings.json'); process.exit(2); }
  const gateDir = GATES;
  // Hidden tests may sit under the board key or the project's path (gate.sh's usage once said <project>): use whichever has them.
  const gateKeyOf = (t) => [board, project, realpathSync(project)].find((k) => existsSync(join(GATES, safe(k), safe(t)))) ?? board;
  // Holds and alerts go to the Lead: the factory's parent, or the starter itself when no factory sits between.
  const sg = starter && json((await hc('get', starter, '--json')).out);
  const lead = sg?.template === 'factory' && sg.parent ? sg.parent : null;
  const boss = lead || starter;
  if (starter) KEEP.add(starter);

  // ----- the lane's own worktree and branch, so lanes never see each other's half-done files -----
  const git = (args, cwd) => run('git', ['-C', cwd, ...args]);
  // Installed dependencies (and files such as .env listed in link) are symlinked from the project, never rebuilt per worktree; info/exclude hides them.
  const linkInto = (dir) => { for (const d of linked) if (!existsSync(join(dir, d))) symlinkSync(join(project, d), join(dir, d)); };
  const top = (await git(['rev-parse', '--show-toplevel'], project)).out.trim();
  // shortcut: a project below its repo's top level builds shared; give it its own repo or --shared to say so.
  const useTree = !shared && !!top && realpathSync(top) === realpathSync(project);
  const branch = `lane/${id}`;
  let work = project, trunk = null, graphOn = false, linked = [];
  if (useTree) {
    trunk = (await git(['symbolic-ref', '--short', 'HEAD'], project)).out.trim() || (await git(['rev-parse', 'HEAD'], project)).out.trim();
    // Inside the project, so Claude's folder trust (keyed by the repo's main folder) and the person's paths carry over; not under .git,
    // which Claude Code treats as a protected folder for edits. Test runners skip dot folders.
    work = join(project, '.tsf/lanes', id);
    if (!existsSync(join(work, '.git'))) {
      const has = (await git(['rev-parse', '--verify', '--quiet', branch], project)).code === 0;
      const r = await git(['worktree', 'add', ...(has ? [work, branch] : ['-b', branch, work, 'HEAD'])], project);
      if (r.code) { console.error(`batch: git worktree add ${work} failed: ${r.err.trim()}`); process.exit(2); }
    }
    const exclude = resolve(project, (await git(['rev-parse', '--git-path', 'info/exclude'], project)).out.trim());
    linked = knobs.link.filter((d) => existsSync(join(project, d)));
    linkInto(work);
    const have = existsSync(exclude) ? readFileSync(exclude, 'utf8').split('\n') : [];
    // A code graph (graphify, local and LLM-free) for file:line pointers: 'on', 'off', or 'auto' = on for over ~100 KB of tracked files.
    if (knobs.graph !== 'off' && (await run('sh', ['-c', 'command -v graphify'])).code === 0) {
      const size = () => (spawnSync('git', ['-C', work, 'ls-files', '-z'], { encoding: 'utf8' }).stdout || '').split('\0').filter(Boolean)
        .reduce((n, f) => { try { return n + statSync(join(work, f)).size; } catch { return n; } }, 0);
      graphOn = knobs.graph === 'on' || (knobs.graph === 'auto' && size() > 100000);
    }
    const want = ['/.tsf/lanes/', ...linked.map((d) => `/${d}`), ...(graphOn ? ['/graphify-out/'] : [])].filter((l) => !have.includes(l));
    if (want.length) { mkdirSync(dirname(exclude), { recursive: true }); appendFileSync(exclude, want.join('\n') + '\n'); }
  }
  // The graph is rebuilt at lane start and after each ticket commit, one run at a time, off the critical path. Never `graphify install` or hooks.
  let graphQ = Promise.resolve();
  const graphUpdate = () => { if (graphOn) graphQ = graphQ.then(() => run('sh', ['-c', 'graphify update .'], { cwd: work, timeout: 300000, env: { GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1' } })); };
  graphUpdate();
  const graphHint = graphOn ? 'Before reading code, use `graphify explain <symbol>` or `graphify query --context call "<question>"` for file:line pointers; never plain `graphify query`. ' : '';
  // One git command sequence at a time in the worktree: commits and merges share its index.
  let gitQ = Promise.resolve();
  const locked = (fn) => (gitQ = gitQ.then(fn, fn));
  const testRun = (cwd = work) => run('sh', ['-c', knobs.test], { cwd, timeout: 400000 }); // the project's own targeted test command, any language
  const tail = (r) => `${r.out}${r.err}`.trim().slice(-3000);

  const ticketSh = (...a) => run('sh', [TICKET_SH, board, ...a]);
  const stages = async () => {
    const m = new Map();
    for (const l of (await ticketSh('ls')).out.split('\n')) { const [t, stage, owner] = l.split('\t'); if (t) m.set(t, { stage, owner }); }
    return m;
  };
  let stopping = false; // once the lane is stopped, only its own move back to todo reaches the board
  const move = (t, stage, owner) => stopping && stage !== 'todo' ? null : ticketSh('move', t, stage, ...(owner ? [owner] : []));

  // Chain rule: a ticket whose only dependency is X, on X's seat and X's files, takes X's warm Worker, which has already read that code.
  const heir = new Map(), warm = new Map(); // ticket -> its heir's ticket; heir's ticket -> { addr, marker, from }
  for (const x of rows) {
    const next = rows.filter((y) => y.deps.length === 1 && y.deps[0] === x.ticket && y.role === x.role && x.role !== 'builder' && !x.isolate && !y.isolate && y.writes.some((p) => x.writes.includes(p)));
    if (next.length === 1) heir.set(x.ticket, next[0].ticket);
  }
  const result = new Map(); // ticket -> { state: 'done'|'blocked', reason }
  const running = new Map(); // ticket -> promise
  // Each row is a ticket on the board from the start, titled from its brief's first heading, so the person sees the whole batch.
  const seatOf = (role) => [...STATIONS, ...CREW].find((s) => s.id === role);
  const state = { batch: id, pid: process.pid, branch: useTree ? branch : null, started: runStart, updated: runStart, ended: null, stage: 'running', rows: [] };
  const liveFile = join(batchDir, `${id}.live.json`);
  const firstRun = !existsSync(liveFile);
  const live = (ticket, patch) => {
    Object.assign(state.rows.find((x) => x.ticket === ticket) ?? {}, patch);
    state.updated = Date.now();
    try { mkdirSync(batchDir, { recursive: true }); writeFileSync(liveFile + '.tmp', JSON.stringify(state)); renameSync(liveFile + '.tmp', liveFile); } catch {}
  };
  setInterval(() => live(null, {}), 10000).unref(); // heartbeat: the Ops panel shows a lane whose file stops updating as dead
  // Who hears what, each from the one session that can act on it:
  //   Worker done           -> `batch.mjs ready` (the lane reads the file), never a message.
  //   Worker question       -> hc send to its starter (the factory), which answers or forwards product and cross-lane ones to the Lead.
  //   lane -> factory       -> each row done, held or blocked, at once, one line each (toFactory).
  //   lane -> Lead, at once -> holds, blocks, stalls, idle-no-ready alerts, merge conflicts, decision acks and the end (ready to merge) (alert).
  //   lane -> Lead, digest  -> routine progress (rows started and done, review verdicts, polish), at most one message per digest window (event).
  //   Lead -> lane          -> `batch.mjs decide`; the lane acks it in one line once applied.
  //   A send that fails twice is appended to .tsf/batches/<lane>.events.log and named in the next digest.
  const DIGEST_MS = process.env.BATCH_DIGEST_MS !== undefined ? +process.env.BATCH_DIGEST_MS : knobs.digestSeconds * 1000;
  let events = [], lastDigest = runStart;
  const flush = async () => {
    if (!events.length || !boss) return;
    lastDigest = Date.now();
    const e = events; events = [];
    await hc('send', boss, `Lane ${id}: ${e.join('; ')}`);
  };
  const toFactory = async (line) => { if (lead) await hc('send', starter, `Lane ${id} rows: ${line}`); };
  const event = async (line, factoryToo = false) => { events.push(line); if (factoryToo) await toFactory(line); if (Date.now() - lastDigest >= DIGEST_MS) await flush(); };
  const alert = async (line) => { if (boss) await hc('send', boss, `Lane ${id}: ${line}`); await toFactory(line); };
  const eventsLog = join(batchDir, `${id}.events.log`);
  lost = (to, text, r) => {
    try { appendFileSync(eventsLog, `${new Date().toISOString()} undelivered to ${to}: ${String(text).replace(/\n/g, ' ')} (${`${r.out}${r.err}`.trim().split('\n')[0]})\n`); } catch {}
    events.push(`undelivered to ${to}: ${String(text).split('\n')[0].slice(0, 100)} (see ${eventsLog})`);
  };
  const briefOf = (r) => isAbsolute(r.brief) && existsSync(r.brief) ? r.brief : join(project, r.brief); // absolute: a Worker in a worktree reads the project's brief
  const headingOf = (r) => { try { return readFileSync(briefOf(r), 'utf8').match(/^#+\s*(.+)$/m)?.[1] ?? ''; } catch { return ''; } };
  const milestoneOf = (r) => (/\bM\d+\b/.exec(headingOf(r))?.[0] ?? /\/(m\d+)\//i.exec(r.brief)?.[1]?.toUpperCase()) || null;
  const addRow = (r, note = '') => {
    const heading = headingOf(r), title = heading.replace(r.ticket, '').replace(/^[\s:·-]+/, '').trim() || r.ticket;
    state.rows.push({ ticket: r.ticket, title: title.replace(/\s*\([^)]*\)\s*$/, ''), role: r.role, model: seatOf(r.role)?.caption ?? seatOf(r.role)?.model ?? null, milestone: milestoneOf(r), deps: r.deps,
      stage: 'waiting', round: 0, worker: null, reviewer: null, started: null, ended: null, usd: 0, note });
    return title;
  };
  for (const r of rows) await ticketSh('open', r.ticket, r.role, addRow(r));
  live(null, {});
  const board0 = await stages();
  const todo = [];
  for (const r of rows) {
    const b = board0.get(r.ticket);
    if (b?.stage === 'done') { result.set(r.ticket, { state: 'done', reason: 'already done' }); live(r.ticket, { stage: 'done', note: 'already done' }); }
    else if (b?.stage === 'blocked') { result.set(r.ticket, { state: 'blocked', reason: 'blocked on the board before this run' }); live(r.ticket, { stage: 'blocked', note: 'blocked before this run' }); }
    else todo.push(r); // todo, review, or doing: a doing ticket whose Worker is gone is restarted; a live one is killed and restarted too, its state being unknown
  }
  // The board is keyed by space, so a new plan that reuses an old id would be skipped without a word: say so on a lane's first run.
  const skipped = rows.filter((r) => result.get(r.ticket)?.reason === 'already done').map((r) => r.ticket);
  if (firstRun && skipped.length && boss) await hc('send', boss, `Lane ${id}: ${skipped.join(', ')} already done on the board, so skipped. If they are new tickets that reuse old ids, rename them in the tsv, or reopen with ticket.sh move <id> todo --force, and rerun the lane.`);
  // Claims: whoever starts a row (its own lane, or a lane that steals it) first creates .tsf/batches/claims/<ticket>, atomically.
  const claimsDir = join(batchDir, 'claims');
  const claimOf = (t) => { try { return json(readFileSync(join(claimsDir, safe(t)), 'utf8')); } catch { return null; } };
  const claimedElsewhere = (t) => { const c = claimOf(t); return c && c.lane !== id && alive(c.pid) ? c.lane : null; };
  const claim = (t) => {
    mkdirSync(claimsDir, { recursive: true });
    const body = JSON.stringify({ lane: id, pid: process.pid });
    try { writeFileSync(join(claimsDir, safe(t)), body, { flag: 'wx' }); return true; } catch {}
    if (claimedElsewhere(t)) return false;
    writeFileSync(join(claimsDir, safe(t)), body); // ours from an earlier run, or a dead lane's: take it over
    return true;
  };
  for (const r of todo) {
    const b = board0.get(r.ticket);
    if (b?.stage === 'doing' && b.owner && !claimedElsewhere(r.ticket)) { // another live lane took it: leave its Worker alone
      const g = json((await hc('get', b.owner, '--json')).out);
      if (g?.state === 'live') await hc('kill', b.owner);
    }
  }

  // ----- sessions: names carry this run's pid, so a rerun never reuses (or kills) an earlier run's live session -----
  let launches = 0;
  // Start a session; a first message that never landed is retried once (never answering a dialog).
  const launch = async (role, text, base, cwd = work) => {
    let why = '';
    for (let i = 0; i < 2; i++) {
      const tag = `-${process.pid % 1000}-${launches++}`;
      const name = (base.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32 - tag.length) + tag);
      const r = await run(HC, ['run', '--bg', '--json', '--name', name, '--cwd', cwd, '--no-notify', seatOf(role)?.template ?? role, text], { timeout: FIRST_MS });
      const o = json(r.out) || {};
      const fm = o.first_message ?? o.terminal?.first_message;
      if (!r.timedOut && r.code === 0 && fm?.sent !== false) return { addr: o.address || name };
      why = r.timedOut ? `no answer from hc within ${FIRST_MS / 1000}s` : fm?.reason || r.err.trim() || `hc run exited ${r.code}`;
      await hc('kill', name); // a dead launch has no address worth keeping
    }
    return { why };
  };
  const waitArgs = (addr) => ['wait', addr, '--json', '--timeout', String(Math.max(1, Math.round(POLL_MS / 1000)))];
  const isIdle = (w) => !w || (w.reason !== 'timeout' && w.reason !== 'message');
  const settle = async (addr, minutes = budgetFor(settings, 'worker').minutes) => {
    for (const end = Date.now() + minutes * 60000; Date.now() < end; ) if (isIdle(json((await run(HC, waitArgs(addr))).out))) return;
  };
  // A session whose last act was an hc send is waiting for an answer (a Worker asking its factory), so it is not finished yet.
  const asking = (files) => {
    const newest = files.map((f) => [statSync(f).mtimeMs, f]).sort((a, b) => b[0] - a[0])[0]?.[1];
    if (!newest) return false;
    const uses = readFileSync(newest, 'utf8').split('\n').filter(Boolean).map(json).filter((d) => d?.type === 'assistant')
      .flatMap((d) => [].concat(d.message?.content || []).filter((b) => b?.type === 'tool_use'));
    return /(^|[;&|]\s*)hc\s+send\b/.test(uses.at(-1)?.input?.command ?? '');
  };
  const ask = starter ? `If a line of your brief or spec is vague or contradictory, or you are stuck, hc send ${starter} one line and wait for its answer; never encode a guess in code or tests. Otherwise do not message anyone.` : 'Do not hc send anyone.';
  // A Test writer whose last act was an hc send is waiting for an answer, so its missing gate tests are not missing yet.
  const testerAsking = (ticket) => [...new Set([project, work])].some((dir) => {
    const d = join(claudeRoot(), realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'));
    let fs = [];
    try { fs = readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => join(d, f)).filter((f) => statSync(f).mtimeMs > Date.now() - 3600000); } catch {}
    return fs.some((f) => { const t = readFileSync(f, 'utf8'); return t.includes('--path') && t.includes(ticket) && asking([f]); });
  });
  const titleOf = (t) => state.rows.find((x) => x.ticket === t)?.title ?? t;

  // ----- git in the lane's worktree -----
  // A finished ticket's own files become one commit on the lane branch: in its writes, and written by its own sessions
  // (`by`, from their transcripts), so a parallel row's half-done files in an overlapping area never ride along.
  const commit = (row, before, by) => locked(async () => {
    // Authorship (from transcripts, which miss subagent and some shell writes) only decides files another running row may also write.
    const shared = (f) => [...running.keys()].some((t) => t !== row.ticket && matches(rows.find((x) => x.ticket === t)?.writes ?? [], f));
    const files = changedSince(work, before).filter((f) => !f.startsWith('.tsf/') && matches([...row.writes, reviewTestsOf(row.ticket)], f) && (!by || by(f) || !shared(f)));
    if (!files.length) return '';
    const a = await git(['add', '-A', '--', ...files], work);
    const c = a.code ? a : await git(['commit', '-q', '-m', `${row.ticket}: ${titleOf(row.ticket)}`, '--', ...files], work);
    return c.code ? tail(c).split('\n')[0] : '';
  });
  // Merge `ref` into the lane. A conflict goes to a Worker in the worktree, then the tests rerun. Returns '' when merged, else why not.
  const CONFLICT = /^(<{7}|>{7})( |$)/m;
  const mergeIn = (ref, label) => locked(async () => {
    const m = await git(['merge', '--no-edit', ref], work);
    if (m.code === 0) return '';
    const files = (await git(['diff', '--name-only', '--diff-filter=U'], work)).out.split('\n').filter(Boolean);
    if (!files.length) { await git(['merge', '--abort'], work); return `git merge ${ref} failed: ${tail(m).split('\n')[0]}`; }
    await alert(`merge conflict merging ${ref} into ${branch} (${files.join(', ')}); a resolver Worker is on it`);
    const r = await launch('worker', `[batch ${id} ${label}.merge] Resolve the merge conflict from merging ${ref} into this lane (branch ${branch}). Conflicted files: ${files.join(', ')}. ` +
      `Keep the intent of both sides, remove every conflict marker, and run the targeted tests${knobs.test ? ` (${knobs.test})` : ''}. Edit only those files; do not commit or abort the merge. ${ask} Then stop.`, `m-${label}`);
    if (r.addr) { await settle(r.addr); await hc('kill', r.addr); }
    const left = files.filter((f) => { try { return CONFLICT.test(readFileSync(join(work, f), 'utf8')); } catch { return false; } });
    if (!r.addr || left.length) { await git(['merge', '--abort'], work); return `merge conflict with ${ref} not resolved${r.addr ? ` in ${left.join(', ')}` : `: ${r.why}`}`; }
    await git(['add', '-A', '--', ...files], work);
    const c = await git(['commit', '--no-edit', '-q'], work);
    if (c.code) { await git(['merge', '--abort'], work); return `merge commit failed: ${tail(c).split('\n')[0]}`; }
    if (knobs.test) { const t = await testRun(); if (t.code) return `tests fail after merging ${ref} (${knobs.test}, exit ${t.code}): ${tail(t).split('\n').at(-1)}`; }
    return '';
  });
  // Another lane's ticket: its branch while it exists, else the trunk it was merged into.
  // ----- isolated rows: a worktree per row, from the lane HEAD -----
  const treeOf = (t) => join(project, '.tsf/lanes', `${id}.t`, safe(t)), branchOf = (t) => `ticket/${id}/${safe(t)}`;
  const trees = new Set(); // tickets whose worktree is live
  const openTree = (t) => locked(async () => {
    const dir = treeOf(t), b = branchOf(t);
    const has = (await git(['rev-parse', '--verify', '--quiet', b], work)).code === 0; // parked by a stop or block: go on from its work
    const r = await git(['worktree', 'add', ...(has ? [dir, b] : ['-b', b, dir, branch])], work);
    if (r.code) return { why: `git worktree add ${dir} failed: ${tail(r).split('\n')[0]}` };
    linkInto(dir);
    trees.add(t);
    return { dir, base: (await git(['merge-base', 'HEAD', branch], dir)).out.trim() };
  });
  // Park a worktree: its unfinished work becomes a commit on its branch, so removing the folder loses nothing.
  const shelve = (t) => locked(async () => {
    const dir = treeOf(t);
    trees.delete(t);
    if (existsSync(join(dir, '.git'))) {
      await git(['add', '-A', '--', '.', ':(exclude).tsf'], dir);
      if ((await git(['diff', '--cached', '--quiet'], dir)).code) await git(['commit', '-q', '-m', `${t}: unfinished, parked`], dir);
      await git(['worktree', 'remove', '--force', dir], work);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  // Merged: the folder goes, and the branch too (-d keeps one that never merged).
  const dropTree = (t) => locked(async () => { trees.delete(t); await git(['worktree', 'remove', '--force', treeOf(t)], work); await git(['branch', '-d', branchOf(t)], work); });
  if (useTree) { // a killed run's isolated worktrees: park them, keeping their branches
    const stale = join(project, '.tsf/lanes', `${id}.t`);
    for (const t of existsSync(stale) ? readdirSync(stale) : []) await shelve(t);
    await git(['worktree', 'prune'], project);
  }
  const refOf = async (d) => { const c = claimOf(d), l = c && c.lane !== id ? c.lane : laneOf(d); return l && (await git(['rev-parse', '--verify', '--quiet', `lane/${l}`], work)).code === 0 ? `lane/${l}` : trunk; };

  // A dependency outside this batch (another factory's lane) counts once the shared board shows it done.
  const own = new Set(rows.map((r) => r.ticket));
  // Many cross-lane dependencies make a lane wait serially behind the others: usually the row could build against the contract instead.
  const wide = rows.filter((r) => r.deps.filter((d) => !own.has(d)).length > 2).map((r) => r.ticket);
  if (firstRun && wide.length && boss) await event(`${wide.join(', ')} wait on more than 2 other lanes' tickets; if the contract fixes their shape, drop those deps so they start now`);
  let seen = board0;
  const depDone = (d) => (own.has(d) ? result.get(d)?.state === 'done' : seen.get(d)?.stage === 'done');
  const unfinished = () => todo.filter((r) => !result.has(r.ticket));
  // A row whose brief its factory has not written yet waits for it, so a lane starts before every brief exists.
  const briefed = (r) => r.role === 'builder' || !r.brief || existsSync(briefOf(r));
  const ready = () => unfinished().filter((r) => !running.has(r.ticket) && r.deps.every(depDone) && briefed(r));
  const unbriefed = () => unfinished().filter((r) => !running.has(r.ticket) && r.deps.every(depDone) && !briefed(r));
  const briefSince = new Map(); // ticket -> when it first waited for its brief; one alert after BRIEF_MS
  const elsewhere = () => unfinished().some((r) => r.deps.some((d) => !own.has(d) && !['done', 'blocked'].includes(seen.get(d)?.stage)));
  const liveFiles = () => readdirSync(batchDir).filter((f) => f.endsWith('.live.json') && f !== `${id}.live.json`)
    .map((f) => { try { return json(readFileSync(join(batchDir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
  const laneLive = (d) => !d.ended && (d.pid ? alive(d.pid) : Date.now() - d.updated < 300000); // a lane file without a pid predates the heartbeat
  // A dependency in flight elsewhere whose owner is gone (its lane process died, or its Worker did) would be waited on forever: tell the Lead, once.
  const stale = new Set();
  const staleCheck = async () => {
    for (const d of new Set(unfinished().flatMap((r) => r.deps.filter((x) => !own.has(x))))) {
      const b = seen.get(d);
      if (stale.has(d) || !['doing', 'review'].includes(b?.stage)) continue;
      const lane = liveFiles().find((f) => f.rows?.some((r) => r.ticket === d));
      const owned = lane ? laneLive(lane) : b.owner && b.owner !== 'batch' && json((await hc('get', b.owner, '--json')).out)?.state === 'live';
      if (owned) continue;
      stale.add(d);
      const waiting = unfinished().filter((r) => r.deps.includes(d)).map((r) => r.ticket).join(', ');
      if (boss) await hc('send', boss, `Lane ${id} stalled: ${waiting} wait on ${d}, which is ${b.stage} on the board with no live owner${lane ? ` (lane ${lane.batch} is not running)` : ''}. Options: rerun that lane, move ${d} to done if it is finished (or todo), or drop the rows that wait on it.`);
    }
  };

  // Stopped (hc kill of the lane, Ctrl-C): end its sessions, put in-flight rows back to todo, write the summary and tell the Lead.
  let wrapped = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    for (const r of state.rows) if (running.has(r.ticket)) {
      for (const a of [r.worker, r.reviewer, r.polisher]) if (a) await hc('kill', a);
      await ticketSh('move', r.ticket, 'todo', 'batch');
      live(r.ticket, { stage: 'stopped', ended: Date.now(), note: `lane stopped (${sig})` });
    }
    for (const w of warm.values()) await hc('kill', w.addr);
    for (const t of [...trees]) await shelve(t);
    await wrapUp(sig);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => stop(sig));

  // The notes board, capped: Workers append, the lane keeps the newest `notes` lines.
  // shortcut: a line appended between the read and the rename is lost; fine for hints, add a lock if notes ever carry more.
  const notesFile = join(project, NOTES);
  const trimNotes = () => {
    try {
      const ls = readFileSync(notesFile, 'utf8').split('\n').filter(Boolean);
      if (ls.length > knobs.notes) { writeFileSync(`${notesFile}.${process.pid}`, ls.slice(-knobs.notes).join('\n') + '\n'); renameSync(`${notesFile}.${process.pid}`, notesFile); }
    } catch {}
  };
  // Work stealing: with nothing of its own ready, a lane takes a ready, unclaimed row from another live lane in the same milestone
  // (the floater: from any lane), builds it in its own folder, and the owner's dependents merge it from here.
  const stolen = [];
  const myMilestones = new Set(rows.map(milestoneOf));
  const candidates = () => {
    if (!knobs.steal && !floater) return [];
    const up = new Set(liveFiles().filter(laneLive).map((d) => d.batch));
    return siblings().filter(([l]) => up.has(l) && l !== 'floater' && (!knobs.stealLanes?.length || knobs.stealLanes.includes(l))).flatMap(([l, rs]) => rs
      .filter((r) => r.role !== 'builder' && seen.get(r.ticket)?.stage === 'todo' && !claimedElsewhere(r.ticket) && !stolen.some((x) => x.ticket === r.ticket)
        && r.deps.every((d) => seen.get(d)?.stage === 'done') && briefed(r) // never a row its factory has not briefed yet
        && !(r.deps.length === 1 && rs.some((x) => x.ticket === r.deps[0] && x.role === r.role && x.writes.some((p) => r.writes.includes(p)))) // its lane's warm Worker takes it
        && (floater || myMilestones.has(milestoneOf(r))))
      .map((r) => ({ ...r, from: l })));
  };
  const takenBy = (t) => { const c = claimOf(t); return c && c.lane !== id ? c.lane : null; };

  let peak = null; // with elastic off, the lane keeps the number of Workers it started with
  const tsvFile = join(batchDir, `${id}.tsv`);
  const pickUp = async () => { // rows `batch.mjs add` appended since the last poll
    let now = [];
    try { now = parseTsv(readFileSync(tsvFile, 'utf8')).filter((r) => !own.has(r.ticket)); } catch {}
    for (const r of now) {
      rows.push(r); own.add(r.ticket); todo.push(r);
      const x = r.deps.length === 1 && rows.find((y) => y.ticket === r.deps[0]); // a follow-up on a running row's files takes its warm Worker
      if (x && x.role === r.role && x.role !== 'builder' && !x.isolate && !r.isolate && x.writes.some((g) => r.writes.includes(g)) && !heir.has(x.ticket) && !result.has(x.ticket)) heir.set(x.ticket, r.ticket);
      await ticketSh('open', r.ticket, r.role, addRow(r));
      live(null, {});
      await event(`${r.ticket} added`);
    }
  };
  for (;;) {
    if (knobs.notes > 0) trimNotes();
    if (!floater) await pickUp();
    const taken = unfinished().filter((r) => !running.has(r.ticket) && takenBy(r.ticket));
    if (knobs.steal || floater || taken.length || unfinished().some((r) => r.deps.some((d) => !own.has(d)))) { seen = await stages(); await staleCheck(); }
    for (const r of taken) { // another lane built (or blocked) a row of ours
      const b = seen.get(r.ticket)?.stage, by = takenBy(r.ticket);
      if (b === 'done') { result.set(r.ticket, { state: 'done', reason: `done by lane ${by}` }); live(r.ticket, { stage: 'done', note: `done by lane ${by}` }); }
      else if (b === 'blocked') { result.set(r.ticket, { state: 'blocked', reason: `blocked in lane ${by}` }); live(r.ticket, { stage: 'blocked', note: `blocked in lane ${by}` }); }
      else live(r.ticket, { note: `taken by lane ${by}` });
    }
    const batch = ready().filter((r) => !claimedElsewhere(r.ticket));
    const steals = batch.length ? [] : candidates();
    if (batch.length || steals.length) {
      // Lanes running at once (other live lane processes here) split the machine's capacity. Floor: a lane with nothing running still starts one,
      // and when lanes outnumber the free slots each takes fewer rather than all overcommitting. Elastic: more start as capacity frees up.
      const lanesNow = liveFiles().filter(laneLive).length + 1;
      const cap = Math.max(0, parseInt((await run('sh', [CAPACITY_SH])).out, 10) || 0);
      let n = lanesNow > cap ? Math.floor(cap / lanesNow) : Math.ceil(cap / lanesNow);
      // A builder row starts no session (its factory builds it), so it neither waits for a slot nor takes one.
      const busy = [...running.keys()].filter((t) => rows.find((x) => x.ticket === t)?.role !== 'builder').length;
      if (knobs.workers > 0) n = Math.max(0, Math.min(n, knobs.workers - busy));
      if (!knobs.elastic && peak !== null) n = Math.max(0, Math.min(n, peak - busy));
      if (!busy) n = Math.max(1, n);
      // An isolated row beyond the cap waits for a slot; it never builds shared instead.
      let isolated = [...running.keys()].filter((t) => [...rows, ...stolen].find((x) => x.ticket === t)?.isolate).length;
      const all = [...batch, ...steals].filter((r) => !(useTree && r.isolate) || isolated++ < ISOLATE_MAX);
      for (const r of [...all.filter((x) => x.role === 'builder'), ...all.filter((x) => x.role !== 'builder').slice(0, n)]) {
        if (!claim(r.ticket)) continue;
        if (r.from) { stolen.push(r); addRow(r, `taken from lane ${r.from}`); live(null, {}); await event(`${r.ticket} taken from lane ${r.from}`); }
        running.set(r.ticket, runTicket(r).then((res) => { result.set(r.ticket, res); running.delete(r.ticket); }));
      }
      const workers = [...running.keys()].filter((t) => rows.find((x) => x.ticket === t)?.role !== 'builder').length;
      if (peak === null && workers) peak = workers;
    }
    for (const r of unbriefed()) {
      if (!briefSince.has(r.ticket)) briefSince.set(r.ticket, Date.now());
      else if (briefSince.get(r.ticket) > 0 && Date.now() - briefSince.get(r.ticket) > BRIEF_MS) { briefSince.set(r.ticket, -1); await event(`${r.ticket} still waits for its brief ${r.brief}`); }
    }
    if (events.length && Date.now() - lastDigest >= DIGEST_MS) await flush(); // a quiet lane still sends its digest
    if (!running.size && !ready().length && !unbriefed().length && !elsewhere() && !steals.length) break; // what is left waits on a blocked dependency
    await Promise.race([...running.values(), sleep(POLL_MS)]);
  }

  // ----- one ticket, start to finish -----
  async function runTicket(row) {
    const marker = `[batch ${id} ${row.ticket}]`;
    let reviewSeat = row.review === 'light' ? 'reviewer-light' : row.review === 'full-codex' ? 'reviewer-codex' : 'reviewer';
    let budget = budgetFor(settings, row.role), reviewBudget = budgetFor(settings, reviewSeat);
    const light = row.review === 'light', reviewRounds = light ? 1 : knobs.reviewRounds;
    const startedAt = Date.now();
    let before = snapshot(work);
    let dir = work, tree = false; // an isolated row's own worktree, once its dependencies are in the lane
    // A builder row: the factory that started the lane builds it here and runs `ready`; its transcript (named by the lane file) attributes its writes.
    const byFactory = () => row.role === 'builder';
    const readyFile = `${decisionFile(project, id, row.ticket)}.ready`, readyCmd = `node ${HERE_BATCH} ready ${id} ${row.ticket} --project ${project}`;
    // Every message to the building session repeats how it ends: the ready command.
    const tell = (text) => { const t = `${text.replace(/,? then stop[.:]?/, '.')} When done, run: ${readyCmd}`; return hc('send', worker, byFactory() ? `${marker} ${t}` : t); };
    const readyWant = { done: () => existsSync(readyFile), what: 'ready',
      nudge: `If ${row.ticket} is built and its targeted tests pass, run: ${readyCmd}. If you are waiting for an answer, send ${starter ?? 'whoever started you'} one line saying what you wait for.` };
    let decided = null; // a decision the Lead wrote while the lane waited on an idle session; the next hold takes it
    let worker = null, carry = warm.get(row.ticket) ?? null, fresh = !carry; // carry: the warm Worker this ticket inherits
    warm.delete(row.ticket);
    const reviewMark = `[batch ${id} ${row.ticket}.review]`, reviewFile = reviewFileOf(row.ticket);
    // Absolute: a Reviewer may work from the project folder, not the lane's worktree. Read directly: git ls-files skips .tsf/.
    let reviewPath = join(work, reviewFile); const stamp = (f) => { try { const st = statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return undefined; } };
    const reviewAt = `test files named like ${row.ticket.toLowerCase()}.review.test.<ext> in the project's test folder`;
    let reviewer = null, reviewWhy = '', reviewRound = 0;
    const polishMark = `[batch ${id} ${row.ticket}.polish]`;
    let polisher = null, polished = false;
    const clock = { worker: { ms: 0 }, reviewer: { ms: 0 } }; // working time only: idle time, gate runs and reviews never count against a session
    let gateWait = process.env.GATE_WAIT || '100', testerWait = 0;
    let raceSpent = 0, raceFiles = null; // a race row: what both racers spent, and the winner's files
    const block = async (reason, asked = false) => { // asked: the Lead already heard of it through a hold
      for (const a of [worker, reviewer, polisher]) if (a) await hc('kill', a);
      await move(row.ticket, 'blocked', 'batch');
      live(row.ticket, { stage: 'blocked', ended: Date.now(), ...spent(), note: reason.split('\n')[0] });
      if (tree) await shelve(row.ticket); // its work stays on its ticket branch for a rerun
      if (boss && !asked) await hc('send', boss, `Lane ${id} ${row.ticket} blocked: ${reason.split('\n')[0].slice(0, 300)}. Fix its brief, tier or code and have ${lead ? `factory ${starter}` : 'the lane'} rerun, or drop it; the lane keeps running.`);
      await toFactory(`${row.ticket} blocked: ${reason.split('\n')[0].slice(0, 120)}`);
      return { state: 'blocked', reason };
    };
    // Ask the Lead (the only controller of a hold) instead of blocking; no answer within HOLD_MS blocks as before.
    const hold = async (reason) => {
      const ack = async (d) => { live(row.ticket, { stage: 'building', note: `Lead: ${d.act}${d.note ? ' ' + d.note.slice(0, 100) : ''}` }); if (boss) await hc('send', boss, `Lane ${id} ${row.ticket}: ${d.act} applied`); return { ...d, asked: true }; };
      if (decided) { const d = decided; decided = null; return ack(d); }
      if (!boss || HOLD_MS <= 0) return { act: 'drop' };
      const file = decisionFile(project, id, row.ticket);
      rmSync(file, { force: true });
      live(row.ticket, { stage: 'held', ...spent(), note: reason.split('\n')[0] });
      await hc('send', boss, `Lane ${id} ${row.ticket} held: ${reason.split('\n')[0].slice(0, 300)}. ${worker ? `Its Worker ${worker} stays warm. ` : ''}Answer with node ${HERE_BATCH} decide ${id} ${row.ticket} retry "<what to do>" | allow | drop --project ${project}. No answer in ${Math.round(HOLD_MS / 60000)} min drops it.`);
      await toFactory(`${row.ticket} held: ${reason.split('\n')[0].slice(0, 120)}`);
      for (const end = Date.now() + HOLD_MS; Date.now() < end; await sleep(Math.min(5000, POLL_MS))) {
        if (!existsSync(file)) continue;
        const d = json(readFileSync(file, 'utf8')) || { act: 'drop' };
        rmSync(file, { force: true });
        return ack(d);
      }
      return { act: 'drop', asked: true };
    };
    // Hold, then act on the answer: retry continues the loop (true), anything else returns the ticket's result.
    const stuck = async (reason) => {
      const d = await hold(reason);
      if (d.act === 'allow') return finish(`allowed by Lead after: ${reason.split('\n')[0].slice(0, 120)}`);
      if (d.act !== 'retry') return block(reason, d.asked);
      // a fresh allowance on top of what each session spent
      budget = { usd: Math.max(budget.usd, workerUsage().usd) + budget.usd, minutes: clock.worker.ms / 60000 + budget.minutes };
      reviewBudget = { usd: Math.max(reviewBudget.usd, reviewUsage().usd) + reviewBudget.usd, minutes: clock.reviewer.ms / 60000 + reviewBudget.minutes };
      const guide = `The Lead says: ${d.note || 'try again'}. Keep your tests and the gate green, then stop.`;
      if (d.role && d.role !== row.role) { // one tier up (or across): a fresh session on the new seat, from a handoff note
        row.role = d.role;
        if (worker) await hc('kill', worker);
        worker = null; carry = null; fresh = true;
        budget = budgetFor(settings, row.role);
        live(row.ticket, { role: row.role, model: seatOf(row.role)?.caption ?? seatOf(row.role)?.model ?? null });
        const again = await start(task(`${guide} A previous session got stuck: ${reason.split('\n')[0].slice(0, 300)}. Its files are in the folder; check them before rewriting.`));
        if (again !== true) return block(again, true);
        live(row.ticket, { worker });
        return true;
      }
      if (worker && (await tell(guide)).code === 0) return true;
      const again = await start(task(guide));
      if (again !== true) return block(again);
      live(row.ticket, { worker });
      return true;
    };
    const finish = async (reason) => {
      let failed = '';
      if (tree) { // everything changed in its worktree is one commit on its branch, merged into the lane under the lane lock
        const files = changedSince(dir, before).filter((f) => !f.startsWith('.tsf/'));
        const a = files.length ? await git(['add', '-A', '--', ...files], dir) : { code: 0 };
        const c = a.code || !(await git(['diff', '--cached', '--quiet'], dir)).code ? a : await git(['commit', '-q', '-m', `${row.ticket}: ${titleOf(row.ticket)}`], dir);
        if (c.code) failed = tail(c).split('\n')[0];
        else for (let why; (why = await mergeIn(branchOf(row.ticket), row.ticket)); ) {
          const d = await hold(why);
          if (d.act === 'allow') { reason += `; ${branchOf(row.ticket)} left unmerged (Lead allowed)`; break; }
          if (d.act !== 'retry') return block(why, d.asked);
        }
      } else if (useTree) {
        let by = raceFiles && ((f) => raceFiles.includes(f));
        if (!by) { const ts = [workerUsage().files, polishUsage().files, reviewUsage().files].flat(); by = ts.length ? touchedBy(work, ts) : undefined; } // no transcript (Codex): its writes
        failed = await commit(row, before, by);
      }
      if (useTree && !failed) graphUpdate();
      if (failed) reason += `; commit on ${branch} failed: ${failed}`;
      await move(row.ticket, 'done', row.from ? `lane-${id}` : 'batch'); // a stolen row shows who built it
      const next = heir.get(row.ticket);
      if (worker && next) warm.set(next, { addr: worker, marker: fresh ? marker : carry.marker, from: Date.now() }); // the chain's next ticket is sent to it
      else if (worker) await hc('kill', worker); // a session exists only while it has work
      if (reviewer) await hc('kill', reviewer);
      live(row.ticket, { stage: 'done', ended: Date.now(), ...spent(), note: reason }); // last turn's cost lands after the final poll
      if (tree) await dropTree(row.ticket);
      await event(`${row.ticket} done (${reason.slice(0, 120)})`, true);
      return { state: 'done', reason };
    };

    const task = (extra, mk = marker) => `${mk} You are a ${row.role} for ticket ${row.ticket}. Read your brief at ${briefOf(row)}. ` +
      graphHint + (knobs.notes > 0 ? `Before reading code, read ${notesFile} if it exists: one-line facts other Workers found. Append a line there (path:line, fact) only when it saves another Worker a read. ` : '') +
      `Write only files matching: ${row.writes.join(', ') || '(none)'}. Do not touch .tsf/, gate.sh or gate tests. ` +
      (row.role === 'reviewer' ? `Also write every defect you find to ${REVIEW} (file, line, failing case), or "No defects" if none. ` : '') +
      (row.review && !light ? `A Reviewer writes adversarial tests in ${reviewAt} while you build; leave them alone. ` : '') +
      (row.gated ? `Don't run the gate: the batch runs it when you stop and sends you any failures. ` : '') +
      `Run only targeted tests${knobs.test ? ` (this project's command: ${knobs.test})` : ''}. Never move the ticket on the board or commit: the batch does both once you are ready. ` +
      `${ask}${extra ? ' ' + extra : ''} When it is built and its targeted tests pass, run: ${readyCmd}. That command, never a message or stopping, ends the ticket; a question goes to ${starter ?? 'whoever started you'} with hc send.`;

    const start = async (text) => {
      const r = await launch(row.role, text, `b-${row.ticket}`, dir);
      worker = r.addr ?? null;
      return worker ? true : `first message never landed: ${r.why}`;
    };
    const startReviewer = async () => {
      const text = light
        ? `${reviewMark} You review ticket ${row.ticket}; its build is green. Read its brief at ${briefOf(row)}, then the changes to ${row.writes.join(', ')}. ` +
          `Report real defects only (wrong behaviour against the brief, a crash, a broken contract), never style; write no tests. Write every defect to ${reviewPath} (file, line, failing case), or the single line "No defects". ` +
          `Write only ${reviewPath}. Then stop. Do not hc send anyone.`
        : `${reviewMark} You review ticket ${row.ticket}; a Worker is building it now. Read its brief at ${briefOf(row)} and the contract it names. ` +
          `First, while the build runs, write adversarial tests for it from the contract into ${reviewAt} (they may fail until the build lands). ` +
          `Write only those test files now; write ${reviewPath} only when the batch asks for your review (the lane reads it as your verdict). Do not touch any other file, gate.sh or gate tests. Then stop: the batch messages you when the build is ready. Do not hc send anyone.`;
      let r = await launch(reviewSeat, text + (graphHint ? ` ${graphHint.trim()}` : ''), `r-${row.ticket}`, dir);
      if (!r.addr && reviewSeat === 'reviewer-codex') { // codex not installed or not answering: the same review on Opus
        await event(`${row.ticket} codex Reviewer unavailable (${r.why}); Opus reviews instead`);
        reviewSeat = 'reviewer'; reviewBudget = budgetFor(settings, reviewSeat);
        r = await launch(reviewSeat, text, `r-${row.ticket}`, dir);
      }
      reviewer = r.addr ?? null; reviewWhy = r.why ?? '';
      if (reviewer) live(row.ticket, { reviewer });
    };

    const workerUsage = () => {
      if (byFactory()) return ticketUsage(project, `.tsf/batches/${id}.tsv`, runStart, startedAt);
      const c = carry ? ticketUsage(work, carry.marker, runStart, carry.from) : { usd: 0, files: [] }; // an isolated row never takes a warm Worker
      const own = ticketUsage(dir, marker, runStart, 0, c.files);
      return { usd: c.usd + own.usd, files: [...c.files, ...own.files] };
    };
    // No transcript (a Codex Worker): every changed file counts, as before.
    // An isolated row's own worktree holds only its work, so everything changed there is its.
    const mine = () => { const fs = tree ? [] : workerUsage().files; return fs.length ? touchedBy(work, fs) : undefined; };
    const reviewUsage = () => ticketUsage(dir, reviewMark, runStart), polishUsage = () => ticketUsage(dir, polishMark, runStart);
    const cost = () => raceSpent + workerUsage().usd + (row.review ? reviewUsage().usd : 0) + (polished === true ? polishUsage().usd : 0);
    const spent = () => { try { return { usd: cost() }; } catch { return {}; } }; // block() also runs when reading usage threw
    // Wait for a session to finish, enforcing its budget while it works. Finished = idle and `want.done()` (the building session: its
    // ready file; a Reviewer: its verdict file; no want: idle alone). Idle and not done is neither done nor a question: one nudge after
    // NUDGE_MS, then one alert to the Lead after ALERT_MS more, and the wait goes on until it is done or the Lead decides.
    const waitIdle = async (addr = worker, usage = workerUsage, cap = budget, clk = clock.worker, want = addr === worker ? readyWant : null) => {
      if (byFactory() && addr === worker) for (;;) { // the factory says when: its own session is never idle-checked
        if (existsSync(readyFile)) { rmSync(readyFile, { force: true }); return null; }
        const t0 = Date.now();
        await sleep(POLL_MS);
        clk.ms += Date.now() - t0;
        if (clk.ms / 60000 > cap.minutes) return `over time: ${(clk.ms / 60000).toFixed(1)} of ${cap.minutes} minutes with no ready from the factory`;
      }
      let idleAt = 0, nudged = false, told = false;
      for (;;) {
        const t0 = Date.now();
        const w = json((await run(HC, waitArgs(addr))).out);
        const u = usage();
        live(row.ticket, { usd: cost() });
        const idle = isIdle(w);
        if (idle && (!want || want.done())) { if (want === readyWant) rmSync(readyFile, { force: true }); return null; }
        if (idle) {
          idleAt ||= Date.now();
          if (!nudged && Date.now() - idleAt >= NUDGE_MS) { nudged = true; idleAt = Date.now(); await hc('send', addr, want.nudge); }
          else if (nudged && !told && Date.now() - idleAt >= ALERT_MS) {
            told = stall.told = true; // the stall watchdog need not say it again
            await alert(`${row.ticket} idle ${Math.round((NUDGE_MS + Date.now() - idleAt) / 60000)} min with no ${want.what}; last words: ${lastWords(u.files) || '(none)'}. Decide: node ${HERE_BATCH} decide ${id} ${row.ticket} allow|retry "<what to do>"|drop --project ${project}`);
          }
          const file = decisionFile(project, id, row.ticket);
          if (told && existsSync(file)) { decided = json(readFileSync(file, 'utf8')) || { act: 'drop' }; rmSync(file, { force: true }); return `idle with no ${want.what}; the Lead decided ${decided.act}`; }
          await sleep(POLL_MS);
        } else { idleAt = 0; clk.ms += Date.now() - t0; } // working time only
        if (u.usd > cap.usd) return `over budget: $${u.usd.toFixed(2)} of $${cap.usd.toFixed(2)}`;
        if (clk.ms / 60000 > cap.minutes) return `over time: ${(clk.ms / 60000).toFixed(1)} of ${cap.minutes} minutes working`;
      }
    };
    async function raceIt() {
      const racers = [];
      for (const n of [1, 2]) {
        const dir = join(project, '.tsf/lanes', `${id}.race-${safe(row.ticket)}-${n}`);
        await locked(() => git(['worktree', 'add', '--detach', '--force', dir, 'HEAD'], work));
        for (const d of knobs.link) if (existsSync(join(project, d)) && !existsSync(join(dir, d))) symlinkSync(join(project, d), join(dir, d));
        const r = { n, dir, mark: `[batch ${id} ${row.ticket}.race${n}]`, before: snapshot(dir), fails: 0 };
        r.addr = (await launch(row.role, task('', r.mark), `b-${row.ticket}-r${n}`, dir)).addr ?? null;
        racers.push(r);
      }
      const usage = (r) => ticketUsage(r.dir, r.mark, runStart);
      live(row.ticket, { stage: 'building', started: startedAt, worker: racers.map((r) => r.addr).filter(Boolean).join(' '), note: 'race: 2 Workers' });
      await move(row.ticket, 'doing', racers.find((r) => r.addr)?.addr);
      let winner = null;
      for (const end = Date.now() + budget.minutes * 60000; !winner && racers.some((r) => r.addr) && Date.now() < end; ) {
        for (const r of racers.filter((x) => x.addr)) {
          const files = usage(r).files;
          if (!isIdle(json((await run(HC, waitArgs(r.addr))).out)) || asking(files)) continue;
          const bad = violations(r.dir, r.before, row, lanes(), gateDir, files.length ? touchedBy(r.dir, files) : undefined);
          let failure = bad.length ? `Scope check failed: ${bad.join(', ')}. Undo only the changes you made to these files. Write only ${row.writes.join(', ')}.` : '', proven = !row.gated;
          if (!failure && row.gated) {
            const g = await run('sh', [GATE_SH, gateKeyOf(row.ticket), row.ticket, r.dir], { timeout: 400000, env: { GATE_WAIT: gateWait } });
            if (g.code === 3) { gateWait = '1'; proven = true; } // no hidden tests: the tests below decide
            else if (g.code) failure = `Gate failed (exit ${g.code}). Fix only these failures:\n${g.out.trim().slice(-3000)}`;
          }
          if (!failure && proven && knobs.test) { const t = await run('sh', ['-c', knobs.test], { cwd: r.dir, timeout: 400000 }); if (t.code) failure = `Tests failed (${knobs.test}, exit ${t.code}). Fix only these failures:\n${tail(t)}`; }
          if (!failure) { winner = r; break; }
          if (++r.fails > knobs.fixRounds) { await hc('kill', r.addr); r.addr = null; }
          else await hc('send', r.addr, failure);
        }
      }
      raceSpent = racers.reduce((sum, r) => sum + usage(r).usd, 0); // the loser's spend counts too
      for (const r of racers) if (r.addr) await hc('kill', r.addr);
      if (winner) {
        raceFiles = changedSince(winner.dir, winner.before).filter((f) => !f.startsWith('.tsf/'));
        for (const f of raceFiles) {
          const src = join(winner.dir, f), dst = join(work, f);
          if (existsSync(src)) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); } else rmSync(dst, { force: true });
        }
      }
      for (const r of racers) await git(['worktree', 'remove', '--force', r.dir], work);
      if (!winner) { await event(`${row.ticket} race: neither Worker passed; building it in the lane`); return null; }
      return finish(`won the race (Worker ${winner.n} of 2): ${row.gated ? 'gate' : knobs.test ? 'tests' : 'scope'} passed`);
    }
    const gate = () => run('sh', [GATE_SH, gateKeyOf(row.ticket), row.ticket, dir], { timeout: 400000, env: { GATE_WAIT: gateWait } });
    // Stall watchdog: a row whose stage and session transcripts have not moved for STALL_MS is named to the Lead and the factory, once per stall.
    const stall = { sig: '', at: Date.now(), told: false };
    let watching = false;
    const watch = setInterval(async () => {
      const r = state.rows.find((x) => x.ticket === row.ticket);
      if (watching || !r?.started || r.ended || r.stage === 'held') return; // a held row is the Lead's already
      watching = true;
      try {
        const files = [workerUsage(), reviewUsage(), polishUsage()].flatMap((u) => u.files);
        const sig = `${r.stage} ${files.map((f) => { try { return statSync(f).size; } catch { return 0; } }).join(',')}`;
        if (sig !== stall.sig) Object.assign(stall, { sig, at: Date.now(), told: false });
        else if (!stall.told && Date.now() - stall.at >= STALL_MS) {
          stall.told = true;
          const addr = polisher || (/review/.test(r.stage) && reviewer) || worker;
          await alert(`${row.ticket} stalled: stage ${r.stage}, no transcript growth for ${Math.round((Date.now() - stall.at) / 60000)} min; session ${addr ?? '-'}; last words: ${lastWords(files) || '(none)'}. Look: hc read ${addr} --lines 30`);
        }
      } catch {} finally { watching = false; }
    }, POLL_MS);
    watch.unref();

    try {
    // A dependency in another lane: bring its branch (or the trunk, once merged) into this worktree first.
    if (useTree) for (const ref of new Set(await Promise.all(row.deps.filter((d) => !own.has(d) || takenBy(d)).map(refOf)))) {
      for (let why; (why = await mergeIn(ref, row.ticket)); ) {
        const d = await hold(why);
        if (d.act === 'allow') break;
        if (d.act !== 'retry') return block(why, d.asked);
      }
    }
    if (useTree && row.isolate) { // its own worktree from the lane HEAD, now that its dependencies are in the lane
      const t = await openTree(row.ticket);
      if (t.why) return block(t.why);
      dir = t.dir; tree = true; reviewPath = join(dir, reviewFile);
      before = Object.assign(snapshot(dir), { base: t.base });
    }
    // A race row: two Workers build it at once in scratch worktrees; the first to pass scope and gate (or the tests) wins and is copied in.
    // shortcut: review=yes and frontend rows skip the race, since their Reviewer or Polisher works with one Worker in the lane folder.
    if (row.race && useTree && !tree && !row.review && row.role !== 'frontend' && !byFactory()) { const won = await raceIt(); if (won) return won; }
    const begin = async () => {
      rmSync(readyFile, { force: true }); // a stale one (a racer's, an earlier run's) is not this build's
      if (byFactory()) {
        if (!starter) return 'a builder row needs the lane started by its factory (--starter)';
        worker = starter;
        const r = await hc('send', worker, `${marker} Row ${row.ticket} is yours to build in ${dir}: brief ${briefOf(row)}; write only ${row.writes.join(', ')}. ${graphHint}Do not commit or move it. When it is built and its targeted tests pass, run: ${readyCmd}`);
        return r.code === 0 ? true : `could not reach factory ${starter}: ${tail(r)}`;
      }
      if (carry) {
        worker = carry.addr;
        if ((await hc('send', worker, task(`You built ${row.deps[0]} in this session: reuse what you already know and reread only what you need.`))).code === 0) return true;
        await hc('kill', worker); carry = null; fresh = true; // it died: start fresh
      }
      return start(task());
    };
    const [first] = await Promise.all([begin(), row.review && !light && row.role !== 'frontend' ? startReviewer() : null]); // frontend rows get a polish pass instead; a light review starts once green
    if (first !== true) { const r = await stuck(first); if (r !== true) return r; }
    await move(row.ticket, 'doing', worker);
    live(row.ticket, { stage: 'building', worker, started: startedAt });
    await event(`${row.ticket} started (${row.role} ${worker})`);

    // recheck: the checks run again with no new turn from the building session (after a polish pass, or while gate tests wait), so no ready comes.
    for (let failures = 0, challengeable = false, recheck = false; ; ) {
      const over = recheck ? null : await waitIdle();
      recheck = false;
      if (over) {
        // Over its allowance but already passing and in scope: done, not held, since redoing it costs more.
        // Proof is the gate for a gated row, else the project's test command; with neither, the Lead decides.
        let green = !decided && !violations(dir, before, row, lanes(), gateDir, mine()).length; // the Lead's decision wins
        if (green) green = row.gated ? (await run('sh', [GATE_SH, gateKeyOf(row.ticket), row.ticket, dir], { timeout: 400000, env: { GATE_WAIT: '1' } })).code === 0
          : !!knobs.test && (await testRun(dir)).code === 0;
        if (green) { await hc('kill', worker); worker = null; return finish(`${row.gated ? 'gate' : 'tests'} passed (${over})`); }
        const r = await stuck(over);
        if (r === true) { failures = 0; continue; }
        return r;
      }

      const challenge = challengeable && contradiction(workerUsage().files);
      if (challenge) {
        const r = await stuck(`gate test contradicts the spec: ${challenge.test}: ${challenge.reason}`);
        if (r === true) { failures = 0; challengeable = false; continue; }
        return r;
      }

      const bad = violations(dir, before, row, lanes(), gateDir, mine());
      let failure = bad.length ? `Scope check failed: ${bad.join(', ')}. Undo only the changes you made to these files; never delete or revert a file you did not create. Write only ${row.writes.join(', ')}.` : '';
      if (!failure && row.role === 'reviewer' && before.get(REVIEW) === snapshot(dir).get(REVIEW)) failure = `Write your findings to ${REVIEW} (file, line, failing case), or "No defects" if none, then stop.`;
      if (!failure && row.gated) {
        live(row.ticket, { stage: 'gate' });
        const g = await gate();
        if (g.code === 3) { // no hidden tests under any key: never a silent "ungated"
          gateWait = '1'; // the wait is paid once; later passes only look
          if (testerAsking(row.ticket) && (testerWait ||= Date.now()) > Date.now() - budgetFor(settings, 'tester').minutes * 60000) {
            live(row.ticket, { note: 'gate tests wait on a Test writer question' });
            await sleep(POLL_MS);
            recheck = true;
            continue;
          }
          const t = knobs.test ? await testRun(dir) : null;
          if (t?.code) failure = `Tests failed (${knobs.test}, exit ${t.code}). Fix only these failures:\n${tail(t)}`;
          else {
            const r = await stuck(`gate tests missing (none under ${[...new Set([board, project])].join(' or ')})${t ? `; its tests pass (${knobs.test})` : '; no test command in .tsf/settings.json to prove it'}. allow = done ungated, retry = look for the gate tests again`);
            if (r === true) continue;
            return r;
          }
        } else if (g.code !== 0) failure = `Gate failed (exit ${g.code}). Fix only these failures:\n${g.out.trim().slice(-3000)}\nIf a failing test contradicts the spec, change no code and end your turn with one line: CONTRADICTS <test>: <reason>`;
      }
      // Proof for an ungated row: the project's test command, when set and this row is alone in its folder (a sibling's half-done work would fail it).
      const alone = tree || running.size === 1;
      if (!failure && !row.gated && knobs.test && alone) { const t = await testRun(dir); if (t.code) failure = `Tests failed (${knobs.test}, exit ${t.code}). Fix only these failures:\n${tail(t)}`; }
      // A plan's own polish ticket on this page does the pass instead, so it isn't polished twice in a row.
      if (!polished && row.role === 'frontend' && lanes().some((r) => r.role === 'ui-polisher' && r.deps.includes(row.ticket))) polished = 'planned';
      if (!failure && row.role === 'frontend' && !polished) { // a first design gets a UI Polisher pass instead of a Reviewer; scope and gate are then checked again
        polished = true;
        live(row.ticket, { stage: 'polish' });
        const p = await launch('ui-polisher', `${polishMark} You polish ticket ${row.ticket}; its build is green. Read its brief at ${briefOf(row)}. ` +
          `Improve states (empty, loading, error), spacing, alignment and accessibility in ${row.writes.join(', ')} only, without changing behaviour the brief or its tests fix. ` +
          `Run the targeted tests and keep them green. Do not touch .tsf/, gate.sh or gate tests. Do not hc send anyone; stop when done.`, `p-${row.ticket}`, dir);
        polisher = p.addr ?? null;
        if (polisher) {
          live(row.ticket, { polisher });
          const over = await waitIdle(polisher, polishUsage, budgetFor(settings, 'ui-polisher'), { ms: 0 });
          await hc('kill', polisher); polisher = null;
          if (over) live(row.ticket, { note: `polish ${over}` }); // the green build stands; the checks below catch a half-done polish
          await event(`${row.ticket} polished${over ? ` (${over})` : ''}`);
        }
        recheck = true;
        continue;
      }
      if (!failure && row.review && row.role !== 'frontend') { // the build is green: the Reviewer's turn
        live(row.ticket, { stage: 'review', round: reviewRound });
        let was = stamp(reviewPath);
        if (light && !reviewer) await startReviewer(); // its first turn is the review
        if (!reviewer) { const r = await stuck(`reviewer never started: ${reviewWhy}`); if (r !== true) return r; if (!light) await startReviewer(); continue; }
        if (!light || reviewRound > 0) {
        const pre = await waitIdle(reviewer, reviewUsage, reviewBudget, clock.reviewer); // it may still be writing its tests
        if (pre) { const r = await stuck(`review ${pre}`); if (r === true) continue; return r; }
        was = stamp(reviewPath);
        await hc('send', reviewer, reviewRound === 0
          ? `Build for ${row.ticket} is ready. Read its brief at ${briefOf(row)} again first: it may have changed since you wrote your tests, and where it now differs, fix your own tests to match. Review the diff of ${row.writes.join(', ')} against the brief and contract, and run your tests (${reviewAt}). Overwrite ${reviewPath} with every defect (file, line, failing case), or the single line "No defects". Then stop.`
          : `Fixes for ${row.ticket} are in. Re-check only the defects you listed${light ? '' : ' and run your tests again'}. Rewrite ${reviewPath}: the defects that remain, or the single line "No defects". Then stop.`);
        }
        // Its verdict is the file: idle without it gets the same nudge and Lead alert as a build with no ready.
        const over = await waitIdle(reviewer, reviewUsage, reviewBudget, clock.reviewer, { done: () => stamp(reviewPath) !== was, what: `findings in ${reviewPath}`,
          nudge: `Overwrite ${reviewPath} with your findings, or the single line "No defects", then stop. The lane waits on that file.` });
        if (over) { const r = await stuck(`review ${over}`); if (r === true) continue; return r; }
        const findings = readFileSync(reviewPath, 'utf8').trim();
        if (!/^no defects\b/i.test(findings)) {
          await event(`${row.ticket} review round ${reviewRound + 1}: defects, back to its Worker (${findings.split('\n')[0].slice(0, 80)})`);
          if (++reviewRound > reviewRounds) {
            const r = await stuck(`review: defects remain after ${reviewRounds} fix round${reviewRounds > 1 ? 's' : ''} (${reviewFile})`);
            if (r !== true) return r;
            reviewRound = 1;
            continue;
          }
          live(row.ticket, { stage: 'fixing', round: reviewRound });
          await tell(`Review found defects in ${row.ticket}. Fix only these, keep your tests and the gate green, then stop:\n${findings.slice(0, 3000)}`);
          continue;
        }
      }
      if (!failure) return finish((row.gated ? 'gate passed' : knobs.test && alone ? 'tests passed' : 'scope clean') + (row.review ? `, ${light ? 'light ' : ''}review passed${reviewRound ? ` after ${reviewRound} fix round${reviewRound > 1 ? 's' : ''}` : ''}` : ''));

      failures++;
      challengeable = failure.startsWith('Gate failed');
      if (failures > knobs.fixRounds) {
        const r = await stuck(`still failing after ${knobs.fixRounds} fix rounds: ${failure.split('\n')[0]}`);
        if (r !== true) return r;
        failures = 0;
        continue;
      }
      live(row.ticket, { stage: 'building', note: failure.split('\n')[0].slice(0, 120) });
      if (failures < knobs.fixRounds || byFactory()) { // warm session (or the factory, never replaced): send just the failures
        await tell(failure);
        continue;
      }
      // last fix round: a fresh session from a handoff note; if it fails too, the Lead decides
      mkdirSync(join(project, '.tsf/handoff'), { recursive: true });
      const handoff = join(project, '.tsf/handoff', `${row.ticket}.md`);
      writeFileSync(handoff, `# Handoff for ${row.ticket}\n\nBrief: ${briefOf(row)}\nWrites: ${row.writes.join(', ')}\nFolder: ${dir}\n\nThe previous session failed ${failures} times. Latest failure:\n\n${failure}\n\nThe files it wrote are in the folder; check them before rewriting.\n`);
      await hc('kill', worker);
      fresh = true;
      const again = await start(task(`A previous session got stuck; read ${handoff} first.`));
      if (again !== true) { const r = await stuck(again); if (r !== true) return r; }
      await move(row.ticket, 'doing', worker);
      live(row.ticket, { worker });
    }
    } catch (e) { // one ticket's failure must not take the batch down: block it, and the summary and wake still happen
      return block(`error: ${e.message}`);
    } finally { clearInterval(watch); }
  }

  // The optional readability pass at lane end: one Sonnet session simplifies the lane's diff without changing behaviour,
  // the tests rerun, and a green result is one commit; a red one is undone. Each lane does it before its own "ready", in parallel.
  async function readability() {
    const files = (await git(['diff', '--name-only', `${trunk}...HEAD`], work)).out.split('\n').filter((f) => f && !f.startsWith('.tsf/') && existsSync(join(work, f)));
    if (!files.length) return 'readability: no lane files to simplify';
    const before = snapshot(work);
    const r = await launch('worker', `[batch ${id} lane.readability] You simplify lane ${id}'s code without changing its behaviour: clearer names, dead code removed, duplication folded. ` +
      `Edit only these files: ${files.join(', ')}. Change no public name, signature, output or test expectation. Run the tests (${knobs.test}) and keep them green. ` +
      `Do not touch .tsf/, gate.sh or gate tests. Do not commit, move tickets or hc send anyone; stop when done.`, `rd-${id}`);
    if (!r.addr) return `readability skipped: ${r.why}`;
    state.stage = 'readability'; live(null, {});
    await settle(r.addr);
    await hc('kill', r.addr);
    const undo = async (fs) => { for (const f of fs) if ((await git(['checkout', 'HEAD', '--', f], work)).code) rmSync(join(work, f), { force: true }); };
    const changed = changedSince(work, before).filter((f) => !f.startsWith('.tsf/'));
    await undo(changed.filter((f) => !files.includes(f))); // outside the lane's diff: never kept
    const kept = changed.filter((f) => files.includes(f));
    if (!kept.length) return 'readability: nothing changed';
    const t = await testRun();
    if (t.code) { await undo(kept); return `readability undone: ${knobs.test} failed after it (exit ${t.code})`; }
    const c = await locked(async () => { const a = await git(['add', '-A', '--', ...kept], work); return a.code ? a : git(['commit', '-q', '-m', `${id}: readability`, '--', ...kept], work); });
    return c.code ? `readability not committed: ${tail(c).split('\n')[0]}` : `readability: ${kept.length} file${kept.length > 1 ? 's' : ''} simplified, tests green`;
  }

  // ----- the end: merge the trunk in, summary, and the one wake -----
  async function wrapUp(stopped = '') {
    if (wrapped) return;
    wrapped = true;
    let ready = '';
    if (useTree && !stopped) { // the Lead merges lanes one at a time, so each arrives already synced with the trunk and tested
      let why = await mergeIn(trunk, 'lane');
      if (!why && knobs.test) { const t = await testRun(); if (t.code) why = `${knobs.test} fails after merging ${trunk} (exit ${t.code})`; }
      const pass = knobs.readability === true || (Array.isArray(knobs.readability) && knobs.readability.includes(id));
      if (!why && pass) { const note = knobs.test ? await readability() : 'readability skipped: no test command to prove it'; events.push(note); state.readability = note; live(null, {}); }
      ready = why ? ` ${branch} is not ready to merge: ${why}.` : ` Ready to merge: git merge --no-ff ${branch}, then git worktree remove ${work}.`;
    }
    const lines = [`# Batch ${id}`, '', '| ticket | result | note |', '|---|---|---|'];
    const waits = (r) => `waits on ${r.deps.filter((d) => !depDone(d)).join(', ')}`;
    for (const r of [...rows, ...stolen]) {
      const res = result.get(r.ticket);
      const note = (r.from ? `from lane ${r.from}: ` : '') + (res ? res.reason : running.has(r.ticket) ? `stopped mid-build (${stopped}), back to todo` : `not started: ${waits(r)}`);
      lines.push(`| ${r.ticket} | ${res?.state || 'todo'} | ${note.replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
    }
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, `${id}.summary.md`), lines.join('\n') + '\n');
    for (const r of rows) if (!result.has(r.ticket) && !running.has(r.ticket)) live(r.ticket, { note: waits(r) });
    state.ended = Date.now(); state.stage = stopped ? 'stopped' : 'ended'; live(null, {});
    const done = [...result.values()].filter((r) => r.state === 'done').length;
    const total = rows.length + stolen.length;
    const msg = `Batch ${id}: ${done}/${total} done, ${total - done} not.${stolen.length ? ` Took ${stolen.map((r) => `${r.ticket} from ${r.from}`).join(', ')}.` : ''}${stopped ? ` Stopped (${stopped}): its in-flight rows are back to todo; rerun the lane to go on.` : ready} Summary: .tsf/batches/${id}.summary.md`;
    if (boss && boss !== starter) { events.push(msg); await flush(); } // the Lead hears the end itself, with the last events
    if (starter) await hc('send', starter, events.length ? `${msg} Events: ${events.join('; ')}` : msg);
    console.log(msg);
  }

  for (const w of warm.values()) await hc('kill', w.addr); // an heir that never ran leaves its Worker behind
  await wrapUp();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
