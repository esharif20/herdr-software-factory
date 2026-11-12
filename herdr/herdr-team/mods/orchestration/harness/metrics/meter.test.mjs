import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'meter-'));
mkdirSync(join(root, '-proj-a'));
mkdirSync(join(root, '-other'));
const at = (s) => new Date(Date.UTC(2026, 10, 9, 12, 0, s)).toISOString();
const usage = (inp, w, r, out) => ({ input_tokens: inp, output_tokens: out, cache_read_input_tokens: r, cache_creation_input_tokens: w, cache_creation: { ephemeral_1h_input_tokens: w, ephemeral_5m_input_tokens: 0 } });
const rec = (o) => JSON.stringify({ sessionId: 's1', cwd: '/p', ...o });
const lines = [
  rec({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Ticket T-7: do it' } }),
  rec({ type: 'assistant', timestamp: at(10), message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }], usage: usage(2, 1000, 5000, 10) } }),
  rec({ type: 'assistant', timestamp: at(10), message: { id: 'm1', model: 'claude-sonnet-5-5', content: [], usage: usage(2, 1000, 5000, 50) } }), // streamed duplicate, more output
  rec({ type: 'user', timestamp: at(12), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } }),
  rec({ type: 'assistant', timestamp: at(200), message: { id: 'm2', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'done' }], usage: usage(2, 0, 9000, 20) } }),
  rec({ type: 'user', timestamp: at(260), message: { role: 'user', content: 'one more thing' } }),
];
writeFileSync(join(root, '-proj-a/s1.jsonl'), lines.join('\n'));
writeFileSync(join(root, '-other/s2.jsonl'), lines.join('\n').replaceAll('s1', 's2'));

const run = (...a) => spawnSync('node', [new URL('./meter.mjs', import.meta.url).pathname, '--root', root, '--json', join(root, 'out.json'), ...a], { encoding: 'utf8' });
let r = run('--dir', 'proj-a'); assert.equal(r.status, 0, r.stderr);
let out = JSON.parse(readFileSync(join(root, 'out.json'), 'utf8'));
assert.equal(out.sessions.length, 1, 'folder filter');
const s = out.sessions[0];
assert.equal(s.ticket, 'T-7');
assert.equal(s.wall_s, 260); assert.equal(s.first_tool_s, 10);
assert.equal(s.idle_gaps, 1); // 12->200 only; 200->260 is exactly 60 s, not over
assert.equal(s.startup_tokens, 6002); assert.equal(s.peak_context, 9002);
assert.equal(s.cache_read, 14000); assert.equal(s.cache_write, 1000);
assert.equal(s.wakes, 1);
assert.equal(s.cost, +((2 * 2 + 50 * 10 + 1000 * 4 + 5000 * 0.1 + 2 * 2 + 20 * 10 + 9000 * 0.1) / 1e6).toFixed(4));
assert.equal(out.tickets[0].ticket, 'T-7');

r = run(); out = JSON.parse(readFileSync(join(root, 'out.json'), 'utf8'));
assert.equal(out.sessions.length, 2, 'no filter sees both');
r = run('--since', at(500)); out = JSON.parse(readFileSync(join(root, 'out.json'), 'utf8'));
assert.equal(out.sessions.length, 0, 'time window excludes old records');

mkdirSync(join(root, '-tester'));
const tester = rec({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'You are Test writer, a one-ticket session. Tickets T-43 and T-44.' } });
writeFileSync(join(root, '-tester/t1.jsonl'), [tester, ...lines.slice(1)].join('\n').replaceAll('"s1"', '"t1"'));
r = run('--dir', 'tester'); out = JSON.parse(readFileSync(join(root, 'out.json'), 'utf8'));
assert.equal(out.sessions[0].ticket, 'tests', 'a Test writer is not billed to the first ticket in its brief');
assert.match(r.stdout, /TICKET tests/);
console.log('meter tests ok');
