// Run: node --test batch.test.mjs   (real ticket.sh and gate.sh under a temp HOME, stub hc and capacity)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { budgetFor, globToRe, parseTsv } from './batch.mjs';
import { STATIONS, CREW } from '../../team.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH = join(HERE, '..');

// rows: { id, deps, role, writes, gated (true | 'missing': no hidden tests), gateKey ('project': tests under the project path), actions, gateFails, isolate }
// Stub Workers run the ready command their task gives them when an action finishes (see hc-stub.mjs), so a row ends as a real one does.
// settings merged into .tsf/settings.json; git: the project is a git repo with these committed files (the lane then builds in a worktree)
function world(rows, { settings = {}, env = {}, preBoard, git } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'batch-'));
  const home = join(root, 'home'), project = join(root, 'project'), stub = join(root, 'stub');
  for (const d of [home, join(project, '.tsf/batches'), stub]) mkdirSync(d, { recursive: true });
  const e = { ...process.env, HOME: home, HC: join(HERE, 'hc-stub.mjs'), CAPACITY_SH: join(HERE, 'capacity-stub.sh'), STUB_DIR: stub, STUB_PROJECT: project,
    CLAUDE_PROJECTS: join(root, 'claude'), BATCH_POLL_MS: '100', BATCH_HOLD_MS: '0', BATCH_FIRST_MS: '1500', GATE_WAIT: '2',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env };
  const sh = (script, ...a) => spawnSync('sh', [join(ORCH, script), 'testboard', ...a], { env: e, encoding: 'utf8' });
  writeFileSync(join(project, '.tsf/settings.json'), JSON.stringify({ board: 'testboard', ...settings }));
  const scenario = {};
  mkdirSync(join(project, '.tsf/briefs'), { recursive: true }); writeFileSync(join(project, '.tsf/briefs/X.md'), '# X\n'); // other lanes' rows in some tests
  const tsv = ['ticket\tdepends-on\trole\twrites\tgated\tbrief'];
  for (const r of rows) {
    sh('tickets/ticket.sh', 'add', `title ${r.id}`);
    tsv.push([r.id, (r.deps || []).join(',') || '-', r.role || 'worker', (r.writes || [`${r.id}/**`]).join(','), r.gated ? 'yes' : 'no', `.tsf/briefs/${r.id}.md`, r.review === true ? 'yes' : r.review || 'no', r.race ? 'race' : 'no', r.isolate ? 'yes' : 'no'].join('\t'));
    if (!r.unbriefed) { mkdirSync(join(project, '.tsf/briefs'), { recursive: true }); writeFileSync(join(project, `.tsf/briefs/${r.id}.md`), `# ${r.id}\n`); }
    scenario[r.id] = r.actions || [];
    if (r.reviewActions) scenario[`${r.id}.review`] = r.reviewActions;
    if (r.gated && r.gated !== 'missing') { // the hidden gate fails `gateFails` times, then passes
      const g = spawnSync('sh', [join(ORCH, 'gate/gate.sh'), r.gateKey === 'project' ? project : 'testboard', r.id, '--path'], { env: e, encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(g, 'run.sh'), `f=${stub}/gate-${r.id}; n=$(cat $f 2>/dev/null || echo 0); echo $((n+1)) > $f; [ $n -ge ${r.gateFails || 0} ] && exit 0; echo "FAIL assertion $n in ${r.id}"; exit 1\n`);
    }
  }
  writeFileSync(join(project, '.tsf/batches/b1.tsv'), tsv.join('\n') + '\n');
  if (git) {
    const g = (...a) => spawnSync('git', ['-C', project, ...a], { env: e, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    for (const [rel, text] of Object.entries(git)) { mkdirSync(dirname(join(project, rel)), { recursive: true }); writeFileSync(join(project, rel), text); }
    g('add', '-A', '--', ...Object.keys(git)); g('commit', '-qm', 'seed');
  }
  writeFileSync(join(stub, 'scenario.json'), JSON.stringify(scenario));
  preBoard?.(sh);
  const go = () => spawnSync('node', [join(HERE, 'batch.mjs'), 'b1', '--project', project, '--starter', 'tstarter'], { env: e, encoding: 'utf8', timeout: 60000 });
  const calls = () => readFileSync(join(stub, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\d+ /, ''));
  const stages = () => Object.fromEntries(sh('tickets/ticket.sh', 'ls').stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).map((c) => [c[0], c[1]]));
  const summary = () => readFileSync(join(project, '.tsf/batches/b1.summary.md'), 'utf8');
  const git_ = (...a) => spawnSync('git', ['-C', project, ...a], { env: e, encoding: 'utf8' }).stdout.trim();
  return { project, go, calls, stages, summary, sh, env: e, git: git_, lane: join(project, '.tsf/lanes/b1') };
}
const ok = (id) => ({ writes: { [`${id}/out.txt`]: 'x' } });

test('parses the tsv and globs', () => {
  const rows = parseTsv('ticket\tdepends-on\trole\twrites\tgated\tbrief\nT-1\t-\tworker\ta/**,b.txt\tyes\t/x.md\nT-2\tT-1,T-3\tbuilder\t*.js\tno\t/y.md\n');
  assert.deepEqual(rows[0], { ticket: 'T-1', deps: [], role: 'worker', writes: ['a/**', 'b.txt'], gated: true, brief: '/x.md', review: false, race: false, isolate: false });
  assert.deepEqual(rows[1].deps, ['T-1', 'T-3']);
  assert.ok(globToRe('a/**').test('a/b/c.js') && !globToRe('a/*').test('a/b/c.js') && !globToRe('*.js').test('x/y.js'));
});

test('a blocked ticket has no session until its dependencies are done', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', deps: ['T-1'], actions: [ok('T-2')] }]);
  assert.equal(w.go().status, 0);
  const c = w.calls();
  const run1 = c.findIndex((l) => l.startsWith('run') && l.includes('[batch b1 T-1]'));
  const run2 = c.findIndex((l) => l.startsWith('run') && l.includes('[batch b1 T-2]'));
  const kill1 = c.findIndex((l) => l === 'kill xT-1_1');
  assert.ok(run1 >= 0 && kill1 > run1 && run2 > kill1, c.join('\n'));
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'done' });
});

test('starts only what capacity allows, more as slots free up', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', actions: [ok('T-2')] }, { id: 'T-3', actions: [ok('T-3')] }], { env: { STUB_CAPACITY: '1' } });
  assert.equal(w.go().status, 0);
  const c = w.calls().filter((l) => /^(run|kill)/.test(l)).map((l) => l.split(' ').slice(0, 1).concat(l.match(/T-\d|xT-\d/)?.[0] || '').join(' '));
  // never two runs in a row: each Worker is killed (done) before the next starts
  assert.deepEqual(c.map((x) => x.split(' ')[0]), ['run', 'kill', 'run', 'kill', 'run', 'kill']);
  assert.deepEqual(Object.values(w.stages()), ['done', 'done', 'done']);
});

test("the Lead's Workers-per-lane setting caps a lane below capacity", () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', actions: [ok('T-2')] }, { id: 'T-3', actions: [ok('T-3')] }], { settings: { workers: 1 } });
  assert.equal(w.go().status, 0);
  assert.deepEqual(w.calls().filter((l) => /^(run|kill)/.test(l)).map((l) => l.split(' ')[0]), ['run', 'kill', 'run', 'kill', 'run', 'kill']);
});

test('a first message that never landed is retried once, then the ticket is blocked, with no keys pressed', () => {
  const w = world([{ id: 'T-1', actions: [{ first: false }, { first: false }] }, { id: 'T-2', actions: [{ first: false }, ok('T-2')] }]);
  assert.equal(w.go().status, 0);
  const c = w.calls();
  assert.equal(c.filter((l) => l.startsWith('run') && l.includes('[batch b1 T-1]')).length, 2);
  assert.equal(c.filter((l) => l.startsWith('run') && l.includes('[batch b1 T-2]')).length, 2);
  assert.ok(!c.some((l) => /^(keys|interrupt)/.test(l)));
  assert.deepEqual(w.stages(), { 'T-1': 'blocked', 'T-2': 'done' });
  assert.match(w.summary(), /T-1 \| blocked \| first message never landed: it never reported its status/);
});

test('a launch that gives no answer within the first-message window counts as undelivered', () => {
  const w = world([{ id: 'T-1', actions: [{ first: 'hang' }, ok('T-1')] }], { env: { BATCH_FIRST_MS: '400' } });
  assert.equal(w.go().status, 0);
  assert.equal(w.calls().filter((l) => l.startsWith('run')).length, 2);
  assert.equal(w.stages()['T-1'], 'done');
});

test('over the dollar cap: kill the Worker and block with the reason', () => {
  const w = world([{ id: 'T-1', actions: [{ usd_tokens: 100000, hang: true }] }]); // 100k output tokens of Sonnet = $1.00 > $0.50, still working
  w.go();
  assert.ok(w.calls().includes('kill xT-1_1'));
  assert.equal(w.stages()['T-1'], 'blocked');
  assert.match(w.summary(), /over budget: \$1\.00 of \$0\.50/);
});

test('over the cap with its gate already green: done, not blocked', () => {
  const w = world([{ id: 'T-1', gated: true, actions: [{ usd_tokens: 100000, hang: true }] }]);
  w.go();
  assert.ok(w.calls().includes('kill xT-1_1'));
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| gate passed \(over budget/);
});

