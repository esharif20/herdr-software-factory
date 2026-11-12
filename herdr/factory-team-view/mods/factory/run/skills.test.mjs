// node --test run/skills.test.mjs: the Skills views' arithmetic and summaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addable, groupTokens, laneSummary, shortCount, tokensOf } from "./skills.js";

const groups = [
  { id: "always", skills: ["code-structure", "unslop"] },
  { id: "frontend", skills: ["ui-ux-pro-max", "shadcn", "impeccable"] },
  { id: "motion", skills: ["animate", "shadcn"] },
];

test("a group weighs its installed skills at bytes / 4", () => {
  const installed = [{ name: "ui-ux-pro-max", bytes: 8000 }, { name: "shadcn", bytes: 4002 }];
  assert.equal(groupTokens(groups[1], installed), 3001); // impeccable isn't installed: weighs nothing
  assert.equal(tokensOf(undefined), 0);
  assert.deepEqual([shortCount(950), shortCount(3001)], ["950", "3.0k"]);
});

test("a lane line reads as its groups' skills, then its own with +", () => {
  assert.equal(laneSummary(["always", "frontend", "animate"], groups), "ui-ux-pro-max · shadcn · impeccable · +animate");
  assert.equal(laneSummary(["frontend", "motion"], groups), "ui-ux-pro-max · shadcn · impeccable · animate"); // shadcn once
  assert.equal(laneSummary([], groups), "");
});

test("the add list leaves out what is there and filters by the query", () => {
  assert.deepEqual(addable(["tdd", "shadcn", "vercel-plugin:shadcn"], ["shadcn"], " SHAD"), ["vercel-plugin:shadcn"]);
  assert.deepEqual(addable(["tdd", "shadcn"], [], ""), ["tdd", "shadcn"]);
});
