// node team.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placed, zoneCount } from "./drop.js";
import { COLUMNS, inColumn, parseTickets } from "./tickets.js";
import { CREW, HARNESS, STATIONS, WRITE_TEMPLATE, launchArgs, staffing, templateText } from "./team.js";
// The Lead reads its batch-lane rules from a file only when a job needs batch lanes.
const LEAD_ALL = launchArgs(STATIONS[0], { name: "x", id: "sp1" }).at(-1) + readFileSync(new URL("./harness/batch/LEAD-BATCH.md", import.meta.url), "utf8").replaceAll("<space>", "sp1");

const a = (address, tab_name) => ({ address, tab_name });
assert.deepEqual(STATIONS.map((s) => s.title), ["Lead", "UI Polisher", "Researcher"]);
// On-demand seats: Start team opens only the Lead; every role has model, tools and budget; the Planner is strong and one-shot.
assert.deepEqual(STATIONS.filter((s) => !s.onDemand).map((s) => s.id), ["lead"]);
assert.ok(CREW.every((s) => s.onDemand === undefined || ["builder", "reviewer", "planner"].includes(s.id))); // frozen stations keep their flags
for (const s of [...STATIONS, ...CREW]) {
  assert.ok(s.model, s.id);
  assert.ok(s.budget.usd > 0 && s.budget.minutes > 0, s.id);
  assert.match(templateText(s), /--tools|command: claude --model \S+ --strict-mcp-config|command: claude --model \S+ --settings|command: codex --no-daemon /); // lean seats name their tools; others keep every tool; Codex seats keep its own
}
const byId = (id) => [...STATIONS, ...CREW].find((s) => s.id === id);
const planner = byId("planner");
assert.deepEqual([planner.tier, planner.oneShot, planner.model, planner.lean], ["strong", true, "claude-opus-5-5", undefined]);
assert.match(launchArgs(planner, { name: "x", id: "sp1" }).at(-1), /write \.tsf\/plan\.md/);
assert.match(planner.duty, /ONE short hc line, `Plan ready: <path>\. <n> milestones, <n> tickets, <n> lanes proposed\.`/);
assert.match(planner.duty, /ask-matt\/SKILL\.md[\s\S]*grilling[\s\S]*codebase-design[\s\S]*ask them[\s\S]*Only then/);
assert.match(LEAD_ALL, /hc run --bg planner/);
assert.deepEqual(STATIONS[0].budget, { usd: 0.5, minutes: 10 });
assert.deepEqual(launchArgs(STATIONS[0], { name: "demo", id: "sp1" }).slice(4, 7), ["claude", "--model", "claude-opus-5-5"]);
const reviewer = launchArgs(byId("reviewer"), { name: "my project", id: "sp1" }).at(-1);
assert.match(reviewer, /You are Reviewer/);
assert.match(reviewer, /starts with "my project \/"/); // one project's team never talks to another's
assert.match(reviewer, /Use the hc skill/);
assert.doesNotMatch(reviewer, / -p /); // Herdr: agents stay interactive, never one-shot
assert.match(launchArgs(byId("ui-polisher"), { name: "x", id: "sp1" }).at(-1), /impeccable/);
assert.match(templateText(byId("reviewer")), /^---\nname: team-reviewer\n.*\ncommand: claude --model claude-opus-5-5 --effort high --tools \S+ --strict-mcp-config --settings '\{.*\}' --setting-sources 'project,local' --permission-mode auto\n---\nYou are Reviewer/); // lean: no user settings

// Start team refreshes its own templates and leaves a hand-written one alone.
const home = mkdtempSync(join(tmpdir(), "team-"));
const dir = join(home, ".config/herdr-core/templates");
const write = (id, text) => execFileSync("sh", ["-c", WRITE_TEMPLATE, "sh", id, text], { env: { ...process.env, HOME: home } });
write("reviewer", templateText(byId("reviewer")));
write("reviewer", templateText(byId("builder")));
assert.equal(readFileSync(join(dir, "reviewer.md"), "utf8"), templateText(byId("builder")));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "lead.md"), "mine");
write("lead", templateText(STATIONS[0]));
assert.equal(readFileSync(join(dir, "lead.md"), "utf8"), "mine");