test('budgets come per role from .tsf/settings.json', () => {
  const w = world([{ id: 'T-1', role: 'worker-strong', actions: [{ usd_tokens: 100000, ...ok('T-1') }] }, { id: 'T-2', actions: [{ usd_tokens: 100000, hang: true }] }],
    { settings: { budgets: { 'worker-strong': { usd: 5 }, worker: { usd: 0.05 } } } });
  w.go();
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'blocked' });
  assert.match(w.summary(), /\$1\.00 of \$0\.05/);
});

test('budgets fall back to the seat definition, and settings still win', () => {
  const seats = [{ id: 'worker', budget: { usd: 2, minutes: 20 } }];
  assert.deepEqual(budgetFor({}, 'worker', seats), { usd: 2, minutes: 20 });
  assert.deepEqual(budgetFor({ budgets: { worker: { usd: 3 } } }, 'worker', seats), { usd: 3, minutes: 20 });
  assert.deepEqual(budgetFor({}, 'no-such-seat', seats), { usd: 0.5, minutes: 10 });
  assert.deepEqual(budgetFor({}, 'builder'), [...STATIONS, ...CREW].find((s) => s.id === 'builder').budget); // the real team.js
});

test('with no board in settings, the board and gate tests come from the Herdr space', () => {
  const w = world([{ id: 'T-1', gated: true, actions: [ok('T-1')] }], { settings: { board: undefined }, env: { STUB_SPACE: 'testboard' } });
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| gate passed/);
  assert.ok(!w.calls().some((l) => l.startsWith('run') && l.includes('ticket.sh')), 'the batch alone moves its rows; the Worker is given no board command');
});

test('with no board anywhere, the batch refuses to start', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }], { settings: { board: undefined } });
  const r = w.go();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no board id/);
  assert.ok(!w.calls().some((l) => l.startsWith('run')));
});

test('a Worker that says a gate test contradicts the spec stops the ticket after that round', () => {
  const w = world([{ id: 'T-1', gated: true, gateFails: 99, actions: [ok('T-1'), { reply: 'Checked the spec.\nCONTRADICTS row 4 fails: 4 units are in stock' }] }, { id: 'T-2', deps: ['T-1'] }]);
  assert.equal(w.go().status, 0);
  const c = w.calls();
  const toWorker = c.filter((l) => l.startsWith('send xT-1_1'));
  assert.equal(toWorker.length, 1);
  assert.match(toWorker[0], /change no code and end your turn with one line: CONTRADICTS <test>: <reason>/);
  assert.equal(readFileSync(join(w.env.STUB_DIR, 'gate-T-1'), 'utf8').trim(), '1', 'the gate is not rerun');
  assert.equal(c.filter((l) => l.startsWith('run')).length, 1);
  assert.ok(c.includes('kill xT-1_1'));
  assert.deepEqual(w.stages(), { 'T-1': 'blocked', 'T-2': 'todo' });
  assert.match(w.summary(), /T-1 \| blocked \| gate test contradicts the spec: row 4 fails: 4 units are in stock/);
  assert.equal(c.filter((l) => /^send tstarter Lane b1 T-1 blocked: gate test contradicts the spec: row 4 fails: 4 units are in stock/.test(l)).length, 1);
});

test('CONTRADICTS before any gate failure, or quoted mid-line, is not a challenge', () => {
  const early = world([{ id: 'T-1', gated: true, actions: [{ ...ok('T-1'), reply: 'CONTRADICTS x: y' }] }]);
  early.go();
  assert.equal(early.stages()['T-1'], 'done');
  const quoted = world([{ id: 'T-1', gated: true, gateFails: 1, actions: [ok('T-1'), { reply: 'No need to say CONTRADICTS x: y here, fixed it.' }] }]);
  quoted.go();
  assert.equal(quoted.stages()['T-1'], 'done');
});

test('over the time cap: kill the Worker and block', () => {
  const w = world([{ id: 'T-1', actions: [{ hang: true }] }], { settings: { budgets: { worker: { minutes: 0.01 } } } });
  w.go();
  assert.ok(w.calls().includes('kill xT-1_1'));
  assert.equal(w.stages()['T-1'], 'blocked');
  assert.match(w.summary(), /over time/);
});

test('gate failures go back to the warm session, and only the failures', () => {
  const w = world([{ id: 'T-1', gated: true, gateFails: 1, actions: [ok('T-1'), ok('T-1')] }]);
  w.go();
  const sends = w.calls().filter((l) => l.startsWith('send xT-1_1'));
  assert.equal(sends.length, 1);
  assert.match(sends[0], /FAIL assertion 0 in T-1/);
  assert.ok(!sends[0].includes('[batch'), 'the brief is not repeated');
  assert.equal(w.stages()['T-1'], 'done');
});

test('third failure gets a fresh session from the handoff note, then blocked', () => {
  const w = world([{ id: 'T-1', gated: true, gateFails: 99, actions: [ok('T-1'), ok('T-1'), ok('T-1'), ok('T-1')] }]);
  w.go();
  const c = w.calls();
  assert.equal(c.filter((l) => l.startsWith('send xT-1_1')).length, 2); // two warm fix rounds
  assert.ok(c.includes('kill xT-1_1'));
  const fresh = c.filter((l) => l.startsWith('run') && l.includes('.tsf/handoff/T-1.md'));
  assert.equal(fresh.length, 1);
  assert.ok(fresh[0].includes('.tsf/handoff/T-1.md'));
  assert.match(readFileSync(join(w.project, '.tsf/handoff/T-1.md'), 'utf8'), /FAIL assertion 2/);
  assert.equal(c.filter((l) => l.startsWith('run')).length, 2);
  assert.equal(w.stages()['T-1'], 'blocked');
  assert.match(w.summary(), /still failing after 3 fix rounds/);
});

test('the fresh session can finish the ticket', () => {
  const w = world([{ id: 'T-1', gated: true, gateFails: 3, actions: [ok('T-1'), ok('T-1'), ok('T-1'), ok('T-1')] }]);
  w.go();
  assert.equal(w.stages()['T-1'], 'done');
});

test('the gate fails when the diff touches outside writes', () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/a.txt': 'x', 'stray.txt': 'x' } }, ok('T-1')] }]);
  w.go();
  const send = w.calls().find((l) => l.startsWith('send xT-1_1'));
  assert.match(send, /stray\.txt \(outside writes\)/);
  assert.ok(!send.includes('T-1/a.txt'));
});

test('protected files fail the gate even when writes would cover them', () => {
  const w = world([{ id: 'T-1', writes: ['**'], actions: [{ writes: { '.tsf/factory.md': 'x', 'sub/gate.sh': 'x' } }, ok('T-1')] }]);
  w.go();
  const send = w.calls().find((l) => l.startsWith('send xT-1_1'));
  assert.match(send, /\.tsf\/factory\.md \(protected\)/);
  assert.match(send, /sub\/gate\.sh \(protected\)/);
});

test("another ticket's writes are not blamed on this one", () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/a.txt': 'x', 'T-2/b.txt': 'x' } }] }, { id: 'T-2' }]);
  w.go();
  assert.equal(w.stages()['T-1'], 'done');
});

test('rerun skips done tickets and restarts a lost one', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', actions: [ok('T-2')] }, { id: 'T-3', actions: [ok('T-3')] }], {
    env: { STUB_LIVE: 'xlive_1' },
    preBoard: (sh) => { sh('tickets/ticket.sh', 'move', 'T-1', 'done'); sh('tickets/ticket.sh', 'move', 'T-2', 'doing', 'xgone_1'); sh('tickets/ticket.sh', 'move', 'T-3', 'doing', 'xlive_1'); },
  });
  assert.equal(w.go().status, 0);
  const c = w.calls();
  assert.ok(!c.some((l) => l.startsWith('run') && l.includes('T-1]')), 'done ticket not rerun');
  assert.ok(c.some((l) => l.startsWith('run') && l.includes('T-2]')), 'lost ticket restarted');
  assert.ok(c.includes('kill xlive_1'), 'a still-live old Worker is ended before its replacement');
  assert.ok(c.some((l) => l.startsWith('run') && l.includes('T-3]')));
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'done', 'T-3': 'done' });
});

test('a ticket behind a blocked one never starts and the batch still ends', () => {
  const w = world([{ id: 'T-1', actions: [{ first: false }, { first: false }] }, { id: 'T-2', deps: ['T-1'] }]);
  assert.equal(w.go().status, 0);
  assert.ok(!w.calls().some((l) => l.startsWith('run') && l.includes('T-2]')));
  assert.equal(w.stages()['T-2'], 'todo');
  assert.match(w.summary(), /T-2 \| todo \| not started: waits on T-1/);
});

test('writes the summary and sends exactly one message, to the starter', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', actions: [ok('T-2')] }]);
  w.go();
  assert.ok(existsSync(join(w.project, '.tsf/batches/b1.summary.md')));
  const sends = w.calls().filter((l) => l.startsWith('send'));
  assert.equal(sends.length, 1);
  assert.match(sends[0], /^send tstarter Batch b1: 2\/2 done/);
});

test("a restarted ticket does not inherit a crashed run's spend", () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }]);
  const dir = join(w.env.CLAUDE_PROJECTS, realpathSync(w.project).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const old = join(dir, 'old.jsonl'); // the earlier run's transcript: same marker, $10 of output
  writeFileSync(old, JSON.stringify({ type: 'user', message: { content: '[batch b1 T-1]' } }) + '\n' + JSON.stringify({ type: 'assistant', uuid: 'u', message: { id: 'm', model: 'claude-sonnet-5-5', usage: { output_tokens: 1000000 } } }) + '\n');
  utimesSync(old, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
  w.go();
  assert.equal(w.stages()['T-1'], 'done');
});

