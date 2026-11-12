#!/usr/bin/env node
// No tokens. Which skills each lane loads. The map lives in ~/.config/herdr-app/data/orchestration/skills.json
// (seeded from default.json): named groups of skills; group `always` goes to every lane.
//   node skills.mjs installed                  every installed skill: name, path, bytes (JSON)
//   node skills.mjs groups                     the map (JSON)
//   node skills.mjs add <group> <skill>        add a skill to a group (creates the group)
//   node skills.mjs rm <group> <skill>         remove it
//   node skills.mjs paths <project dir> <lane> SKILL.md paths for each group or skill (`always` is distilled into the plan by the Lead)
//                                              named on the plan line `skills <lane>: frontend motion gestures`
//   node skills.mjs lane <project dir> <lane> add|rm <group or skill>
//                                              edit that plan line (made if missing); prints the new line
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.SKILLS_HOME || homedir();
const MAP = process.env.SKILLS_MAP || join(HOME, ".config/herdr-app/data/orchestration/skills.json");
const DEFAULT = join(dirname(new URL(import.meta.url).pathname), "default.json");

const dirs = (d) => { try { return readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()); } catch { return []; } };
const ver = (v) => v.split(/[.-]/).map((x) => x.padStart(6, "0")).join(".");

export function installed() {
  const out = [];
  const add = (name, path) => existsSync(path) && out.push({ name, path, bytes: statSync(path).size });
  const user = join(HOME, ".claude/skills");
  for (const n of dirs(user)) add(n, join(user, n, "SKILL.md"));
  const cache = join(HOME, ".claude/plugins/cache");
  for (const market of dirs(cache)) for (const plugin of dirs(join(cache, market))) {
    const latest = dirs(join(cache, market, plugin)).sort((a, b) => (ver(a) < ver(b) ? 1 : -1))[0]; // newest version only
    if (!latest) continue;
    const root = join(cache, market, plugin, latest, "skills");
    for (const n of dirs(root)) add(`${plugin}:${n}`, join(root, n, "SKILL.md"));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function load() { return JSON.parse(readFileSync(existsSync(MAP) ? MAP : DEFAULT, "utf8")); }
function save(map) { mkdirSync(dirname(MAP), { recursive: true }); writeFileSync(MAP, JSON.stringify(map, null, 2) + "\n"); }

export function edit(op, group, skill) {
  const map = load();
  if (!installed().some((s) => s.name === skill)) throw new Error(`not installed: ${skill}`);
  let g = map.groups.find((x) => x.id === group);
  if (!g) { if (op === "rm") return map; g = { id: group, title: group, when: "", skills: [] }; map.groups.push(g); }
  g.skills = op === "add" ? [...new Set([...g.skills, skill])] : g.skills.filter((s) => s !== skill);
  save(map);
  return map;
}

export function paths(project, lane) {
  const map = load(), have = new Map(installed().map((s) => [s.name, s.path]));
  let line = "";
  try { line = readFileSync(join(project, ".tsf/plan.md"), "utf8").match(new RegExp(`^skills ${lane}:(.*)$`, "m"))?.[1] ?? ""; } catch {}
  const names = [];
  for (const tok of line.trim().split(/[\s,]+/).filter(Boolean)) {
    const g = map.groups.find((x) => x.id === tok);
    names.push(...(g ? g.skills : [tok]));
  }
  return [...new Set(names)].map((n) => have.get(n) ?? `missing: ${n}`);
}

export function laneEdit(project, lane, op, token) {
  const map = load();
  if (!map.groups.some((g) => g.id === token) && !installed().some((s) => s.name === token)) throw new Error(`no such group or skill: ${token}`);
  const file = join(project, ".tsf/plan.md"), text = readFileSync(file, "utf8");
  const re = new RegExp(`^skills ${lane}:(.*)$`, "m"), have = text.match(re)?.[1].trim().split(/[\s,]+/).filter(Boolean) ?? [];
  const next = op === "add" ? [...new Set([...have, token])] : have.filter((x) => x !== token);
  const line = `skills ${lane}: ${next.join(" ")}`.trimEnd();
  // Beside the lane's own line when the plan has no skills line for it yet, else at the end.
  const out = re.test(text) ? text.replace(re, line)
    : new RegExp(`^lane ${lane}:.*$`, "m").test(text) ? text.replace(new RegExp(`^(lane ${lane}:.*)$`, "m"), `$1\n${line}`)
    : `${text.replace(/\n*$/, "\n")}${line}\n`;
  writeFileSync(file, out);
  return line;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "installed") console.log(JSON.stringify(installed()));
    else if (cmd === "groups") console.log(JSON.stringify(load()));
    else if (cmd === "add" || cmd === "rm") { edit(cmd, a, b); console.log(`${cmd} ${b} ${cmd === "add" ? "to" : "from"} ${a}`); }
    else if (cmd === "paths") console.log(paths(a, b).join("\n"));
    else if (cmd === "lane" && (process.argv[5] === "add" || process.argv[5] === "rm")) console.log(laneEdit(a, b, process.argv[5], process.argv[6]));
    else { console.error("usage: skills.mjs installed | groups | add|rm <group> <skill> | paths <project dir> <lane> | lane <project dir> <lane> add|rm <token>"); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