const labels = new Map([["t2", { role: "ui-polisher" }], ["t5", { role: "" }]]);
const staffed = staffing([a("t1", "Lead"), a("t2", "2"), a("t3", "Lead"), a("t5", "Researcher")], labels);
assert.equal(staffed.lead.address, "t1");
assert.equal(staffed["ui-polisher"].address, "t2");
assert.equal(staffed.researcher, undefined); // an emptied role label beats the tab name

// A helper in the Lead's tab, sorting first, doesn't take the station.
assert.equal(staffing([a("t12", "Lead"), a("t9", "Lead")], new Map(), new Set(["t12"])).lead.address, "t9");

// Dropping: never more than four squares; a new session replaces or adds, a shown one trades places.
assert.equal(zoneCount([], "x"), 1);
assert.equal(zoneCount(["a", "b"], "x"), 3);
assert.equal(zoneCount(["a", "b", "c", "d"], "x"), 4);
assert.equal(zoneCount(["a", "b"], "a"), 2);
assert.deepEqual(placed(["a", "b"], "x", 2), ["a", "b", "x"]);
assert.deepEqual(placed(["a", "b", "c", "d"], "x", 1), ["a", "x", "c", "d"]);
assert.deepEqual(placed(["a", "b", "c"], "a", 2), ["c", "b", "a"]);
assert.deepEqual(placed(["a", "b"], "b", 1), ["a", "b"]);
// Tickets: the real script, end to end.
const ticket = (...args) => execFileSync("sh", [new URL("./harness/tickets/ticket.sh", import.meta.url).pathname, "my project/x", ...args], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
assert.equal(ticket("ls"), "");
assert.equal(ticket("add", "Build\tlogin", "builder").trim(), "T-1");
assert.equal(ticket("add", "Polish form").trim(), "T-2");
ticket("move", "T-1", "review", "reviewer");
ticket("move", "T-2", "blocked");
const board = parseTickets(ticket("ls"));
assert.deepEqual(board.map(({ id, stage, owner, title }) => [id, stage, owner, title]), [["T-1", "review", "reviewer", "Build login"], ["T-2", "blocked", "", "Polish form"]]);
assert.ok(board[0].at > 1e9);
assert.deepEqual(inColumn(board, COLUMNS[1]).map((x) => x.id), ["T-2"]); // blocked work stays in progress
assert.throws(() => ticket("move", "T-9", "done"), /no ticket/);
assert.throws(() => ticket("move", "T-1", "shipped"), /unknown stage/);
// The id, never the name, reaches the command agents are told to run.
assert.match(reviewer, /ticket\.sh sp1`/);
assert.doesNotMatch(launchArgs(byId("builder"), { name: "$(touch x)", id: "sp1" }).at(-1), /ticket\.sh[^`]*touch/);
assert.doesNotMatch(templateText(byId("builder")), /ticket\.sh/); // helpers leave tickets to whoever started them
assert.throws(() => ticket("move", "T-\\061", "doing"), /no ticket/); // awk must not decode backslashes
// The Builder's crew: persistent, nested under it, and started by it.
assert.deepEqual(CREW.map((s) => s.id), ["backend", "worker", "frontend", "tester", "factory", "builder", "reviewer", "planner", "lane-builder", "lane-builder-standard", "factory-standard", "worker-fast", "worker-strong", "worker-codex", "reviewer-light", "reviewer-codex"]);
assert.match(templateText(CREW[0]), /^---\nname: backend\n.*\ncommand: claude --model opus --tools \S+ --strict-mcp-config --settings '\{.*\}' --setting-sources 'project,local' --permission-mode auto\n---\nYou are Backend, a persistent sub-session under Builder/);
const builder = launchArgs(byId("builder"), { name: "x", id: "sp1" }).at(-1);
assert.match(builder, /hc run --bg backend/);
assert.ok(STATIONS.every((s) => !s.startup)); // nobody spends tokens before there is work