test('a ticket that throws is blocked and the batch still writes its summary and wakes the starter', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', deps: ['T-1'], actions: [ok('T-2')] }]);
  const dir = join(w.env.CLAUDE_PROJECTS, realpathSync(w.project).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(join(dir, 'bad.jsonl'), { recursive: true }); // a directory where a transcript should be: reading it throws
  utimesSync(join(dir, 'bad.jsonl'), new Date(Date.now() + 3600000), new Date(Date.now() + 3600000)); // newer than this run
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'blocked');
  assert.match(w.summary(), /T-1 \| blocked \| error: /);
  assert.ok(w.calls().includes('kill xT-1_1'));
  assert.equal(w.calls().filter((l) => l.startsWith('send tstarter Batch b1:')).length, 1);
});

test('a reviewer must write .tsf/review.md: a fix round asks for it, and writing it is in scope', () => {
  const w = world([{ id: 'T-1', role: 'reviewer', actions: [ok('T-1'), { writes: { '.tsf/review.md': 'No defects' } }] }]);
  w.go();
  const sends = w.calls().filter((l) => l.startsWith('send xT-1_1'));
  assert.ok(sends.some((l) => l.includes('.tsf/review.md')));
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| scope clean/);
});

// Reviewer scenario: action 0 = its first turn (tests), then one action per message from the batch.
const tests = (id) => ({ writes: { [`test/${id.toLowerCase()}.review.test.mjs`]: 'adversarial' } });
const findings = (id, text) => ({ writes: { [`.tsf/review/${id}.md`]: text } });
const live = (w) => JSON.parse(readFileSync(join(w.project, '.tsf/batches/b1.live.json'), 'utf8'));

test('review=yes: the Reviewer starts with the Worker and a clean review closes the ticket', () => {
  const w = world([{ id: 'T-1', review: true, actions: [ok('T-1')], reviewActions: [tests('T-1'), findings('T-1', 'No defects')] }]);
  w.go();
  const c = w.calls();
  assert.ok(c.some((l) => l.startsWith('run') && l.includes('reviewer [batch b1 T-1.review]')), c.join('\n'));
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| scope clean, review passed \|/);
  assert.ok(c.includes('kill xT-1.review_1'));
  const r = live(w).rows[0];
  assert.equal(r.stage, 'done'); assert.equal(r.reviewer, 'xT-1.review_1'); assert.ok(live(w).ended);
});

test('review defects go to the same warm Worker, then the Reviewer re-checks', () => {
  const w = world([{ id: 'T-1', review: true, actions: [ok('T-1'), ok('T-1')],
    reviewActions: [tests('T-1'), findings('T-1', 'src/a.js:3 constructor breaks stats'), findings('T-1', 'No defects')] }]);
  w.go();
  const c = w.calls();
  assert.ok(c.some((l) => l.startsWith('send xT-1_1') && l.includes('constructor breaks stats')), c.join('\n'));
  assert.equal(c.filter((l) => l.startsWith('run') && l.includes('[batch b1 T-1]')).length, 1); // no fresh Worker
  assert.ok(c.some((l) => l.startsWith('send xT-1.review_1') && l.includes('Re-check only')));
  assert.match(w.summary(), /T-1 \| done \| scope clean, review passed after 1 fix round \|/);
});

test('defects left after 2 review rounds hold the ticket for the Lead; unanswered, it blocks', () => {
  const w = world([{ id: 'T-1', review: true, actions: [ok('T-1'), ok('T-1'), ok('T-1')],
    reviewActions: [tests('T-1'), findings('T-1', 'still broken'), findings('T-1', 'still broken 2'), findings('T-1', 'still broken 3')] }], { env: { BATCH_HOLD_MS: '300' } });
  w.go();
  assert.equal(w.stages()['T-1'], 'blocked');
  assert.match(w.summary(), /defects remain after 2 fix rounds/);
  assert.ok(w.calls().some((l) => /^send tstarter Lane b1 T-1 held: review: defects remain after 2 fix rounds/.test(l)), w.calls().join('\n'));
  assert.equal(w.calls().filter((l) => l.startsWith('send xT-1_1 Review found defects')).length, 2); // both rounds went to the same warm Worker
});

test('the live file tracks every row', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', deps: ['T-1'], actions: [ok('T-2')] }]);
  w.go();
  const s = live(w);
  assert.deepEqual(s.rows.map((r) => [r.ticket, r.stage]), [['T-1', 'done'], ['T-2', 'done']]);
  assert.ok(s.rows[0].started && s.rows[0].ended && s.rows[0].worker === 'xT-1_1');
});

test("parallel reviews: one ticket's Reviewer files are not another ticket's scope violation", () => {
  const w = world([
    { id: 'T-1', review: true, actions: [ok('T-1')], reviewActions: [tests('T-1'), findings('T-1', 'No defects')] },
    { id: 'T-2', actions: [{ writes: { 'T-2/out.txt': 'x', '.tsf/review/T-1.md': 'No defects', 'test/t-1.review.test.mjs': 'x' } }] }]);
  w.go();
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'done' });
  assert.ok(!w.calls().some((l) => l.includes('Scope check failed')), w.calls().join('\n'));
});

test('a chain on the same files keeps one warm Worker: the next ticket is sent to it, and each pays only its own turns', () => {
  const w = world([
    { id: 'T-1', writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'a' }, usd_tokens: 10000 }, { writes: { 'src/b.txt': 'b' }, usd_tokens: 20000 }] }, // the stub bills sends to the address's ticket
    { id: 'T-2', deps: ['T-1'], writes: ['src/**'] },
    { id: 'T-3', deps: ['T-1'], writes: ['T-3/**'], actions: [ok('T-3')] }, // a different file set: launched fresh as usual
  ]);
  assert.equal(w.go().status, 0);
  const c = w.calls();
  assert.ok(!c.some((l) => l.startsWith('run') && l.includes('[batch b1 T-2]')), c.join('\n'));
  const handoff = c.findIndex((l) => l.startsWith('send xT-1_1') && l.includes('[batch b1 T-2]'));
  assert.ok(handoff >= 0 && c.indexOf('kill xT-1_1') > handoff, c.join('\n'));
  assert.ok(c.some((l) => l.startsWith('run') && l.includes('[batch b1 T-3]')));
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'done', 'T-3': 'done' });
  const rows = JSON.parse(readFileSync(join(w.project, '.tsf/batches/b1.live.json'), 'utf8')).rows;
  assert.deepEqual(rows.slice(0, 2).map((r) => r.usd.toFixed(2)), ['0.10', '0.20']); // Sonnet output: $10 per million
});

test('a frontend ticket gets a UI Polisher pass instead of a Reviewer, then its gate runs again', () => {
  const w = world([{ id: 'T-1', role: 'frontend', gated: true, review: true, actions: [ok('T-1')], reviewActions: [ok('T-1')] }]);
  writeFileSync(join(w.env.STUB_DIR, 'scenario.json'), JSON.stringify({ 'T-1': [ok('T-1')], 'T-1.polish': [{ writes: { 'T-1/style.css': 'x' } }] }));
  assert.equal(w.go().status, 0);
  const c = w.calls();
  const polish = c.findIndex((l) => l.startsWith('run') && l.includes('ui-polisher') && l.includes('[batch b1 T-1.polish]'));
  assert.ok(polish >= 0, c.join('\n'));
  assert.ok(!c.some((l) => l.includes('[batch b1 T-1.review]')), 'no Reviewer for a frontend row');
  assert.ok(c.includes('kill xT-1.polish_1'));
  assert.equal(readFileSync(join(w.env.STUB_DIR, 'gate-T-1'), 'utf8').trim(), '2'); // gated before and after the polish
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.calls().find((l) => l.startsWith('send tstarter Batch b1:')), /Events: .*T-1 polished/); // its result reaches the Lead's digest
});

test("a dependency in another factory's lane counts once the shared board shows it done", () => {
  const ext = (stage) => (sh) => { sh('tickets/ticket.sh', 'open', 'X-9', 'w', 'other lane'); sh('tickets/ticket.sh', 'move', 'X-9', stage); };
  const done = world([{ id: 'T-1', deps: ['X-9'], actions: [ok('T-1')] }], { preBoard: ext('done') });
  assert.equal(done.go().status, 0);
  assert.equal(done.stages()['T-1'], 'done');
  const blocked = world([{ id: 'T-1', deps: ['X-9'], actions: [ok('T-1')] }], { preBoard: ext('blocked') });
  assert.equal(blocked.go().status, 0);
  assert.ok(!blocked.calls().some((l) => l.startsWith('run')));
  assert.match(blocked.summary(), /T-1 \| todo \| not started: waits on X-9/);
});

test("another lane's files are not this ticket's violations: factories share one folder", () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/out.txt': 'x', 'other/x.txt': 'from the other lane' } }] }]);
  writeFileSync(join(w.project, '.tsf/batches/b2.tsv'), 'ticket\tdepends-on\trole\twrites\tgated\tbrief\nX-1\t-\tworker\tother/**\tno\t.tsf/briefs/X.md\n');
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| scope clean/);
});

