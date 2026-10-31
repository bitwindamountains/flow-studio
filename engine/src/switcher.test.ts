import test from "node:test";
import assert from "node:assert/strict";
import { planSwitch, projectKey } from "./switcher.js";
import type { Account } from "./accounts.js";

const now = new Date("2026-10-31T10:00:00");
const later = new Date("2026-11-01T04:59:00").toISOString();
const accts: Account[] = [
  { index: 0, email: "a@x.test", credits: 50 },
  { index: 1, email: "b@x.test", credits: 3 },
  { index: 2, email: "c@x.test", credits: 40 },
];

test("enough credits -> use", () => {
  assert.deepEqual(planSwitch("a@x.test", 50, 20, accts, now), { action: "use" });
});
test("unreadable balance -> use (Flow itself still refuses a short account)", () => {
  assert.deepEqual(planSwitch("a@x.test", undefined, 20, accts, now), { action: "use" });
});
test("short -> switch to next eligible (not the active one, not a too-poor one)", () => {
  assert.deepEqual(planSwitch("a@x.test", 5, 20, accts, now), { action: "switch", to: accts[2] });
});
test("none eligible -> pause", () => {
  const blocked = accts.map((a) => ({ ...a, exhaustedUntil: a.index === 2 ? later : undefined }));
  assert.deepEqual(planSwitch("a@x.test", 5, 20, blocked, now), { action: "pause" });
});
test("active email undefined -> throws wrong-account error", () => {
  assert.throws(() => planSwitch(undefined, 50, 20, accts, now), /Switched to the wrong account .*Nothing was generated\./);
});
test("projectKey: studio jobs per sub-project, others share _default", () => {
  assert.equal(projectKey("a@x.test", { project: "P", sub: "s" }), "a@x.test|P/s");
  assert.equal(projectKey("a@x.test"), "a@x.test|_default");
});
