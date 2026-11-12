// node --no-warnings skills.test.mjs: a lane resolves to `always` plus its plan line's groups and skills; edits stick.
import assert from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const t = mkdtempSync(join(tmpdir(), "skills-"));
const home = join(t, "home"), p = join(t, "p");
for (const n of ["code-structure", "unslop", "tdd", "codebase-design", "shadcn"]) { mkdirSync(join(home, ".claude/skills", n), { recursive: true }); writeFileSync(join(home, ".claude/skills", n, "SKILL.md"), n); }
mkdirSync(join(home, ".claude/plugins/cache/m/vp/1.2.0/skills/ai-sdk"), { recursive: true }); writeFileSync(join(home, ".claude/plugins/cache/m/vp/1.2.0/skills/ai-sdk/SKILL.md"), "x");
mkdirSync(join(home, ".claude/plugins/cache/m/vp/1.10.0/skills/ai-sdk"), { recursive: true }); writeFileSync(join(home, ".claude/plugins/cache/m/vp/1.10.0/skills/ai-sdk/SKILL.md"), "x");
mkdirSync(join(p, ".tsf"), { recursive: true }); writeFileSync(join(p, ".tsf/plan.md"), "lane api: GH-1\nskills api: backend shadcn\n");
const run = (...a) => execFileSync("node", [new URL("skills.mjs", import.meta.url).pathname, ...a], { env: { ...process.env, SKILLS_HOME: home, SKILLS_MAP: join(t, "map.json") }, encoding: "utf8" }).trim();
const names = (out) => out.split("\n").map((l) => l.split("/").at(-2));

assert.deepEqual(names(run("paths", p, "api")), ["tdd", "codebase-design", "shadcn"]);
assert.equal(run("paths", p, "other"), ""); // no plan line: nothing (always lives in the plan)
assert.ok(JSON.parse(run("installed")).find((s) => s.name === "vp:ai-sdk").path.includes("/1.10.0/")); // newest plugin version
run("rm", "backend", "tdd");
assert.deepEqual(names(run("paths", p, "api")), ["codebase-design", "shadcn"]);
assert.throws(() => run("add", "always", "nope"));
// A lane's plan line: edited in place, made beside its lane line when missing, unknown names refused.
assert.equal(run("lane", p, "api", "add", "always"), "skills api: backend shadcn always");
assert.equal(run("lane", p, "api", "rm", "shadcn"), "skills api: backend always");
assert.equal(run("lane", p, "web", "add", "shadcn"), "skills web: shadcn");
assert.throws(() => run("lane", p, "api", "add", "nope"));
assert.equal(readFileSync(join(p, ".tsf/plan.md"), "utf8"), "lane api: GH-1\nskills api: backend always\nskills web: shadcn\n");
mkdirSync(join(p, ".tsf"), { recursive: true }); writeFileSync(join(p, ".tsf/plan.md"), "lane web: GH-2\nlane api: GH-1\n");
run("lane", p, "web", "add", "backend");
assert.equal(readFileSync(join(p, ".tsf/plan.md"), "utf8"), "lane web: GH-2\nskills web: backend\nlane api: GH-1\n");
console.log("ok");