test('a factory with no space label finds the board through its parent tab', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }], { settings: { board: undefined }, env: { STUB_SPACE: 'testboard', STUB_LIVE: 'tfactory' } });
  const r = spawnSync('node', [join(HERE, 'batch.mjs'), 'b1', '--project', w.project, '--starter', 'tfactory'], { env: w.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.stages()['T-1'], 'done');
});

test("a frontend ticket that a plan's own UI-polish ticket follows skips the automatic polish pass", () => {
  const w = world([{ id: 'T-1', role: 'frontend', actions: [ok('T-1')] }, { id: 'T-2', role: 'ui-polisher', deps: ['T-1'], actions: [ok('T-2')] }]);
  assert.equal(w.go().status, 0);
  assert.ok(!w.calls().some((l) => l.includes('[batch b1 T-1.polish]')), w.calls().join('\n'));
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'done' });
});

test("a file someone else changed mid-build (the Lead folding in a change) is not the Worker's violation", () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/out.txt': 'x' }, foreign: { 'src/db.mjs': 'lead edit', '.tsf/notes.md': 'lead' } }] }]);
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| scope clean/);
});

test('a writing Bash command that names a file out of scope still counts as the Worker\'s', async () => {
  const { touchedBy } = await import('./batch.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'touch-')), f = join(dir, 't.jsonl');
  const use = (input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
  writeFileSync(f, [use({ command: "sed -i 's/a/b/' src/db.mjs" }), use({ command: 'grep -n x src/read.mjs' })].join('\n'));
  const mine = touchedBy(dir, [f]);
  assert.ok(mine('src/db.mjs'));
  assert.ok(!mine('src/read.mjs'), 'reading a file is not writing it');
});

test("a factory's blocked ticket messages the Lead at once", () => {
  const stray = { writes: { 'stray.txt': 'x' } };
  const w = world([{ id: 'T-1', actions: [stray, stray, stray, stray, stray] }], { env: { STUB_FACTORY: 'tfactory' } });
  const r = spawnSync('node', [join(HERE, 'batch.mjs'), 'b1', '--project', w.project, '--starter', 'tfactory'], { env: w.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(w.stages()['T-1'], 'blocked', r.stderr);
  assert.ok(w.calls().some((l) => /^send tlead Lane b1 T-1 blocked: .*have factory tfactory rerun/.test(l)), w.calls().join('\n'));
});

// Background runs: the test answers or steers like a Lead would while the lane runs.
async function background(w, starter = 'tstarter', lane = 'b1') {
  const { spawn } = await import('node:child_process');
  const p = spawn('node', [join(HERE, 'batch.mjs'), lane, '--project', w.project, '--starter', starter], { env: w.env, stdio: 'ignore' });
  return { p, exited: new Promise((r) => p.on('exit', (code, sig) => r(code ?? sig))) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { try { if (f()) return true; } catch {} } return false; };
const decide = (w, ...answer) => spawnSync('node', [join(HERE, 'batch.mjs'), 'decide', 'b1', 'T-1', ...answer, '--project', w.project], { env: w.env });

// A held ticket waits for the Lead's answer.
async function heldRun(answer) {
  const w = world([{ id: 'T-1', actions: [{ hang: true }, ok('T-1')] }], { settings: { budgets: { worker: { minutes: 0.01 } } }, env: { BATCH_HOLD_MS: '20000' } });
  const { exited } = await background(w);
  await until(() => w.calls().some((l) => l.includes('T-1 held')));
  assert.ok(w.calls().some((l) => l.startsWith('send tstarter Lane b1 T-1 held: over time') && l.includes('decide b1 T-1')), w.calls().join('\n'));
  decide(w, ...answer);
  assert.equal(await exited, 0);
  return w;
}

test('a held ticket that the Lead answers with retry goes back to the same warm Worker with its guidance', async () => {
  const w = await heldRun(['retry', 'reuse', 'the', 'cache']);
  assert.equal(w.stages()['T-1'], 'done');
  assert.ok(w.calls().some((l) => l.startsWith('send xT-1_1 The Lead says: reuse the cache')), w.calls().join('\n'));
  assert.ok(!w.calls().some((l) => l.startsWith('run') && l.includes('xT-1_2')), 'no fresh session');
});

test('a held ticket that the Lead allows is done, with the reason kept', async () => {
  const w = await heldRun(['allow']);
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /allowed by Lead after: over time/);
});

test('a retry the Lead orders one tier up starts a fresh session on that seat', async () => {
  const w = await heldRun(['retry', 'think', 'harder', '--role', 'worker-strong']);
  assert.equal(w.stages()['T-1'], 'done');
  const c = w.calls();
  assert.ok(c.includes('kill xT-1_1'));
  assert.ok(c.some((l) => /^run .*worker-strong \[batch b1 T-1\] .*The Lead says: think harder/.test(l)), c.join('\n'));
});

test('a shell command claims only the files it writes: `cp X /tmp/y` reads X', async () => {
  const { writeTargets, touchedBy } = await import('./batch.mjs');
  assert.deepEqual(writeTargets('cp CHANGE.md /tmp/scratch/CHANGE.md'), ['/tmp/scratch/CHANGE.md']);
  assert.deepEqual(writeTargets('cat src/a.js > /tmp/x && grep -n foo src/b.js 2>/dev/null'), ['/tmp/x']);
  assert.deepEqual(writeTargets("sed -i '' 's/a/b/;s/c/d/' src/db.mjs; echo hi | tee -a log.txt"), ['src/db.mjs', 'log.txt']);
  assert.deepEqual(writeTargets("perl -pi -e 's/x/y/' a.py b.py"), ['a.py', 'b.py']);
  assert.deepEqual(writeTargets('mv old.rs new.rs && rm -rf build'), ['old.rs', 'new.rs', 'build']);
  assert.deepEqual(writeTargets("cat > notes/plan.md <<'EOF'\nrm nothing.txt is text here? no: a heredoc body\nEOF").slice(0, 1), ['notes/plan.md']);
  const dir = mkdtempSync(join(tmpdir(), 'touch-')), f = join(dir, 't.jsonl');
  const use = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  writeFileSync(f, [use('cp CHANGE.md /tmp/x/CHANGE.md'), use('rm -r old')].join('\n'));
  const mine = touchedBy(dir, [f]);
  assert.ok(!mine('CHANGE.md'));
  assert.ok(mine('old/a.txt'), 'a directory it removed');
});

test("the Lead editing a file mid-build is not the Worker's violation, even a file the Worker copied", () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/out.txt': 'x' }, bash: ['cp CHANGE.md /tmp/x/CHANGE.md'], foreign: { 'CHANGE.md': 'lead edit' } }] }]);
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.ok(!w.calls().some((l) => l.includes('Scope check failed')), w.calls().join('\n'));
  const task = w.calls().find((l) => l.startsWith('run'));
  assert.match(task, /Never move the ticket on the board or commit/);
});

test('gate tests missing: the project tests run first, then the Lead is asked; allow finishes it ungated', async () => {
  const w = world([{ id: 'T-1', gated: 'missing', actions: [ok('T-1')] }], { env: { BATCH_HOLD_MS: '20000' }, settings: { test: 'echo own tests ok' } });
  const { exited } = await background(w);
  assert.ok(await until(() => w.calls().some((l) => l.includes('T-1 held: gate tests missing'))), w.calls().join('\n'));
  assert.ok(w.calls().some((l) => /T-1 held: gate tests missing .*its tests pass \(echo own tests ok\)/.test(l)));
  decide(w, 'allow');
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /allowed by Lead after: gate tests missing/);
});

test('gate tests written under the project path, not the board id, are found and run', () => {
  const w = world([{ id: 'T-1', gated: true, gateKey: 'project', gateFails: 1, actions: [ok('T-1'), ok('T-1')] }]);
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| gate passed/);
  assert.equal(readFileSync(join(w.env.STUB_DIR, 'gate-T-1'), 'utf8').trim(), '2');
});

test('a stopped lane (SIGTERM) ends its Workers, puts in-flight rows back to todo and tells the Lead', async () => {
  const w = world([{ id: 'T-1', actions: [{ hang: true }] }, { id: 'T-2', deps: ['T-1'] }]);
  const { p, exited } = await background(w);
  assert.ok(await until(() => w.stages()['T-1'] === 'doing'));
  p.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.deepEqual(w.stages(), { 'T-1': 'todo', 'T-2': 'todo' });
  assert.ok(w.calls().includes('kill xT-1_1'));
  const s = live(w);
  assert.equal(s.stage, 'stopped'); assert.ok(s.ended); assert.equal(s.rows[0].stage, 'stopped');
  assert.match(w.summary(), /T-1 \| todo \| stopped mid-build \(SIGTERM\)/);
  assert.ok(w.calls().some((l) => /^send tstarter Batch b1: 0\/2 done.*Stopped \(SIGTERM\)/.test(l)), w.calls().join('\n'));
  assert.ok(!existsSync(join(w.project, '.tsf/batches/b1.pid')));
});

test('a second run of the same lane refuses while the first is live; a dead one is taken over', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }]);
  const pid = join(w.project, '.tsf/batches/b1.pid');
  writeFileSync(pid, String(process.pid)); // a live process holds the lane
  const r = w.go();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lane b1 is already running \(pid \d+\)/);
  assert.equal(w.stages()['T-1'], 'todo');
  writeFileSync(pid, String(spawnSync('true').pid)); // a run that died
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
});

