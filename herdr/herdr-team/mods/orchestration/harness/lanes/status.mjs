#!/usr/bin/env node
// No tokens. The JSON half of `status.sh --json`: reads its per-lane rows on stdin (tab separated) and adds
// what a view needs: milestones, each planned issue's stage, reviews, the last 10 events and cost so far.
//   status.sh --json <project dir>   (not run by hand: status.sh passes <project dir> <now>)
// Stages: queued (no commit), building (current issue, or committed but not ready), ready (in the lane's
// handoff), landed (newest GH-n: commit on main), reviewed (landed with .tsf/review/GH-n.md).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [where, nowArg] = process.argv.slice(2);
const project = resolve(where);
const now = +nowArg || Math.floor(Date.now() / 1000);
const git = (...args) => {
  try {
    return execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const mtime = (p) => Math.floor(statSync(p).mtimeMs / 1000);

const lanes = [];
const due = [];
for (const line of readFileSync(0, "utf8").split("\n")) {
  const f = line.split("\t");
  if (f[0] === "due") due.push({ id: f[1], at: f[2] });
  if (f[0] !== "lane") continue;
  const [, id, who, template, ahead, dirty, idle, left, flag, last] = f;
  const [address, status] = who === "-" ? [null, null] : who.split(" ");
  lanes.push({
    id, builder: address ? `builder-${id}` : null, address, status: status === "-" ? null : status,
    template: template === "-" ? null : template,
    model: template === "-" ? null : /standard/.test(template) ? "Sonnet" : /lane-builder/.test(template) ? "Opus" : template,
    ahead: +ahead, uncommitted: +dirty, idle_s: +idle, left: left ? left.split(" ") : [], flag: flag || null, last: last || null,
  });
}

// Plan: `lane <l>: GH-a GH-b` in order, `review: GH-x ...`.
const plan = read(join(project, ".tsf/plan.md"));
const planned = {};
for (const m of plan.matchAll(/^lane ([^:\s]+): *(.*)$/gm)) planned[m[1]] = m[2].match(/\b[A-Z]+-\d+\b/g) ?? [];
const reviewIds = plan.match(/^review: *(.*)$/m)?.[1].match(/\b[A-Z]+-\d+\b/g) ?? [];

// Newest commit of each issue across every branch: its subject starts `GH-n:` (as status.sh's commit_of)
// or names it among several, `GH-3 GH-5:`, which status.sh's text misses.
const newest = {};
for (const row of git("log", "--all", "--format=%H %s").split("\n")) {
  const m = row.match(/^(\w+) ((?:[A-Z]+-\d+[ ,/&]*)+):/);
  for (const id of m?.[2].match(/[A-Z]+-\d+/g) ?? []) newest[id] ??= m[1];
}
const onMain = new Set(git("rev-list", "main").split("\n").filter(Boolean));

const common = git("rev-parse", "--path-format=absolute", "--git-common-dir").trim();
const handoffs = {};
const handoffDir = join(common, "tsf-handoff");
if (common && existsSync(handoffDir))
  for (const f of readdirSync(handoffDir).filter((n) => n.endsWith(".json"))) {
    try {
      const h = JSON.parse(read(join(handoffDir, f)));
      handoffs[h.lane] = { ...h, contains: new Set(git("rev-list", h.sha).split("\n").filter(Boolean)) };
    } catch {}
  }

const reviewDir = join(project, ".tsf/review");
const reviewed = {};
if (existsSync(reviewDir))
  for (const f of readdirSync(reviewDir).filter((n) => n.endsWith(".md"))) {
    const p = join(reviewDir, f);
    reviewed[f.slice(0, -3)] = { clean: /No defects found\./i.test(read(p)), at: mtime(p) };
  }

// Each issue's milestone and title from issues/M<n>/GH-n.md ("# GH-2: Reorder points ...").
const about = {};
const issueDir = join(project, "issues");
for (const m of existsSync(issueDir) ? readdirSync(issueDir).filter((n) => /^M\d+$/.test(n)) : [])
  for (const f of readdirSync(join(issueDir, m)).filter((n) => /^[A-Z]+-\d+\.md$/.test(n)))
    about[f.slice(0, -3)] = { milestone: m, title: read(join(issueDir, m, f)).match(/^#\s*(?:[A-Z]+-\d+:?\s*)?(.*)$/m)?.[1].trim() || null };
const issue = (id, lane, stage, c) => ({ id, lane, stage, commit: c?.slice(0, 7) ?? null, milestone: about[id]?.milestone ?? null, title: about[id]?.title ?? null });

const issues = [];
const seen = new Set();
for (const lane of lanes) {
  const ids = planned[lane.id] ?? [];
  lane.left = ids.filter((id) => !newest[id]);
  lane.skills = plan.match(new RegExp(`^skills ${lane.id}:(.*)$`, "m"))?.[1].trim().split(/[\s,]+/).filter(Boolean) ?? []; // groups and skills, as skills.mjs reads them
  lane.current = lane.address ? lane.left[0] ?? null : null;
  lane.done = ids.filter((id) => !lane.left.includes(id));
  for (const id of ids) {
    if (seen.has(id)) continue; // an issue two lanes share belongs to the first that names it
    seen.add(id);
    const c = newest[id];
    const stage = !c
      ? id === lane.current ? "building" : "queued"
      : onMain.has(c) ? (reviewed[id] ? "reviewed" : "landed")
      : handoffs[lane.id]?.contains.has(c) ? "ready" : "building";
    issues.push(issue(id, lane.id, stage, c));
  }
  if (lane.current) lane.stage = issues.find((i) => i.id === lane.current)?.stage ?? "building";
  else lane.stage = handoffs[lane.id] ? "ready" : lane.left.length ? "queued" : "landed";
}
// Planned outside any lane worktree (a lane not started, or the Lead's own): stage from git alone.
for (const [lane, ids] of Object.entries(planned))
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const c = newest[id];
    issues.push(issue(id, lane, !c ? "queued" : onMain.has(c) ? (reviewed[id] ? "reviewed" : "landed") : "building", c));
  }

const events = [];
for (const row of git("log", "main", "--merges", "--format=%h %ct %s", "-n", "30").split("\n")) {
  const m = row.match(/^(\w+) (\d+) Merge lane\/(\S+)/);
  if (m) events.push({ at: +m[2], kind: "landed", lane: m[3], text: `lane ${m[3]} landed at ${m[1]}` });
}
for (const h of Object.values(handoffs))
  events.push({ at: +h.at || 0, kind: "ready", lane: h.lane, text: `lane ${h.lane} ready at ${String(h.sha).slice(0, 7)}` });
for (const [id, r] of Object.entries(reviewed))
  events.push({ at: r.at, kind: "review", issue: id, text: `review ${id}: ${r.clean ? "clean" : "defects"}` });
events.sort((a, b) => b.at - a.at);

// Started when the Lead made .tsf (start-runs.sh makes it at the run's start).
const tsf = join(project, ".tsf");
const started = existsSync(tsf) ? Math.floor((statSync(tsf).birthtimeMs || statSync(tsf).mtimeMs) / 1000) : null;
const done = [...read(join(project, "DONE.md")).matchAll(/^## (M\d+)/gm)].map((m) => m[1]);
const all = existsSync(issueDir) ? readdirSync(issueDir).filter((n) => /^M\d+$/.test(n)).sort() : [];

// Cost: meter.mjs over this project's Claude Code transcripts (lane worktrees too), at most every 30 s.
let cost = null;
if (started && common) {
  const cache = join(common, "tsf-cost.json");
  const meter = join(dirname(fileURLToPath(import.meta.url)), "../metrics/meter.mjs");
  const stale = !existsSync(cache) || now - mtime(cache) > 30;
  const dir = "^" + project.replace(/[^A-Za-z0-9]/g, "-").replace(/[-]/g, "\\-");
  if (stale)
    try {
      execFileSync(process.execPath, ["--no-warnings", meter, "--since", String(started), "--dir", dir, "--json", cache], { stdio: "ignore", timeout: 10_000 });
    } catch {}
  try {
    cost = JSON.parse(read(cache)).total_cost ?? null;
  } catch {}
}

console.log(JSON.stringify({
  project, now, started, elapsed_s: started ? now - started : null,
  milestones: { done, left: all.filter((m) => !done.includes(m)) },
  lanes, issues,
  reviews: {
    due: due.map((d) => d.id),
    done: reviewIds.filter((id) => reviewed[id]).map((id) => ({ id, clean: reviewed[id].clean })),
    left: reviewIds.filter((id) => !reviewed[id]),
  },
  events: events.slice(0, 10),
  cost,
}));
