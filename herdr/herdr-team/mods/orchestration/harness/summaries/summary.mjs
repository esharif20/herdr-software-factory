#!/usr/bin/env node
// One sentence per N tool calls, written by a small model from the session transcript, outside the Worker.
// usage: node summary.mjs <transcript.jsonl> <project dir> <ticket>
// Settings (.tsf/settings.json): { "summary": { "every": 5, "max_usd": 0.05, "model": "claude-haiku-5-5" } }
// SUMMARY_CMD overrides the model command (reads the prompt on stdin, prints the sentence); tests use it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const [transcript, project, ticket] = process.argv.slice(2);
if (!transcript || !project || !ticket) { console.error('usage: summary.mjs <transcript.jsonl> <project> <ticket>'); process.exit(2); }

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const cfg = { every: 5, max_usd: 0.05, model: 'claude-haiku-5-5', ...readJson(join(project, '.tsf/settings.json'), {}).summary };
const out = join(project, '.tsf/traces', `${ticket}.json`);
const trace = { ticket, transcript, calls: 0, cost: 0, summary: '', summaries: [], ...readJson(out, {}) };

// Tool calls in order, each once (a streamed message repeats its tool_use blocks).
const calls = []; const seen = new Set();
for (const line of readFileSync(transcript, 'utf8').split('\n')) {
  let d; try { d = JSON.parse(line); } catch { continue; }
  if (d.type !== 'assistant') continue;
  for (const b of d.message?.content || []) {
    if (b.type !== 'tool_use' || seen.has(b.id)) continue;
    seen.add(b.id);
    calls.push(`${b.name} ${JSON.stringify(b.input).slice(0, 160)}`);
  }
}

// Haiku prices, USD per million tokens, tokens estimated as chars/4: the cap is a guard, not billing.
const estimate = (i, o) => (i / 4 * 0.1 + o / 4 * 0.5) / 1e6;
const cmd = process.env.SUMMARY_CMD || `claude -p --model ${cfg.model} --no-session-persistence --max-budget-usd ${cfg.max_usd}`;

while (calls.length - trace.calls >= cfg.every && trace.cost < cfg.max_usd) {
  const chunk = calls.slice(trace.calls, trace.calls + cfg.every);
  const prompt = `One plain sentence (max 25 words) saying what the agent just did, from these tool calls:\n${chunk.join('\n')}`;
  const r = spawnSync('sh', ['-c', cmd], { input: prompt, encoding: 'utf8', timeout: 60_000 });
  const text = (r.stdout || '').trim().split('\n')[0].slice(0, 300);
  if (r.status !== 0 || !text) { console.error(`summary: model command failed (${r.status})`); break; }
  trace.calls += cfg.every;
  trace.cost = +(trace.cost +estimate(prompt.length, text.length)).toFixed(6);
  trace.summaries.push({ calls: trace.calls, text });
  trace.summary = text;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(trace, null, 2));
console.log(`${ticket}: ${trace.calls}/${calls.length} calls summarised, ~$${trace.cost}${trace.cost >=cfg.max_usd ? ' (cap reached)' : ''}`);