test('a dependency in flight in a dead lane alerts the Lead once, and the lane goes on once it is resolved', async () => {
  const w = world([{ id: 'T-1', deps: ['X-9'], actions: [ok('T-1')] }], { env: { STUB_LIVE: 'xorphan_1' },
    preBoard: (sh) => { sh('tickets/ticket.sh', 'open', 'X-9', 'w', 'other lane'); sh('tickets/ticket.sh', 'move', 'X-9', 'doing', 'xorphan_1'); } });
  // the other lane's process is gone, though its orphaned Worker still runs
  writeFileSync(join(w.project, '.tsf/batches/b2.live.json'), JSON.stringify({ batch: 'b2', pid: spawnSync('true').pid, started: Date.now(), updated: Date.now(), ended: null, rows: [{ ticket: 'X-9', stage: 'building' }] }));
  const { exited } = await background(w);
  assert.ok(await until(() => w.calls().some((l) => /^send tstarter Lane b1 stalled: T-1 wait on X-9, which is doing on the board with no live owner \(lane b2 is not running\)/.test(l))), w.calls().join('\n'));
  await sleep(500);
  w.sh('tickets/ticket.sh', 'move', 'X-9', 'done');
  assert.equal(await exited, 0);
  assert.equal(w.calls().filter((l) => l.includes('stalled')).length, 1);
  assert.equal(w.stages()['T-1'], 'done');
});

test('the Lead can message a Worker mid-build: its extra turn ends at a check point and the ticket finishes', async () => {
  const w = world([{ id: 'T-1', actions: [{ hang: true }, ok('T-1')] }]);
  const { exited } = await background(w);
  assert.ok(await until(() => w.stages()['T-1'] === 'doing'));
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-1_1', 'Lead: also handle empty input'], { env: w.env });
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.equal(w.calls().filter((l) => l.startsWith('run')).length, 1);
  assert.match(w.summary(), /T-1 \| done \| scope clean/);
});

test('a Worker that asked its factory a question is waited for, not checked', async () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/half.txt': 'x' }, bash: ['hc send tstarter "CSV or JSON?"'], ready: false }, ok('T-1')] }]);
  const { exited } = await background(w);
  assert.ok(await until(() => w.stages()['T-1'] === 'doing'));
  assert.match(w.calls().find((l) => l.startsWith('run')), /If a line of your brief or spec is vague or contradictory, or you are stuck, hc send tstarter one line and wait for its answer; never encode a guess in code or tests/);
  await sleep(800);
  assert.equal(w.stages()['T-1'], 'doing', 'not finished while its question is open');
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-1_1', 'JSON'], { env: w.env });
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-1'], 'done');
});

test('lane events reach the Lead digested: several in one message, ending with the result', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', deps: ['T-1'], actions: [ok('T-2')] }], { env: { STUB_FACTORY: 'tfactory', BATCH_DIGEST_MS: '60000' } });
  spawnSync('node', [join(HERE, 'batch.mjs'), 'b1', '--project', w.project, '--starter', 'tfactory'], { env: w.env, encoding: 'utf8', timeout: 60000 });
  const toLead = w.calls().filter((l) => l.startsWith('send tlead'));
  assert.equal(toLead.length, 1, toLead.join('\n'));
  assert.match(toLead[0], /^send tlead Lane b1: T-1 started \(worker xT-1_1\); T-1 done \(scope clean\); T-2 started \(worker xT-2_1\); T-2 done \(scope clean\); Batch b1: 2\/2 done/);
  assert.ok(w.calls().some((l) => l.startsWith('send tfactory Batch b1: 2/2 done')));
});

// Worktree lanes: the project is a git repo.
const seed = { 'README.md': 'seed\n', 'shared.txt': 'base\n' };
const gitIn = (w, ...a) => { const r = spawnSync('git', ['-C', w.project, ...a], { env: w.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const branchWith = (w, name, rel, text, msg) => { gitIn(w, 'checkout', '-q', '-b', name); writeFileSync(join(w.project, rel), text); gitIn(w, 'commit', '-qam', msg); gitIn(w, 'checkout', '-q', 'main'); };

test('in a git repo the lane builds in its own worktree and commits each ticket on lane/<id>; main is untouched', () => {
  const w = world([{ id: 'T-1', writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'a' } }] }, { id: 'T-2', writes: ['lib/**'], actions: [{ writes: { 'lib/b.txt': 'b' } }] }], { git: seed });
  assert.equal(w.go().status, 0);
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'done' });
  assert.ok(w.calls().filter((l) => l.startsWith('run')).every((l) => l.includes(`--cwd ${w.lane}`)));
  assert.match(gitIn(w, 'log', '--format=%s', 'lane/b1'), /^T-\d: T-\d\nT-\d: T-\d\nseed$/);
  assert.equal(gitIn(w, 'show', 'lane/b1:src/a.txt'), 'a');
  assert.equal(gitIn(w, 'log', '--format=%s', 'main'), 'seed');
  assert.ok(!existsSync(join(w.project, 'src/a.txt')));
  assert.match(readFileSync(join(w.project, '.git/info/exclude'), 'utf8'), /^\/\.tsf\/lanes\/$/m);
  assert.ok(w.calls().some((l) => l.startsWith('send tstarter Batch b1: 2/2 done') && l.includes('Ready to merge: git merge --no-ff lane/b1')));
});

test("a row that depends on another lane's ticket merges that lane's branch first", () => {
  const w = world([{ id: 'T-1', deps: ['X-1'], writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'a' } }] }], { git: seed,
    preBoard: (sh) => { sh('tickets/ticket.sh', 'open', 'X-1', 'w', 'other'); sh('tickets/ticket.sh', 'move', 'X-1', 'done'); } });
  writeFileSync(join(w.project, '.tsf/batches/b2.tsv'), 'ticket\tdepends-on\trole\twrites\tgated\tbrief\nX-1\t-\tworker\tlib/**\tno\t.tsf/briefs/X.md\n');
  mkdirSync(join(w.project, 'lib'));
  gitIn(w, 'checkout', '-q', '-b', 'lane/b2'); writeFileSync(join(w.project, 'lib/x.txt'), 'x'); gitIn(w, 'add', 'lib'); gitIn(w, 'commit', '-qm', 'X-1: other lane'); gitIn(w, 'checkout', '-q', 'main');
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.ok(existsSync(join(w.lane, 'lib/x.txt')), 'the other lane\'s work is in this worktree');
  assert.match(gitIn(w, 'log', '--format=%s', 'lane/b1'), /X-1: other lane/);
});

test('a merge conflict goes to a resolver Worker; resolved, the row builds', () => {
  const w = world([{ id: 'T-1', deps: ['X-1'], writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'a' } }] }], { git: seed,
    preBoard: (sh) => { sh('tickets/ticket.sh', 'open', 'X-1', 'w', 'other'); sh('tickets/ticket.sh', 'move', 'X-1', 'done'); } });
  writeFileSync(join(w.project, '.tsf/batches/b2.tsv'), 'ticket\tdepends-on\trole\twrites\tgated\tbrief\nX-1\t-\tworker\tshared.txt\tno\t.tsf/briefs/X.md\n');
  branchWith(w, 'lane/b1', 'shared.txt', 'ours\n', 'ours'); branchWith(w, 'lane/b2', 'shared.txt', 'theirs\n', 'X-1: theirs');
  const sc = JSON.parse(readFileSync(join(w.env.STUB_DIR, 'scenario.json'), 'utf8'));
  writeFileSync(join(w.env.STUB_DIR, 'scenario.json'), JSON.stringify({ ...sc, 'T-1.merge': [{ writes: { 'shared.txt': 'ours and theirs\n' } }] }));
  assert.equal(w.go().status, 0);
  assert.ok(w.calls().some((l) => l.startsWith('run') && l.includes('[batch b1 T-1.merge] Resolve the merge conflict from merging lane/b2') && l.includes('shared.txt')));
  assert.equal(w.stages()['T-1'], 'done');
  assert.equal(gitIn(w, 'show', 'lane/b1:shared.txt'), 'ours and theirs');
});

test('a merge conflict the resolver leaves unresolved is aborted and held for the Lead', () => {
  const w = world([{ id: 'T-1', deps: ['X-1'], writes: ['src/**'], actions: [ok('T-1')] }], { git: seed, env: { BATCH_HOLD_MS: '300' },
    preBoard: (sh) => { sh('tickets/ticket.sh', 'open', 'X-1', 'w', 'other'); sh('tickets/ticket.sh', 'move', 'X-1', 'done'); } });
  writeFileSync(join(w.project, '.tsf/batches/b2.tsv'), 'ticket\tdepends-on\trole\twrites\tgated\tbrief\nX-1\t-\tworker\tshared.txt\tno\t.tsf/briefs/X.md\n');
  branchWith(w, 'lane/b1', 'shared.txt', 'ours\n', 'ours'); branchWith(w, 'lane/b2', 'shared.txt', 'theirs\n', 'X-1: theirs');
  assert.equal(w.go().status, 0);
  assert.ok(w.calls().some((l) => /^send tstarter Lane b1 T-1 held: merge conflict with lane\/b2 not resolved in shared\.txt/.test(l)), w.calls().join('\n'));
  assert.equal(w.stages()['T-1'], 'blocked');
  assert.ok(!w.calls().some((l) => l.startsWith('run') && l.includes('[batch b1 T-1]')), 'no build on a half-merged tree');
  assert.notEqual(spawnSync('git', ['-C', w.lane, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 0, 'the merge was aborted');
});

// ----- swarm: work stealing, the floater, elastic scaling, the notes board, race rows -----
const addScenario = (w, more) => { const f = join(w.env.STUB_DIR, 'scenario.json'); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), ...more })); };
const otherLane = (w) => { // lane b2: X-1 keeps its one Worker busy, X-2 is ready and waiting for a slot
  writeFileSync(join(w.project, '.tsf/batches/b2.tsv'), 'ticket\tdepends-on\trole\twrites\tgated\tbrief\nX-1\t-\tworker\tX-1/**\tno\t.tsf/briefs/X.md\nX-2\t-\tworker\tX-2/**\tno\t.tsf/briefs/X.md\n');
  addScenario(w, { 'X-1': [{ hang: true }, ok('X-1')], 'X-2': [ok('X-2')] });
};
const owner = (w, t) => w.sh('tickets/ticket.sh', 'ls').stdout.split('\n').find((l) => l.startsWith(t + '\t'))?.split('\t')[2];