// The team's rules reach every session, helpers included.
for (const text of [builder, templateText(byId("reviewer")), templateText(CREW[1])]) {
  assert.match(text, /Only the Lead commits/);
  assert.match(text, /works on main/);
}
assert.match(LEAD_ALL, /complete redesign is a frontend row/);
// The Lead talks to up to 5 lane factories; a factory (Opus: it writes the briefs) starts its lane as its own terminal, which outlives it.
assert.match(LEAD_ALL, /--name builder-<n> factory/);
const factory = CREW.find((x) => x.id === "factory");
assert.equal(CREW.find((x) => x.id === "factory-standard").model, "sonnet");
// Lean default: lane builders build their lane in one warm session with subagents, and always report up.
// The Lead's own prompt is short and lean-only; batch lanes are an opt-in file.
assert.ok(STATIONS[0].duty.length < 6800);
for (const s of ["{grilling,domain-modeling,codebase-design,new-feature}", "tsf", "code-review", "design-taste-frontend"]) assert.ok(STATIONS[0].duty.includes(`~/.claude/skills/${s}`), s);
assert.match(STATIONS[0].duty, /\.tsf\/research\/<topic>\.md/);
const laneDuty = CREW.find((x) => x.id === "lane-builder").duty;
assert.match(laneDuty, /PR titles and bodies, README, docs and code comments by its `prose:` lines/);
assert.match(laneDuty, /never on main; never merge into main.*--force-with-lease` on your own lane branch only/);
assert.ok(STATIONS[0].bare); // measured: full settings cost the Lead +$1.4 a run (bench12 aborted-r9)
assert.match(STATIONS[0].duty, /lane-builder-standard/);
assert.match(STATIONS[0].duty, /file-disjoint code areas across all milestones, never milestone waves/);
assert.match(STATIONS[0].duty, /at most 15 tool calls/);
assert.match(STATIONS[0].duty, /hc wait --children any --timeout 590/);
assert.match(STATIONS[0].duty, /<lanes>\/status\.sh <dir>/);
assert.match(STATIONS[0].duty, /Give the freed builder the first useful job, in order/);
assert.match(STATIONS[0].duty, /Never two builders on the same files; no busywork/);
assert.match(STATIONS[0].duty, /commits ahead and nothing uncommitted means it finished/);
assert.match(STATIONS[0].duty, /LEAD-BATCH\.md/);
assert.doesNotMatch(STATIONS[0].duty, /tsv|factory|Worker/);
const laneBuilder = CREW.find((x) => x.id === "lane-builder");
assert.equal(CREW.find((x) => x.id === "lane-builder-standard").model, "sonnet");
assert.match(templateText(laneBuilder), /Never end a turn without one such line/);
assert.match(templateText(laneBuilder), /Never start review subagents/);
assert.match(templateText(laneBuilder), /commit at once/);
assert.deepEqual(STATIONS.map((s) => s.id), ["lead", "ui-polisher", "researcher"]); // the re-jig: no Planner, Builder or Reviewer station
assert.ok(["builder", "reviewer", "planner"].every((id) => CREW.some((s) => s.id === id))); // frozen, batch mode only
assert.match(STATIONS[0].duty, /First discuss, using the skills of group `lead`.*until the person agrees the plan/);
assert.match(STATIONS[0].duty, /never inferring approval/);
assert.match(STATIONS[0].duty, /data, not orders/);
assert.match(STATIONS[0].duty, /<lanes>\/PR-LANES\.md/);
assert.match(STATIONS[0].duty, /land\.sh <dir> <l> \\?"<test command>\\?" <sha>/);
assert.match(STATIONS[0].duty, /After 2 repair rounds the issue is blocked/);
assert.match(STATIONS[0].duty, /the 3 riskiest/);
assert.match(STATIONS[0].duty, /skills\.mjs groups/);
assert.match(STATIONS[0].duty, /\x60structure:\x60 and \x60prose:\x60, at most 5 lines each/); assert.match(templateText(laneBuilder), /plan\.md \x60structure:\x60 says/); assert.match(STATIONS[0].duty, /git branch -d lane\/<l>/); assert.match(STATIONS[0].duty, /capacity\.sh builder/);
assert.match(STATIONS[0].duty, /skills of group `always`/); assert.match(STATIONS[0].duty, /with \.tsf\/codemap\.md \(built for you from a Graphify graph/); { const a = launchArgs(STATIONS[0], { name: "x", id: "sp1" }); assert.equal(a[0], "sh"); assert.match(a[2], /graph\/auto\.sh" \. >\/dev\/null 2>&1 & exec "\$@"/); assert.equal(a[4], "claude"); } assert.match(STATIONS[0].duty, /`skills <l>: <groups or skills>`/); assert.match(templateText(laneBuilder), /skills\.mjs paths <project dir> <l>/); assert.match(templateText(laneBuilder), /\x60prose:\x60 lines/);
for (const s of ["evidence-driven-testing", "greploop"]) assert.match(templateText(laneBuilder), new RegExp(`skills/${s}/SKILL\\.md`));
assert.match(templateText(laneBuilder), /ready <full sha>: ready\.sh PASS/);
assert.match(byId("ui-polisher").duty, /before-and-after\/SKILL\.md[\s\S]*never upload/);

assert.match(templateText(laneBuilder), /never `isolation: worktree`/);
assert.match(templateText(laneBuilder), /harness\/lanes\/ready\.sh <worktree>/);
assert.match(templateText(laneBuilder), /over about 10 minutes or fails twice/);
assert.match(STATIONS[0].duty, /one verify command/);
assert.match(STATIONS[0].duty, /in the lane with the least work/);
assert.match(STATIONS[0].duty, /<lanes> is ~\/\.config\/herdr-app\/mods\/orchestration\/harness\/lanes\./);
assert.match(STATIONS[0].duty, /<lanes>\/land\.sh <dir> <l>/);
assert.match(STATIONS[0].duty, /<lanes>\/finish\.sh <dir>/);
assert.match(STATIONS[0].duty, /`REVIEW DUE <id> at <commit>`/);
assert.match(STATIONS[0].duty, /`lane <l>: GH-a GH-b`/);
assert.match(STATIONS[0].duty, /`lane-builder-standard` \(Sonnet\) by default/);
assert.match(STATIONS[0].duty, /the lane with the most work left goes to the lane with the least/);
assert.match(STATIONS[0].duty, /a lane marked FREE gets the freed builder's first useful job/);
assert.match(STATIONS[0].duty, /end your turn rather than `hc wait`/);
assert.match(templateText(laneBuilder), /git merge main/);
assert.match(LEAD_ALL, /factory-standard/);
assert.match(LEAD_ALL, /After the last merge you only run the tests/);
assert.match(templateText(factory), /hc run --bg --outlive-parent --no-notify --name lane-<lane> -- node \S+batch\.mjs <lane>/);
assert.match(templateText(factory), /command: claude --model claude-opus-5-5 --effort medium /);
assert.match(factory.duty, /exact brief[\s\S]*function signatures[\s\S]*worker-strong only for/);
const leadText = LEAD_ALL;
for (const re of [/decide <lane> <ticket> retry '<concrete guidance>' \[--role <tier>\]/, /git merge --no-ff lane\/<lane>/, /state it in one line before starting \(lanes, waves, Workers per lane, tiers\)/, /sliding scale: extra cost in percent of about the wall-time cut in percent minus 25/, /never for a piece under about 5 minutes of work/, /Mark one row per lane with role builder[\s\S]*never more than one per lane/, /8th column to race/, /never edit their source yourself/, /batch\.mjs verify --project <dir>` once, and never report done or write a done file until it prints PASS/, /no for styling, copy, config, docs and renames; light for ordinary endpoints, UI logic and CLI[\s\S]*full for money, security and tokens, data deletion, concurrency and migrations[\s\S]*full-codex/, /readability \(true or a list of lanes/]) assert.match(leadText, re);
for (const id of ["worker", "tester"]) assert.match(CREW.find((x) => x.id === id).duty, /vague or contradictory[\s\S]*hc send[\s\S]*never encode a guess/);
assert.match(CREW.find((x) => x.id === "factory").duty, /Worker or the Test writer may hc send you/);
for (const re of [/build the builder row yourself/, /batch\.mjs ready <lane> <ticket>/, /batch\.mjs add <lane> <ticket>/, /at least about 5 minutes of work; you have your own work meanwhile/, /warm Worker/, /built-in subagents only for quick read-only lookups/, /never from Worker transcripts/]) assert.match(CREW.find((x) => x.id === "factory").duty, re);
assert.match(templateText(CREW.find((x) => x.id === "reviewer-codex")), /codex --no-daemon -m gpt-6\.1-sol/);
// Only the batch moves batch rows: no Worker is told to move its own ticket, and Workers start subagents at their default effort.
for (const id of ["worker", "worker-strong", "worker-fast"]) { const t = templateText(CREW.find((x) => x.id === id)); assert.match(t, /Never move your ticket on the board/); assert.doesNotMatch(t, /move the ticket to (doing|review)|effort to max/); }
assert.deepEqual(Object.keys(HARNESS).sort(), ["digestSeconds", "elastic", "fixRounds", "floater", "graph", "holdMinutes", "link", "notes", "readability", "reviewRounds", "steal", "stealLanes", "suite", "test", "workers"]);
assert.match(templateText(factory), /--setting-sources 'project,local'/);
for (const s of [STATIONS[0], CREW[0]]) assert.match(s === CREW[0] ? templateText(s) : launchArgs(s, { name: "x", id: "sp1" }).at(-1), /Use the hc skill/);
// Per-ticket seats start bare (no user settings).
assert.ok(launchArgs(byId("builder"), { name: "x", id: "sp1" }).includes("--setting-sources"));
// The Lead starts bare: it learns the skills from skills.mjs groups, not a 31k-token start.
assert.ok(launchArgs(STATIONS[0], { name: "x", id: "sp1" }).includes("--setting-sources"));
// Context: the Lead can reset an idle teammate, typed key by key because hc send only delivers a message.
assert.match(LEAD_ALL, /hc keys <address> \/ c l e a r enter/);
assert.ok(!launchArgs(byId("builder"), { name: "x", id: "sp1" }).includes("--disable-slash-commands")); // it would break /clear
// One owner per ticket: parallel across tickets, split only on the split test.
assert.match(LEAD_ALL, /hc run --bg worker/);
assert.match(templateText(CREW[1]), /command: claude --model sonnet.*\n---\nYou are Worker, a one-ticket session under Lead/);
// Any seat can run another agent; its role reaches it either way.
const seat = { ...byId("builder"), agent: "codex", model: "gpt-6.1-sol", effort: "low" };
assert.deepEqual(launchArgs(seat, { name: "x", id: "sp1" }).slice(0, 6), ["codex", "--no-daemon", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="low"']);
assert.match(launchArgs(seat, { name: "x", id: "sp1" }).at(-1), /^developer_instructions="You are Builder/);
assert.match(templateText(seat), /command: codex --no-daemon -m gpt-6\.1-sol -c 'model_reasoning_effort="low"'\n/);
// GitHub: issues arrive as GH-n tickets, and closing goes only to the repo the board is tied to.
const bin = mkdtempSync(join(tmpdir(), "gh-"));
writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${bin}/log"\ncase "$1 $2" in\n"repo view") echo me/app ;;\n"issue list") cat "${bin}/issues" ;;\n"issue create") echo https://github.com/me/app/issues/31 ;;\nesac\n`, { mode: 0o755 });
const issues = (...rows) => writeFileSync(join(bin, "issues"), rows.map((r) => r.join("\t") + "\n").join(""));
const synced = (...args) => execFileSync("sh", [new URL("./harness/tickets/ticket.sh", import.meta.url).pathname, "gh proj", ...args], { env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const row = (id) => synced("ls").split("\n").find((l) => l.startsWith(id + "\t"))?.split("\t");
issues([12, "OPEN", "Fix login"], [9, "CLOSED", "Old"]);
synced("sync");
assert.deepEqual(row("GH-12").slice(1, 3), ["todo", ""]);
assert.equal(row("GH-12")[4], "Fix login");
assert.equal(row("GH-9"), undefined); // long-closed issues stay off the board
synced("move", "GH-12", "doing", "builder");
synced("sync");
assert.deepEqual(row("GH-12").slice(1, 3), ["doing", "builder"]); // a sync never undoes progress
synced("move", "GH-12", "done");
assert.match(readFileSync(join(bin, "log"), "utf8"), /issue close 12 -R me\/app/);
assert.throws(() => synced("move", "GH-12", "doing"), /GH-12 is done; only the Lead reopens it, with --force/); // a stale session can't reopen closed work
assert.equal(row("GH-12")[1], "done");
synced("move", "GH-12", "doing", "--force");
assert.equal(row("GH-12")[1], "doing");
assert.match(readFileSync(join(bin, "log"), "utf8"), /issue reopen 12 -R me\/app/);
issues([12, "CLOSED", "Fix login"]);
synced("sync");
assert.equal(row("GH-12")[1], "done"); // closed on GitHub, done on the board
assert.equal(synced("issue", "New thing", "worker").trim(), "GH-31");
assert.equal(synced("add", "Local").trim(), "T-1"); // GH ids don't move the local numbering
const noGh = (...args) => execFileSync("sh", [new URL("./harness/tickets/ticket.sh", import.meta.url).pathname, "plain", ...args], { env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
assert.equal(noGh("sync"), ""); // without GitHub the board just stays local
// Lean seats start small; seats that load skills or browse keep every tool.
assert.ok(launchArgs(STATIONS[0], { name: "x", id: "sp1" }).includes("--tools"));
assert.ok(!launchArgs(byId("researcher"), { name: "x", id: "sp1" }).includes("--tools"));
assert.match(templateText(CREW[1]), /command: claude --model sonnet --effort medium --tools 'Bash,Read,Write,Edit,Agent' --strict-mcp-config --settings /);
// Workers skip the global rules, and carry what they need themselves.
assert.match(templateText(CREW[1]), /--setting-sources 'project,local' --permission-mode auto\n/);
assert.doesNotMatch(templateText(CREW[1]), /global instructions/);
assert.match(templateText(CREW[1]), /only when stuck/);
assert.match(templateText(CREW[0]), /when done or stuck/);
assert.match(LEAD_ALL, /how-to-build-projects\.md/);
assert.match(LEAD_ALL, /capacity\.sh/);
assert.match(LEAD_ALL, /gate\.sh sp1 <ticket>/);
// A session loads only its role's sections: the Lead runs the harness, others only the board, crew none.
const roleText = (id) => launchArgs(STATIONS.find((s) => s.id === id), { name: "x", id: "sp1" }).at(-1);
assert.match(roleText("ui-polisher"), /harness\/tickets\/ticket\.sh sp1/);
assert.match(roleText("lead"), /pulse\.sh/); // the Lead keeps only the pulse section; the batch-lane sections are in LEAD-BATCH.md
for (const re of [/capacity\.sh/, /gate\.sh/, /batch\.mjs/, /summary\.mjs/, /meter\.mjs/]) assert.match(LEAD_ALL, re);
for (const re of [/capacity\.sh/, /gate\.sh/, /batch\.mjs/, /pulse\.sh/, /summary\.mjs/, /meter\.mjs/]) assert.doesNotMatch(roleText("ui-polisher"), re);
for (const c of CREW.filter((x) => x.id !== "factory")) assert.doesNotMatch(templateText(c), /ticket\.sh|capacity\.sh|gate\.sh/); // a factory re-queues its lane's blocked rows
// Capacity follows mole's free memory, its pressure, and the kernel without mole.
const script = (name) => new URL(`./${name}`, import.meta.url).pathname;
const fake = mkdtempSync(join(tmpdir(), "mo-"));
const mo = (available, pressure) => writeFileSync(join(fake, "mo"), `#!/bin/sh\necho '{"memory":{"available":${available},"pressure":"${pressure}"}}'\n`, { mode: 0o755 });
const capacity = (path) => execFileSync("sh", [script("harness/capacity/capacity.sh")], { env: { ...process.env, PATH: path }, encoding: "utf8" }).trim();
const GB = 1073741824, withMo = `${fake}:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Frameworks/Python.framework/Versions/3.13/bin:/opt/homebrew/bin`;
mo(4 * GB, ""); assert.equal(capacity(withMo), "6");
mo(40 * GB, ""); assert.equal(capacity(withMo), "8");
mo(1 * GB, ""); assert.equal(capacity(withMo), "0");
mo(8 * GB, "critical"); assert.equal(capacity(withMo), "0");
mo(40 * GB, ""); assert.equal(execFileSync("sh", [script("harness/capacity/capacity.sh"), "builder"], { env: { ...process.env, PATH: withMo }, encoding: "utf8" }).trim(), "5"); // up to 5 lanes
assert.match(capacity("/usr/bin:/bin:/usr/sbin:/sbin"), /^\d+$/);
// The gate: not ready, failing and passing, with the build folder handed to the tests.
const gate = (args, wait = "0") => { try { return { code: 0, out: execFileSync("sh", [script("harness/gate/gate.sh"), "proj", ...args], { env: { ...process.env, HOME: home, GATE_WAIT: wait }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };
const tests = gate(["T-1", "--path"]).out.trim();
assert.match(tests, /gates\/proj\/T-1$/);
assert.equal(gate(["T-1", home]).code, 3);
writeFileSync(join(tests, "run.sh"), 'echo "built in $BUILD"; [ -f "$BUILD/ok" ] || { echo missing; exit 1; }\n');
const failed = gate(["T-1", home]);
assert.equal(failed.code, 1); assert.match(failed.out, /missing/);
writeFileSync(join(home, "ok"), "");
assert.equal(gate(["T-1", home]).code, 0);
const hung = gate(["T-2", "--path"]).out.trim();
writeFileSync(join(hung, "run.sh"), "echo started; sleep 30 &\nsleep 30\n");
process.env.GATE_LIMIT = "1";
const stuck = gate(["T-2", home]);
delete process.env.GATE_LIMIT;
assert.equal(stuck.code, 124); assert.match(stuck.out, /started/); assert.match(stuck.out, /hung/); // a hung test can't hold a Worker
assert.match(gate(["../x", "--path"]).out.trim(), /gates\/proj\/\.\._x$/); // a ticket id can't leave the gates folder
// Tests written under the build folder's path key (gate.sh's old usage said <project>) are found from the board key too.
const byPath = execFileSync("sh", [script("harness/gate/gate.sh"), home, "T-7", "--path"], { env: { ...process.env, HOME: home }, encoding: "utf8" }).trim();
writeFileSync(join(byPath, "run.sh"), "echo found by path\n");
assert.match(gate(["T-7", home]).out, /found by path/);
// main.js imports Herdr's own modules, so load a copy of the mod beside stand-ins for them.
const modCopy = mkdtempSync(join(tmpdir(), "mod-"));
for (const f of ["main.js", "activity.js", "drop.js", "events.js", "subagents.js", "team.js", "tickets.js"]) writeFileSync(join(modCopy, f), readFileSync(script(f)));
for (const d of ["tickets", "gate", "capacity", "batch", "pulse", "summaries", "metrics"]) { mkdirSync(join(modCopy, "harness", d), { recursive: true }); writeFileSync(join(modCopy, "harness", d, "prompt.js"), readFileSync(script(`harness/${d}/prompt.js`))); }
for (const [name, code] of [["herdr", "const f = () => []; export const agents = f, exec = f, focused = f, layout = f, nextCommand = f, panes = f, props = f, run = f, setShared = f, shared = f, spaces = f, terminals = f, theme = f;"], ["gpui-kit", "export class View {}; const f = () => ({}); export const div = f, image = f, svg = f;"], ["gpui-base", "const f = () => ({}); export const h_flex = f, v_flex = f;"]]) {
  mkdirSync(join(modCopy, "node_modules", name), { recursive: true });
  writeFileSync(join(modCopy, "node_modules", name, "package.json"), '{"type":"module","main":"i.js"}');
  writeFileSync(join(modCopy, "node_modules", name, "i.js"), code);
}
const { parseCommand, parseTrace, parseTraces } = await import(join(modCopy, "main.js"));
assert.deepEqual(parseCommand("place:t4:2"), { name: "place", args: ["t4", "2"] });
assert.deepEqual(parseCommand("start-team"), { name: "start-team", args: [] });
assert.deepEqual(parseTrace('{"summary":"fixed login","cost":0.123,"transcript":"/x/t.jsonl"}'), { summary: "fixed login", cost: 0.123, transcript: "/x/t.jsonl" });
assert.equal(parseTrace('{"summaries":["a","b"]}').summary, "b"); // the latest line
assert.equal(parseTrace("not json"), null);
// Cards read traces from the project folder; a ticket without one has none.
const project = mkdtempSync(join(tmpdir(), "proj-"));
mkdirSync(join(project, ".tsf/traces"), { recursive: true });
writeFileSync(join(project, ".tsf/traces/T-1.json"), '{\n "summary": "ran tests",\n "cost": 0.5,\n "transcript": "/t/1.jsonl"\n}\n');
const read = execFileSync("sh", ["-c", readFileSync(script("main.js"), "utf8").match(/const READ_TRACES = '(.*)';/)[1].replace(/\\\\/g, "\\"), "sh", project], { encoding: "utf8" });
assert.deepEqual(Object.keys(parseTraces(read)), ["T-1"]);
assert.equal(parseTraces(read)["T-1"].cost, 0.5);
assert.deepEqual(parseTraces(execFileSync("sh", ["-c", "cd \"$1\" 2>/dev/null || exit 0", "sh", "/nope"], { encoding: "utf8" })), {});
console.log("ok");

// Fast start: the Lead plans itself, lanes start before every brief, nobody waits on the Test writer, main is never rewritten.
{
  const lead = LEAD_ALL, factory = CREW.find((x) => x.id === "factory").duty, planner = byId("planner").duty;
  for (const re of [/plan it yourself, fast/, /lanes running within about 3 minutes/, /never for a written brief or spec/, /only when lanes cannot build against the written contract/, /never amend, rebase or reset main/, /Never hc wait on factories, lanes or the Test writer/, /under about 10 minutes of build/]) assert.match(lead, re);
  assert.match(factory, /Start the lane in your first minute[\s\S]*a row waits until its brief file exists/);
  assert.match(planner, /no answer comes within about 2 minutes, take your recommended answers/);
}
assert.match(LEAD_ALL, /plan one wave: seed data, README, docs and dashboards are first-wave rows/);
assert.match(launchArgs(CREW.find((x) => x.id === "worker"), { name: "x", id: "sp1" }).at(-1), /Never stop to wait for a person: send a question up the chain/);
assert.match(LEAD_ALL, /Your role is to orchestrate[\s\S]*Shape checklist, in order/);
assert.match(launchArgs(CREW.find((x) => x.id === "worker"), { name: "x", id: "sp1" }).at(-1), /Report done, problems and blockers to the session above you the moment they happen/);

// status.sh --json: a scratch project with two lanes. Lane a landed GH-1 and has GH-2 ready; lane b has not started GH-3.
{
  const p = mkdtempSync(join(tmpdir(), "lanes-")), stub = mkdtempSync(join(tmpdir(), "hc-"));
  const sh = (cmd, cwd = p) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const id = "-c user.name=t -c user.email=t@t";
  sh(`git init -q -b main && git ${id} commit -q --allow-empty -m start`);
  mkdirSync(join(p, ".tsf/review"), { recursive: true });
  writeFileSync(join(p, ".tsf/plan.md"), "lane a: GH-1 GH-2\nlane b: GH-3\nreview: GH-1 GH-2\n");
  sh("git worktree add -q -b lane/a .tsf/lanes/a && git worktree add -q -b lane/b .tsf/lanes/b");
  sh(`echo 1 > one && git add one && git ${id} commit -q -m "GH-1: one"`, join(p, ".tsf/lanes/a"));
  sh(`git ${id} merge -q --no-ff lane/a -m "Merge lane/a"`);
  sh(`echo 2 > two && git add two && git ${id} commit -q -m "GH-2: two"`, join(p, ".tsf/lanes/a"));
  mkdirSync(join(p, ".git/tsf-handoff"));
  writeFileSync(join(p, ".git/tsf-handoff/a.json"), `{"lane":"a","sha":"${sh("git rev-parse lane/a").trim()}","verify":"pass","files":"two","at":${Math.floor(Date.now() / 1000)}}\n`);
  writeFileSync(join(stub, "hc"), `#!/bin/sh\necho '{"terminals":[{"name":"builder-a","address":"t9","status":"idle","template":"lane-builder-standard"}]}'\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${stub}:${process.env.PATH}` };
  const status = (...args) => execFileSync("sh", [script("harness/lanes/status.sh"), ...args, p], { env, encoding: "utf8" });
  const text = status().trim().split("\n");
  assert.match(text[0], /^a: t9 idle \| 1 ahead, last: GH-2: two \| 0 uncommitted \| \d+s since a commit or edit \| left: none$/);
  assert.match(text[1], /^b: no builder \| 0 ahead, last:  \| 0 uncommitted \| \d+s since a commit or edit \| left: GH-3$/);
  assert.match(text[2], /^REVIEW DUE GH-1 at \w+$/);
  const j = JSON.parse(status("--json"));
  assert.deepEqual(j.lanes.map((l) => [l.id, l.address, l.model, l.stage, l.ahead, l.done, l.left]), [["a", "t9", "Sonnet", "ready", 1, ["GH-1", "GH-2"], []], ["b", null, null, "queued", 0, [], ["GH-3"]]]);
  assert.deepEqual(j.issues.map((i) => `${i.id}:${i.lane}:${i.stage}`), ["GH-1:a:landed", "GH-2:a:ready", "GH-3:b:queued"]);
  assert.deepEqual(j.reviews.due, ["GH-1"]);
  assert.deepEqual(j.events.map((e) => e.kind).sort(), ["landed", "ready"]);
  writeFileSync(join(p, ".tsf/review/GH-1.md"), "No defects found.\n");
  const after = JSON.parse(status("--json"));
  assert.equal(after.issues[0].stage, "reviewed");
  assert.deepEqual([after.reviews.due, after.reviews.done, after.reviews.left], [[], [{ id: "GH-1", clean: true }], ["GH-2"]]);
  assert.ok(Number.isInteger(after.elapsed_s) && after.events.length === 3);
}
console.log("lanes json ok");
