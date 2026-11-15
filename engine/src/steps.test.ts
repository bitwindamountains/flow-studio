import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.STUDIO_PROJECTS = mkdtempSync(join(tmpdir(), "studio-steps-"));
const { createSub } = await import("./projects.js");
const { STEP_ORDER, BudgetError, readSteps, remaining, startStep, submitStep, approveStep, requestChanges, reopenStep, setBudget, reserve, settle, pauseWorking, resumeStep, blockStep } = await import("./steps.js");
let n = 0;
const fresh = () => { const v = `v${n++}`; createSub("P", v); return v; };

test("missing file reads as idle with zero budgets", () => {
  const v = fresh(), s = readSteps("P", v);
  assert.equal(s.rev, 0);
  assert.deepEqual(STEP_ORDER.map(k => s.steps[k].status), ["idle", "idle", "idle", "idle", "idle"]);
  assert.ok(STEP_ORDER.every(k => s.steps[k].budget === 0));
});
test("legal transitions only", () => {
  const v = fresh();
  startStep("P", v, "idea");
  assert.throws(() => approveStep("P", v, "idea"), /not ready for review/);
  submitStep("P", v, "idea", { summary: "3 options", flags: [] });
  assert.equal(readSteps("P", v).steps.idea.status, "review");
  assert.throws(() => submitStep("P", v, "plan", { summary: "x", flags: [] }), /not working/);
  assert.throws(() => startStep("P", v, "idea"), /cannot start/);
  approveStep("P", v, "idea");
  assert.equal(readSteps("P", v).steps.idea.status, "approved");
  assert.throws(() => startStep("P", v, "look"), /Plan is not approved/);
});
test("summary is capped at 3 lines and 400 characters, flag notes at 200", () => {
  const v = fresh();
  startStep("P", v, "idea");
  assert.throws(() => submitStep("P", v, "idea", { summary: "a\nb\nc\nd", flags: [] }), /3 lines/);
  assert.throws(() => submitStep("P", v, "idea", { summary: "x".repeat(401), flags: [] }), /400/);
  assert.throws(() => submitStep("P", v, "idea", { summary: "ok", flags: [{ note: "x".repeat(201) }] }), /200/);
});
test("changes returns the step to the agent with feedback kept in order; blocked reruns", () => {
  const v = fresh();
  startStep("P", v, "idea");
  submitStep("P", v, "idea", { summary: "s", flags: [] });
  assert.throws(() => requestChanges("P", v, "idea", { text: "  " }), /Say what to change/);
  requestChanges("P", v, "idea", { text: "shorter", scene: 2 });
  let a = readSteps("P", v).steps.idea;
  assert.equal(a.status, "changes"); assert.equal(a.feedback[0].text, "shorter");
  startStep("P", v, "idea");
  blockStep("P", v, "idea", "no access");
  a = readSteps("P", v).steps.idea;
  assert.equal(a.status, "blocked"); assert.equal(a.blockedReason, "no access");
  startStep("P", v, "idea");
  a = readSteps("P", v).steps.idea;
  assert.equal(a.status, "working"); assert.equal(a.blockedReason, undefined);
});
test("pause blocks start until resume", () => {
  const v = fresh();
  startStep("P", v, "idea"); pauseWorking("P", v);
  assert.equal(readSteps("P", v).steps.idea.paused, true);
  assert.throws(() => startStep("P", v, "idea"), /paused/);
  resumeStep("P", v, "idea");
  assert.equal(readSteps("P", v).steps.idea.paused, undefined);
  startStep("P", v, "idea", "sess");
  assert.equal(readSteps("P", v).steps.idea.session, "sess");
});
test("reopen resets later steps to idle and keeps their budgets", () => {
  const v = fresh();
  for (const k of ["idea", "plan"] as const) { startStep("P", v, k); submitStep("P", v, k, { summary: "s", flags: [{ note: "f" }] }); approveStep("P", v, k); }
  setBudget("P", v, "assets", 400);
  reopenStep("P", v, "idea");
  const s = readSteps("P", v);
  assert.equal(s.steps.idea.status, "idle"); assert.equal(s.steps.plan.status, "idle");
  assert.equal(s.steps.plan.summary, undefined); assert.deepEqual(s.steps.plan.flags, []);
  assert.equal(s.steps.assets.budget, 400);
});
test("ledger: reserve, settle, shortfall", () => {
  const v = fresh();
  setBudget("P", v, "assets", 50);
  reserve("P", v, "assets", "j1", 20);
  assert.equal(remaining(readSteps("P", v).steps.assets), 30);
  assert.throws(() => reserve("P", v, "assets", "j2", 31), (e: any) => e instanceof BudgetError && e.short === 1);
  settle("P", v, "j1", 7);
  const a = readSteps("P", v).steps.assets;
  assert.equal(a.spent, 7); assert.equal(remaining(a), 43);
  settle("P", v, "j1", 7);
  assert.equal(readSteps("P", v).steps.assets.spent, 7);
});
test("settle without a measured cost counts the reserved cap", () => {
  const v = fresh();
  setBudget("P", v, "assets", 50); reserve("P", v, "assets", "j1", 20); settle("P", v, "j1", undefined);
  assert.equal(readSteps("P", v).steps.assets.spent, 20);
});
test("setBudget refuses negatives, non-integers and a value below spent + reserved", () => {
  const v = fresh();
  assert.throws(() => setBudget("P", v, "assets", -1), /whole number/);
  assert.throws(() => setBudget("P", v, "assets", 1.5), /whole number/);
  setBudget("P", v, "assets", 50); reserve("P", v, "assets", "j1", 20);
  assert.throws(() => setBudget("P", v, "assets", 19), /20/);
  setBudget("P", v, "assets", 20);
  assert.equal(readSteps("P", v).steps.assets.budget, 20);
});