test("an idle lane steals a ready row from another live lane, and the owner counts it done", async () => {
  const w = world([{ id: 'T-1', deps: ['X-2'], actions: [ok('T-1')] }], { settings: { workers: 1 } });
  otherLane(w);
  const b2 = await background(w, 'tstarter', 'b2');
  assert.ok(await until(() => w.stages()['X-1'] === 'doing'));
  const b1 = await background(w);
  assert.equal(await b1.exited, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.equal(owner(w, 'X-2'), 'lane-b1', 'the board shows who built it');
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xX-1_1', 'go on'], { env: w.env });
  assert.equal(await b2.exited, 0);
  const c = w.calls();
  assert.ok(c.some((l) => l.startsWith('run') && l.includes('[batch b1 X-2]')) && !c.some((l) => l.startsWith('run') && l.includes('[batch b2 X-2]')), c.join('\n'));
  assert.match(readFileSync(join(w.project, '.tsf/batches/b2.summary.md'), 'utf8'), /X-2 \| done \| done by lane b1/);
  assert.match(w.summary(), /X-2 \| done \| from lane b2: scope clean/);
});

test('the floater is off unless settings turn it on; on, its one Worker steals from any live lane', async () => {
  const off = world([]);
  const r = spawnSync('node', [join(HERE, 'batch.mjs'), 'floater', '--project', off.project, '--starter', 'tstarter'], { env: off.env, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /floater is off/);
  const w = world([], { settings: { workers: 1, floater: true } });
  otherLane(w);
  const b2 = await background(w, 'tstarter', 'b2');
  assert.ok(await until(() => w.stages()['X-1'] === 'doing'));
  const f = await background(w, 'tstarter', 'floater');
  assert.equal(await f.exited, 0);
  assert.equal(w.stages()['X-2'], 'done');
  assert.ok(w.calls().some((l) => l.startsWith('run') && l.includes('[batch floater X-2]')));
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xX-1_1', 'go on'], { env: w.env });
  assert.equal(await b2.exited, 0);
});

test('elastic: when capacity frees up mid-run the lane starts more Workers; with elastic off it keeps its first count', async () => {
  for (const elastic of [true, false]) {
    const w = world([{ id: 'T-1', actions: [{ hang: true }, ok('T-1')] }, { id: 'T-2', actions: [ok('T-2')] }, { id: 'T-3', actions: [ok('T-3')] }], { settings: { elastic } });
    writeFileSync(join(w.env.STUB_DIR, 'capacity'), '1');
    const { exited } = await background(w);
    assert.ok(await until(() => w.stages()['T-1'] === 'doing'));
    writeFileSync(join(w.env.STUB_DIR, 'capacity'), '3');
    await sleep(1000);
    spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-1_1', 'go on'], { env: w.env });
    assert.equal(await exited, 0);
    const c = w.calls(), run2 = c.findIndex((l) => l.startsWith('run') && l.includes('[batch b1 T-2]')), kill1 = c.indexOf('kill xT-1_1');
    assert.equal(run2 < kill1, elastic, c.join('\n'));
    assert.deepEqual(Object.values(w.stages()), ['done', 'done', 'done']);
  }
});

test('the notes board: Workers are pointed at it, writing it is no violation, and the lane keeps it capped', () => {
  const old = Array.from({ length: 60 }, (_, i) => `src/x.mjs:${i} old fact ${i}`).join('\n');
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/out.txt': 'x', '.tsf/notes.md': `${old}\nsrc/db.mjs:12 ids are strings\n` } }] }], { settings: { notes: 50 } });
  assert.equal(w.go().status, 0);
  assert.match(w.summary(), /T-1 \| done \| scope clean/);
  assert.ok(w.calls().find((l) => l.startsWith('run')).includes(`Before reading code, read ${join(w.project, '.tsf/notes.md')}`));
  const notes = readFileSync(join(w.project, '.tsf/notes.md'), 'utf8').trim().split('\n');
  assert.equal(notes.length, 50);
  assert.equal(notes.at(-1), 'src/db.mjs:12 ids are strings');
});

test('a race row runs two Workers in scratch worktrees; the first to pass wins and lands, the other is killed, both are paid for', () => {
  const w = world([{ id: 'T-1', race: true }], { git: seed });
  addScenario(w, { 'T-1.race1': [{ hang: true }], 'T-1.race2': [{ writes: { 'T-1/out.txt': 'two' }, usd_tokens: 1000 }] });
  assert.equal(w.go().status, 0);
  const c = w.calls();
  assert.ok(c.some((l) => l.startsWith('run') && l.includes(`--cwd ${w.lane}.race-T-1-1`) && l.includes('[batch b1 T-1.race1]')), c.join('\n'));
  assert.ok(c.includes('kill xT-1.race1_1'));
  assert.equal(w.stages()['T-1'], 'done');
  assert.match(w.summary(), /T-1 \| done \| won the race \(Worker 2 of 2\)/);
  assert.equal(gitIn(w, 'show', 'lane/b1:T-1/out.txt'), 'two');
  assert.ok(!existsSync(`${w.lane}.race-T-1-1`) && !existsSync(`${w.lane}.race-T-1-2`), 'scratch worktrees removed');
  assert.ok(live(w).rows[0].usd > 0);
});

test('a ticket commit holds only its own files, even while a parallel row writes the same area', async () => {
  const w = world([{ id: 'T-1', writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'a' } }] },
    { id: 'T-2', writes: ['src/**'], actions: [{ writes: { 'src/b.txt': 'half' }, hang: true }, { writes: { 'src/b.txt': 'b' } }] }], { git: seed });
  const { exited } = await background(w);
  assert.ok(await until(() => w.stages()['T-1'] === 'done'));
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-2_1', 'go on'], { env: w.env });
  assert.equal(await exited, 0);
  const sha = (t) => gitIn(w, 'log', '--format=%H %s', 'lane/b1').split('\n').find((l) => l.includes(` ${t}: `)).split(' ')[0];
  assert.equal(gitIn(w, 'show', '--name-only', '--format=', sha('T-1')), 'src/a.txt');
  assert.equal(gitIn(w, 'show', '--name-only', '--format=', sha('T-2')), 'src/b.txt');
});

// ----- quality pass -----
test('the review column: no, light, full (yes in old tsvs) and full-codex', () => {
  const kinds = parseTsv(['no', 'light', 'full', 'yes', 'full-codex', ''].map((v, i) => `T-${i}\t-\tworker\tsrc/**\tno\tb\t${v}`).join('\n')).map((r) => r.review);
  assert.deepEqual(kinds, [false, 'light', 'full', 'full', 'full-codex', false]);
});

test('verify runs the whole suite once: PASS, or FAIL naming the lane that owns each failing file', () => {
  const w = world([{ id: 'T-1', writes: ['src/**'] }], { settings: { test: 'false', suite: 'echo all good' } });
  const verify = () => spawnSync('node', [join(HERE, 'batch.mjs'), 'verify', '--project', w.project], { env: w.env, encoding: 'utf8' });
  let r = verify();
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^PASS: echo all good/);
  for (const f of ['src/a.test.js', 'lib/b.test.js']) { mkdirSync(dirname(join(w.project, f)), { recursive: true }); writeFileSync(join(w.project, f), ''); }
  writeFileSync(join(w.project, '.tsf/settings.json'), JSON.stringify({ board: 'testboard', suite: 'echo "ok 1 - fine"; echo "not ok 2 - src/a.test.js"; echo "FAIL lib/b.test.js > adds"; exit 1' }));
  r = verify();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL \(exit 1\)/); assert.match(r.stdout, /^lane b1: src\/a\.test\.js$/m); assert.match(r.stdout, /^unowned: lib\/b\.test\.js$/m);
  assert.match(readFileSync(join(w.project, '.tsf/verify.txt'), 'utf8'), /not ok 2 - src\/a\.test\.js/);
});

test('review=light: one Sonnet pass once the build is green, no tests, one fix round, then a hold', () => {
  const w = world([{ id: 'T-1', review: 'light', actions: [ok('T-1'), ok('T-1')], reviewActions: [findings('T-1', 'a.js:1 wrong sum'), findings('T-1', 'a.js:1 still wrong')] }], { env: { BATCH_HOLD_MS: '300' } });
  w.go();
  const c = w.calls(), runs = c.filter((l) => l.startsWith('run'));
  assert.match(runs[0], /\[batch b1 T-1\]/); assert.doesNotMatch(runs[0], /adversarial/);
  assert.match(runs[1], /reviewer-light \[batch b1 T-1\.review\] .*its build is green.*write no tests/);
  assert.equal(c.filter((l) => l.startsWith('send xT-1_1 Review found defects')).length, 1);
  assert.ok(c.some((l) => /^send tstarter Lane b1 T-1 held: review: defects remain after 1 fix round /.test(l)), c.join('\n'));
});

