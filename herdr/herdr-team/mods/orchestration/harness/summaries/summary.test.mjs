import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'summary-'));
const tr = join(dir, 't.jsonl');
const lines = [];
for (let i = 0; i < 12; i++) {
  const m = { type: 'assistant', message: { content: [{ type: 'tool_use', id: `u${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } };
  lines.push(JSON.stringify(m), JSON.stringify(m)); // streamed duplicate
}
writeFileSync(tr, lines.join('\n'));
const stub = join(dir, 'stub.sh');
writeFileSync(stub, '#!/bin/sh\ncat >/dev/null; echo "did a thing"\n');
const run = () => spawnSync('node', [new URL('./summary.mjs', import.meta.url).pathname, tr, dir, 'T-1'], { encoding: 'utf8', env: { ...process.env, SUMMARY_CMD: `sh ${stub}` } });

const r = run(); assert.equal(r.status, 0, r.stderr);
const file = join(dir, '.tsf/traces/T-1.json');
let t = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(t.calls, 10); assert.equal(t.summaries.length, 2); assert.equal(t.summary, 'did a thing');
assert.equal(typeof t.cost, 'number'); assert.equal(t.transcript, tr);
run(); t = JSON.parse(readFileSync(file, 'utf8')); assert.equal(t.summaries.length, 2, 'idempotent below N new calls');

// cap: a spent budget stops further calls
mkdirSync(join(dir, '.tsf'), { recursive: true });
writeFileSync(join(dir, '.tsf/settings.json'), JSON.stringify({ summary: { every: 2, max_usd: 0.0000001 } }));
writeFileSync(file, JSON.stringify({ ticket: 'T-1', calls: 10, cost: 1, summaries: [] }));
run(); t = JSON.parse(readFileSync(file, 'utf8')); assert.equal(t.calls, 10);
console.log('summary tests ok');
