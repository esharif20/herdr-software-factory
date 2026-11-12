// node events.test.mjs
import assert from "node:assert/strict";
import { detect, hcMessages } from "./events.js";

assert.deepEqual(hcMessages('❯ <hc from="t3 reviewer">Looks good.</hc>'), [{ from: "t3", text: "Looks good." }]);
assert.deepEqual(hcMessages("› <hc>t2 tests exited (exit 0).</hc>"), [{ from: "t2", text: "t2 tests exited (exit 0)." }]);
assert.deepEqual(hcMessages('❯ <hc from="t1 lead">wraps past the edge'), [{ from: "t1", text: "wraps past the edge" }]);
assert.deepEqual(hcMessages('  const tag = \'<hc from="t3 x">\';'), []); // code that mentions the tag
assert.deepEqual(hcMessages('<hc from="t3 x">no prompt marker</hc>'), []);

const base = { statuses: { t1: "idle", t2: "idle" }, messages: { t1: [], t2: [] }, subagents: [] };
assert.deepEqual(detect(null, base), []);
assert.deepEqual(detect(base, base), []);

// One agent reporting to another, once only.
const hello = { from: "t2", text: "hi" };
const got = { ...base, messages: { t1: [hello], t2: [] } };
assert.deepEqual(detect(base, got), [{ from: "t2", to: "t1", text: "hi" }]);
assert.deepEqual(detect(got, got), []);

// A person's prompt starts a turn; a reported send isn't also counted as one.
const working = { ...base, statuses: { t1: "working", t2: "idle" } };
assert.deepEqual(detect(base, working), [{ from: "you", to: "t1", text: "" }]);
assert.equal(detect(base, { ...got, statuses: working.statuses }).length, 1);

// A sender or subagent outside the grid is ignored.
assert.deepEqual(detect(base, { ...base, messages: { t1: [{ from: "t9", text: "x" }], t2: [] } }), []);
const sub = { id: "a", terminal: "t2", task: "Review" };
assert.deepEqual(detect(base, { ...base, subagents: [sub] }), [{ from: "t2", to: "t2", subagent: true, text: "Review" }]);
assert.deepEqual(detect({ ...base, subagents: [sub] }, { ...base, subagents: [sub] }), []);
// An off-screen session starting work isn't credited to the person.
assert.deepEqual(detect({ statuses: { t9: "idle" }, messages: {}, subagents: [] }, { statuses: { t9: "working" }, messages: {}, subagents: [] }), []);
console.log("ok");