test('review=full-codex uses the Codex Reviewer; with codex missing, Opus reviews and the digest says so', () => {
  for (const missing of [false, true]) {
    const w = world([{ id: 'T-1', review: 'full-codex', actions: [ok('T-1')], reviewActions: [tests('T-1'), findings('T-1', 'No defects')] }], { env: missing ? { STUB_NO: 'reviewer-codex' } : {} });
    w.go();
    const c = w.calls();
    assert.ok(c.some((l) => l.startsWith('run') && l.includes(`${missing ? 'team-reviewer' : 'reviewer-codex'} [batch b1 T-1.review]`)), c.join('\n'));
    assert.equal(c.some((l) => l.includes('codex Reviewer unavailable')), missing);
    assert.match(w.summary(), /T-1 \| done \| scope clean, review passed \|/);
  }
});

test('missing gate tests while the Test writer waits on its question: the lane waits, not holds', async () => {
  const w = world([{ id: 'T-1', gated: 'missing', actions: [ok('T-1')] }]);
  const tdir = join(w.env.CLAUDE_PROJECTS, realpathSync(w.project).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const use = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  writeFileSync(join(tdir, 'tester.jsonl'), [use('sh gate.sh testboard T-1 --path'), use('hc send tbuilder "T-1: is an empty CSV an error?"')].join('\n') + '\n');
  const { exited } = await background(w);
  assert.ok(await until(() => live(w).rows[0].note === 'gate tests wait on a Test writer question'));
  const g = spawnSync('sh', [join(ORCH, 'gate/gate.sh'), 'testboard', 'T-1', '--path'], { env: w.env, encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(g, 'run.sh'), 'exit 0\n'); // answered: the Test writer finishes its tests
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.ok(!w.calls().some((l) => l.includes('held')), w.calls().join('\n'));
});

test('readability pass at lane end: a green simplification is one commit; a red one, or a file outside the diff, is undone', () => {
  for (const breaks of [false, true]) {
    const w = world([{ id: 'T-1', writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'messy' } }] }], { git: seed, settings: { test: '! grep -q broken src/a.txt', readability: ['b1'] } });
    writeFileSync(join(w.env.STUB_DIR, 'scenario.json'), JSON.stringify({ 'T-1': [{ writes: { 'src/a.txt': 'messy' } }], 'lane.readability': [{ writes: { 'src/a.txt': breaks ? 'broken' : 'simple', 'README.md': 'stray' } }] }));
    assert.equal(w.go().status, 0);
    assert.ok(w.calls().some((l) => l.startsWith('run') && l.includes('[batch b1 lane.readability]')));
    assert.equal(gitIn(w, 'log', '--format=%s', 'lane/b1').split('\n')[0], breaks ? 'T-1: T-1' : 'b1: readability');
    assert.equal(readFileSync(join(w.lane, 'src/a.txt'), 'utf8'), breaks ? 'messy' : 'simple');
    assert.equal(readFileSync(join(w.lane, 'README.md'), 'utf8'), 'seed\n');
    assert.ok(w.calls().some((l) => l.includes(breaks ? 'readability undone' : 'readability: 1 file simplified') && l.includes('Ready to merge')), w.calls().join('\n'));
  }
});

// ----- the factory as the lane's senior developer -----
const cli = (w, ...a) => spawnSync('node', [join(HERE, 'batch.mjs'), ...a, '--project', w.project], { env: w.env, encoding: 'utf8' });
const put = (w, rel, text) => { mkdirSync(dirname(join(w.project, rel)), { recursive: true }); writeFileSync(join(w.project, rel), text); };

test('a builder row: no Worker, the factory builds it and says ready; failures go back to it; a parallel row runs meanwhile, dependents after', async () => {
  const w = world([{ id: 'T-1', role: 'builder', writes: ['core/**'] }, { id: 'T-2', writes: ['side/**'], actions: [{ writes: { 'side/a.txt': 'x' } }] },
    { id: 'T-3', deps: ['T-1'], writes: ['dep/**'], actions: [{ writes: { 'dep/a.txt': 'x' } }] }], { env: { STUB_FACTORY: 'tfactory', BATCH_DIGEST_MS: '0' } });
  const { exited } = await background(w, 'tfactory');
  assert.ok(await until(() => w.calls().some((l) => l.startsWith('send tfactory [batch b1 T-1] Row T-1 is yours to build') && l.includes('batch.mjs ready b1 T-1'))), w.calls().join('\n'));
  assert.ok(await until(() => w.stages()['T-2'] === 'done'), 'the parallel row finishes while the factory builds');
  assert.ok(await until(() => w.calls().some((l) => /^send tfactory Lane b1 rows: .*T-2 done/.test(l))), 'the factory hears of landed rows');
  assert.equal(w.stages()['T-3'], 'todo');
  assert.ok(!w.calls().some((l) => l.startsWith('run') && l.includes('[batch b1 T-1]')));
  put(w, 'core/a.txt', 'core'); put(w, 'stray.txt', 'oops');
  cli(w, 'ready', 'b1', 'T-1');
  assert.ok(await until(() => w.calls().some((l) => l.startsWith('send tfactory [batch b1 T-1] Scope check failed: stray.txt') && l.includes('When done, run:'))), w.calls().join('\n'));
  rmSync(join(w.project, 'stray.txt'));
  cli(w, 'ready', 'b1', 'T-1');
  assert.equal(await exited, 0);
  assert.deepEqual(w.stages(), { 'T-1': 'done', 'T-2': 'done', 'T-3': 'done' });
  assert.ok(!w.calls().some((l) => l === 'kill tfactory'), 'the lane never kills its factory');
});

test('batch.mjs add: the running lane starts the new row; a duplicate id or writes over a running row are refused', async () => {
  const w = world([{ id: 'T-1', role: 'builder', writes: ['core/**'] }, { id: 'T-2', writes: ['side/**'], actions: [{ writes: { 'side/a.txt': 'x' } }] }], { env: { STUB_FACTORY: 'tfactory' } });
  const sc = join(w.env.STUB_DIR, 'scenario.json');
  writeFileSync(sc, JSON.stringify({ ...JSON.parse(readFileSync(sc, 'utf8')), 'T-9': [{ writes: { 'extra/a.txt': 'x' } }] }));
  const { exited } = await background(w, 'tfactory');
  assert.ok(await until(() => live(w).rows.find((r) => r.ticket === 'T-1')?.started));
  let r = cli(w, 'add', 'b1', 'T-2', '--writes', 'x/**', '--brief', '/briefs/T-2.md');
  assert.equal(r.status, 1); assert.match(r.stderr, /T-2 already exists in lane b1/);
  r = cli(w, 'add', 'b1', 'T-8', '--writes', 'core/sub/x.js', '--brief', '/briefs/T-8.md');
  assert.equal(r.status, 1); assert.match(r.stderr, /overlap running T-1/);
  writeFileSync(join(w.project, '.tsf/briefs/T-9.md'), '# T-9\n');
  r = cli(w, 'add', 'b1', 'T-9', '--role', 'worker', '--writes', 'extra/**', '--brief', '.tsf/briefs/T-9.md');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /added; the lane starts it/);
  assert.ok(await until(() => w.stages()['T-9'] === 'done'), w.calls().join('\n'));
  assert.ok(w.calls().some((l) => l.startsWith('run') && l.includes('[batch b1 T-9]')));
  put(w, 'core/a.txt', 'core');
  cli(w, 'ready', 'b1', 'T-1');
  assert.equal(await exited, 0);
  assert.match(w.summary(), /T-9 \| done/);
});

test('graph knob: off and auto on a small repo run nothing; on builds the graph at lane start and after each commit, and points Workers at it', () => {
  for (const graph of ['off', 'auto', 'on']) {
    const w = world([{ id: 'T-1', writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'a' } }] }], { git: seed, settings: { graph } });
    const bin = join(w.env.STUB_DIR, 'bin'), log = join(w.env.STUB_DIR, 'graphify.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'graphify'), `#!/bin/sh\necho "$GRAPHIFY_BACKEND $GRAPHIFY_QUERY_LOG_DISABLE $* $(git log -1 --format=%s)" >> ${log}\n`, { mode: 0o755 });
    w.env.PATH = `${bin}:${process.env.PATH}`;
    assert.equal(w.go().status, 0);
    const runs = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const task = w.calls().find((l) => l.startsWith('run'));
    if (graph !== 'on') { assert.deepEqual(runs, [], graph); assert.doesNotMatch(task, /graphify/); continue; }
    assert.deepEqual(runs, ['none 1 update . seed', 'none 1 update . T-1: T-1']);
    assert.match(task, /use `graphify explain <symbol>` or `graphify query --context call "<question>"`/);
    assert.match(readFileSync(join(w.project, '.git/info/exclude'), 'utf8'), /^\/graphify-out\/$/m);
  }
});

