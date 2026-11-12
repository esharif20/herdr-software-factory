#!/usr/bin/env node
// Per session and per ticket numbers from Claude Code transcripts (read-only). Method: bench2/metrics/METHOD.md.
// usage: node meter.mjs [--since T] [--until T] [--dir REGEX] [--root DIR] [--json out.json]
//   T is epoch seconds or an ISO date. --dir filters project folder names (default: all). --root defaults to ~/.claude/projects.
// Per session: wall time, time before the first tool call, idle gaps (>60 s), startup tokens (first call's whole prompt),
// cache read/write, peak context, wakes (prompts typed or sent into the session after its first), dollars.
// A ticket is the first T-n or GH-n named in the session's first prompt; sessions without one are listed under "-".
// A Test writer's brief names every gated ticket, so it is listed under "tests" rather than billed to the first one.
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? undefined : process.argv[i + 1]; };
const time = (v, d) => (v === undefined ? d : /^\d+(\.\d+)?$/.test(v) ? +v * 1000 : Date.parse(v));
const SINCE = time(arg('since'), 0), UNTIL = time(arg('until'), Infinity);
const DIRS = new RegExp(arg('dir') || '.');
const ROOT = arg('root') || join(homedir(), '.claude/projects');
const GAP_MS = 60_000;

// USD per million tokens (METHOD.md). Haiku prompts over 100k tokens use the long row.
const P = {
  'claude-opus-5-5': { in: 4, out: 20, w5: 5, w1: 8, r: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, w5: 2.5, w1: 4, r: 0.1 },
  'claude-fable-5-1': { in: 10, out: 50, w5: 12.5, w1: 20, r: 0.25 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, w5: 0.125, w1: 0.2, r: 0.01 },
  'claude-haiku-5-5:long': { in: 0.5, out: 2.5, w5: 0.625, w1: 1.0, r: 0.05 },
};
const priceFor = (model, prompt) => (model === 'claude-haiku-5-5' && prompt > 100_000 ? P['claude-haiku-5-5:long'] : P[model]);

function* walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const sessions = new Map();
const unpriced = {};
for (const dn of readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && DIRS.test(e.name)).map((e) => e.name)) {
  for (const f of walk(join(ROOT, dn))) {
    if (statSync(f).mtimeMs < SINCE) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      const t = Date.parse(d.timestamp);
      if (!(t >= SINCE && t < UNTIL)) continue;
      const id = d.sessionId || basename(f, '.jsonl'); // subagent files carry their parent's sessionId
      let s = sessions.get(id);
      if (!s) sessions.set(id, (s = { session: id, cwd: d.cwd, ts: [], msgs: new Map(), firstTool: null, prompts: [] }));
      s.cwd ??= d.cwd;
      s.ts.push(t);
      const m = d.message;
      if (d.type === 'user' && m) {
        const c = m.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.map((b) => b.text || '').join('') : null;
        if (text !== null && !d.isMeta && !d.isSidechain) s.prompts.push(text);
      }
      if (d.type === 'assistant' && m) {
        if (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')) s.firstTool = Math.min(s.firstTool ?? t, t);
        if (m.usage && m.model) {
          const key = m.id || d.requestId || d.uuid; // streamed duplicates share an id; keep the one with most output
          const prev = s.msgs.get(key);
          if (!prev || (m.usage.output_tokens || 0) >= (prev.usage.output_tokens || 0)) s.msgs.set(key, { model: m.model, usage: m.usage, t });
        }
      }
    }
  }
}

const rows = [];
for (const s of sessions.values()) {
  if (!s.msgs.size) continue;
  const ts = s.ts.sort((a, b) => a - b);
  const msgs = [...s.msgs.values()].sort((a, b) => a.t - b.t);
  const r = { session: s.session, cwd: s.cwd, ticket: /You are Test writer\b/.test(s.prompts[0] || '') ? 'tests' : (s.prompts[0] || '').match(/\b(?:T|GH)-\d+\b/)?.[0] || '-', model: '', wall_s: 0, first_tool_s: null, idle_gaps: 0, idle_s: 0, startup_tokens: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, peak_context: 0, wakes: Math.max(0, s.prompts.length - 1), cost: 0 };
  r.wall_s = Math.round((ts.at(-1) - ts[0]) / 1000);
  if (s.firstTool !== null) r.first_tool_s = Math.round((s.firstTool - ts[0]) / 1000);
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > GAP_MS) { r.idle_gaps++; r.idle_s += Math.round((ts[i] - ts[i - 1]) / 1000); }
  const count = {};
  msgs.forEach(({ model, usage: u }, i) => {
    const cc = u.cache_creation || {};
    const w1 = cc.ephemeral_1h_input_tokens ?? 0;
    const w5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1);
    const read = u.cache_read_input_tokens || 0, inp = u.input_tokens || 0;
    const prompt = inp + read + w1 + w5;
    if (i === 0) r.startup_tokens = prompt;
    r.peak_context = Math.max(r.peak_context, prompt);
    r.input += inp; r.output += u.output_tokens || 0; r.cache_read += read; r.cache_write += w1 + w5;
    count[model] = (count[model] || 0) + 1;
    const p = priceFor(model, prompt);
    if (!p) { unpriced[model] = (unpriced[model] || 0) + 1; return; }
    r.cost += (inp * p.in + (u.output_tokens || 0) * p.out + w5 * p.w5 + w1 * p.w1 + read * p.r) / 1e6;
  });
  r.model = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  r.cost = +r.cost.toFixed(4);
  rows.push(r);
}
rows.sort((a, b) => a.session.localeCompare(b.session));

const tickets = {};
for (const r of rows) {
  const k = (tickets[r.ticket] ??= { ticket: r.ticket, sessions: 0, wall_s: 0, first_tool_s: 0, idle_s: 0, startup_tokens: 0, cache_read: 0, cache_write: 0, peak_context: 0, wakes: 0, cost: 0 });
  k.sessions++; k.wall_s += r.wall_s; k.first_tool_s += r.first_tool_s || 0; k.idle_s += r.idle_s;
  k.startup_tokens += r.startup_tokens; k.cache_read += r.cache_read; k.cache_write += r.cache_write;
  k.peak_context = Math.max(k.peak_context, r.peak_context); k.wakes += r.wakes; k.cost = +(k.cost + r.cost).toFixed(4);
}

const result = { since: SINCE ? new Date(SINCE).toISOString() : null, until: Number.isFinite(UNTIL) ? new Date(UNTIL).toISOString() : null, sessions: rows, tickets: Object.values(tickets), total_cost: +rows.reduce((a, r) => a + r.cost, 0).toFixed(4), unpriced_models: unpriced };
if (arg('json')) writeFileSync(arg('json'), JSON.stringify(result, null, 2));
for (const r of rows) console.log(`${r.session.slice(0, 8)} ${r.ticket.padEnd(6)} ${r.model.padEnd(18)} wall ${r.wall_s}s first-tool ${r.first_tool_s ?? '-'}s idle ${r.idle_gaps}x/${r.idle_s}s startup ${r.startup_tokens} cr ${r.cache_read} cw ${r.cache_write} peak ${r.peak_context} wakes ${r.wakes} $${r.cost}`);
for (const k of result.tickets) console.log(`TICKET ${k.ticket.padEnd(6)} ${k.sessions} sessions wall ${k.wall_s}s wakes ${k.wakes} $${k.cost}`);
console.log(`TOTAL ${rows.length} sessions $${result.total_cost}`);
if (Object.keys(unpriced).length) console.log('UNPRICED', unpriced);
