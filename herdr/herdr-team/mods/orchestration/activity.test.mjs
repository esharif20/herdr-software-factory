// node activity.test.mjs
import assert from "node:assert/strict";
import { latestActivity } from "./activity.js";

assert.equal(latestActivity("no markers\n> prompt"), null);
assert.equal(latestActivity("⏺ old\n\n⏺ new one\n  wraps here\n\n❯ next"), "new one wraps here");
assert.equal(latestActivity("⏺ Bash(ls)\n  ⎿ a.txt\n  more output"), "Bash(ls)");
assert.equal(latestActivity("• a\n  b\n  c\n  d"), "a b c");
assert.equal(latestActivity("✻ Sautéed for 25s"), null);
console.log("ok");