test('a lane starts before its briefs exist: a row waits for its brief file, then builds; one alert if it is late', async () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/a.txt': 'x' } }] }, { id: 'T-2', unbriefed: true, actions: [{ writes: { 'T-2/a.txt': 'x' } }] }],
    { env: { BATCH_BRIEF_MS: '300', BATCH_DIGEST_MS: '0' } });
  const { exited } = await background(w, 'tstarter');
  assert.ok(await until(() => w.stages()['T-1'] === 'done'));
  assert.ok(await until(() => w.calls().some((l) => l.includes('T-2 still waits for its brief'))), w.calls().join('\n'));
  assert.ok(!w.calls().some((l) => l.startsWith('run') && l.includes('[batch b1 T-2]')), 'no Worker before the brief');
  writeFileSync(join(w.project, '.tsf/briefs/T-2.md'), '# T-2\n');
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-2'], 'done');
  assert.equal(w.calls().filter((l) => l.includes('still waits for its brief')).length, 1);
});

// ----- explicit done, the idle nudge and alert, the stall watchdog, isolated rows, routing -----
test('a frontend Worker that ends its turn with an hc send report still finishes through ready (T-12)', () => {
  const w = world([{ id: 'T-1', role: 'frontend', actions: [{ writes: { 'T-1/out.txt': 'x' }, bash: ['hc send tstarter "T-1 done, all tests pass"'] }] }]);
  assert.equal(w.go().status, 0);
  assert.equal(w.stages()['T-1'], 'done');
  assert.ok(w.calls().find((l) => l.startsWith('run') && l.includes('[batch b1 T-1]')).includes(`When it is built and its targeted tests pass, run: node ${join(HERE, 'batch.mjs')} ready b1 T-1 --project ${w.project}`));
});

test('idle with no ready: one nudge, then one alert to the Lead, and ready afterwards finishes the row', async () => {
  const w = world([{ id: 'T-1', actions: [{ writes: { 'T-1/out.txt': 'x' }, reply: 'I think it is finished', ready: false }, { ready: false }] }], { env: { BATCH_NUDGE_MS: '300', BATCH_ALERT_MS: '300' } });
  const { exited } = await background(w);
  assert.ok(await until(() => w.calls().some((l) => l.startsWith('send tstarter Lane b1: T-1 idle'))), w.calls().join('\n'));
  await sleep(800);
  const c = w.calls(), alerts = c.filter((l) => l.startsWith('send tstarter Lane b1: T-1 idle'));
  assert.equal(c.filter((l) => l.startsWith('send xT-1_1 If T-1 is built and its targeted tests pass, run:')).length, 1, c.join('\n'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /no ready; last words: I think it is finished/);
  assert.equal(w.stages()['T-1'], 'doing', 'idle is not done');
  cli(w, 'ready', 'b1', 'T-1');
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-1'], 'done');
});

test('the stall watchdog names a row whose stage and transcript stop moving, once', async () => {
  const w = world([{ id: 'T-1', actions: [{ hang: true, reply: 'running the slow suite' }, ok('T-1')] }], { env: { BATCH_STALL_MS: '400' } });
  const { exited } = await background(w);
  assert.ok(await until(() => w.calls().some((l) => l.startsWith('send tstarter Lane b1: T-1 stalled'))), w.calls().join('\n'));
  await sleep(1000);
  const s = w.calls().filter((l) => l.startsWith('send tstarter Lane b1: T-1 stalled'));
  assert.equal(s.length, 1);
  assert.match(s[0], /stage building, .*session xT-1_1; last words: running the slow suite/);
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-1_1', 'go on'], { env: w.env });
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-1'], 'done');
});

test("isolate: the row builds and tests in its own worktree, a sibling's half-done file cannot fail it, and both land in the lane", async () => {
  const w = world([{ id: 'T-1', isolate: true, writes: ['src/**'], actions: [{ writes: { 'src/a.txt': 'a' }, foreign: { 'src/sub/b.txt': 'by a subagent' } }] },
    { id: 'T-2', writes: ['lib/**'], actions: [{ writes: { 'lib/b.txt': 'broken' }, hang: true }, { writes: { 'lib/b.txt': 'b' } }] }],
  { git: seed, settings: { test: '! grep -rqs broken lib' } });
  const { exited } = await background(w);
  assert.ok(await until(() => w.stages()['T-1'] === 'done'), w.calls().join('\n'));
  assert.ok(w.calls().find((l) => l.startsWith('run') && l.includes('[batch b1 T-1]')).includes(`--cwd ${w.lane}.t/T-1 `));
  assert.ok(await until(() => live(w).rows[0].note === 'tests passed'), JSON.stringify(live(w).rows[0])); // its own full test run, with T-2 still half-done in the lane
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-2_1', 'go on'], { env: w.env });
  assert.equal(await exited, 0);
  assert.equal(w.stages()['T-2'], 'done');
  const sha = gitIn(w, 'log', '--format=%H %s', 'lane/b1').split('\n').find((l) => l.includes(' T-1: ')).split(' ')[0];
  assert.equal(gitIn(w, 'show', '--name-only', '--format=', sha), 'src/a.txt\nsrc/sub/b.txt', 'a file no transcript names is in the commit');
  assert.equal(gitIn(w, 'show', 'lane/b1:lib/b.txt'), 'b');
  assert.ok(!existsSync(`${w.lane}.t/T-1`), 'the worktree is removed once merged');
  assert.equal(gitIn(w, 'branch', '--list', 'ticket/*'), '');
});

test('isolate: at most 2 isolated worktrees live per lane; a third isolated row waits for a slot', async () => {
  const w = world(['T-1', 'T-2', 'T-3'].map((id) => ({ id, isolate: true, actions: [{ hang: true }, ok(id)] })), { git: seed });
  const { exited } = await background(w);
  const runs = () => w.calls().filter((l) => l.startsWith('run'));
  assert.ok(await until(() => runs().length === 2));
  await sleep(700);
  assert.equal(runs().length, 2, 'the third waits, never shared');
  assert.equal(readdirSync(`${w.lane}.t`).length, 2);
  for (const a of ['xT-1_1', 'xT-2_1']) spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', a, 'go on'], { env: w.env });
  assert.ok(await until(() => runs().some((l) => l.includes('[batch b1 T-3]') && l.includes(`--cwd ${w.lane}.t/T-3 `))), w.calls().join('\n'));
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-3_1', 'go on'], { env: w.env });
  assert.equal(await exited, 0);
  assert.deepEqual(Object.values(w.stages()), ['done', 'done', 'done']);
});

test('routing: done, hold, decide, stall and ready to merge each reach the session that acts on them, the urgent ones at once', async () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }, { id: 'T-2', actions: [{ writes: { 'T-2/out.txt': 'x', 'stray.txt': 'x' } }] },
    { id: 'T-3', actions: [{ hang: true, reply: 'thinking' }, ok('T-3')] }],
  { git: seed, settings: { fixRounds: 0 }, env: { STUB_FACTORY: 'tfactory', BATCH_DIGEST_MS: '600000', BATCH_HOLD_MS: '20000', BATCH_STALL_MS: '1500' } });
  const { exited } = await background(w, 'tfactory');
  const got = (to, start) => w.calls().some((l) => l.startsWith(`send ${to} ${start}`));
  assert.ok(await until(() => got('tlead', 'Lane b1 T-2 held: still failing after 0 fix rounds: Scope check failed: stray.txt')), w.calls().join('\n')); // held: the Lead, at once
  assert.ok(await until(() => got('tfactory', 'Lane b1 rows: T-2 held:') && got('tfactory', 'Lane b1 rows: T-1 done')), 'the factory hears each row at once');
  assert.ok(!w.calls().some((l) => l.startsWith('send tlead') && l.includes('T-1 started')), 'routine progress waits for the digest');
  cli(w, 'decide', 'b1', 'T-2', 'allow');
  assert.ok(await until(() => got('tlead', 'Lane b1 T-2: allow applied')), 'the lane acks the decision');
  assert.ok(await until(() => got('tlead', 'Lane b1: T-3 stalled') && got('tfactory', 'Lane b1 rows: T-3 stalled')), w.calls().join('\n'));
  spawnSync('node', [join(HERE, 'hc-stub.mjs'), 'send', 'xT-3_1', 'go on'], { env: w.env });
  assert.equal(await exited, 0);
  const end = w.calls().filter((l) => l.startsWith('send tlead Lane b1: ') && l.includes('Batch b1:'));
  assert.equal(end.length, 1);
  assert.match(end[0], /T-1 started.*Batch b1: 3\/3 done.*Ready to merge: git merge --no-ff lane\/b1/);
  assert.ok(got('tfactory', 'Batch b1: 3/3 done'));
  assert.ok(!w.calls().some((l) => /^send x/.test(l) && /held|stalled/.test(l)), 'Workers never get lane events');
});

test('a send that fails twice is logged to the lane events log and named in the next digest', () => {
  const w = world([{ id: 'T-1', actions: [ok('T-1')] }], { env: { STUB_FACTORY: 'tfactory', STUB_SEND_FAIL: 'tfactory' } });
  spawnSync('node', [join(HERE, 'batch.mjs'), 'b1', '--project', w.project, '--starter', 'tfactory'], { env: w.env, encoding: 'utf8', timeout: 60000 });
  const c = w.calls();
  assert.equal(c.filter((l) => l.startsWith('send tfactory Lane b1 rows: T-1 done')).length, 2, 'retried once');
  assert.match(readFileSync(join(w.project, '.tsf/batches/b1.events.log'), 'utf8'), /undelivered to tfactory: Lane b1 rows: T-1 done/);
  assert.ok(c.some((l) => l.startsWith('send tlead Lane b1: ') && l.includes('undelivered to tfactory')), c.join('\n'));
});
