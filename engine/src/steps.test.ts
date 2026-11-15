import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.STUDIO_PROJECTS = mkdtempSync(join(tmpdir(), "studio-steps-"));
const { createSub } = await import("./projects.js");
const { STEP_ORDER, BudgetError, readSteps, remaining, startStep, submitStep, approveStep, requestChanges, reopenStep, setBudget, reserve, settle, pauseWorking, resumeStep, blockStep, readSession, setSession } = await import("./steps.js");
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
test("pause and resume", () => {
  const v = fresh();
  startStep("P", v, "idea"); pauseWorking("P", v);
  assert.equal(readSteps("P", v).steps.idea.paused, true);
  assert.throws(() => startStep("P", v, "idea"), /already working/);
  resumeStep("P", v, "idea");
  assert.equal(readSteps("P", v).steps.idea.paused, undefined);
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
test("reserve validates credits and job id", () => {
  const v = fresh();
  setBudget("P", v, "assets", 50);
  for (const bad of [-1, NaN, 1.5, Infinity]) assert.throws(() => reserve("P", v, "assets", "b", bad), /whole number/);
  reserve("P", v, "assets", "j1", 5);
  assert.throws(() => reserve("P", v, "assets", "j1", 5), /already has a reservation/);
  assert.equal(readSteps("P", v).steps.assets.reservations.length, 1);
});
test("settle validates spent and stops after the first match", () => {
  const v = fresh();
  setBudget("P", v, "assets", 50); reserve("P", v, "assets", "j1", 5);
  assert.throws(() => settle("P", v, "j1", -1), /0 or more/);
  assert.throws(() => settle("P", v, "j1", NaN), /0 or more/);
  assert.equal(readSteps("P", v).steps.assets.reservations.length, 1);
  settle("P", v, "j1", 0);
  assert.equal(readSteps("P", v).steps.assets.spent, 0);
});
test("startStep is refused from working, review and approved", () => {
  const v = fresh();
  startStep("P", v, "idea");
  assert.throws(() => startStep("P", v, "idea"), /already working/);
  submitStep("P", v, "idea", { summary: "s", flags: [] });
  assert.throws(() => startStep("P", v, "idea"), /cannot start from review/);
  approveStep("P", v, "idea");
  assert.throws(() => startStep("P", v, "idea"), /cannot start from approved/);
});
test("one session id per agent kind is stored at the top level and survives step changes", () => {
  const v = fresh();
  assert.equal(readSession("P", v, "claude"), undefined);
  setSession("P", v, "claude", "c-1"); setSession("P", v, "codex", "x-1");
  startStep("P", v, "idea"); submitStep("P", v, "idea", { summary: "s", flags: [] });
  assert.equal(readSession("P", v, "claude"), "c-1");
  assert.equal(readSession("P", v, "codex"), "x-1");
  setSession("P", v, "claude", undefined);
  assert.equal(readSession("P", v, "claude"), undefined);
  assert.equal(readSession("P", v, "codex"), "x-1");
});

// deriveSteps: old sub-projects (no steps.json) mapped onto the five steps, cumulatively, writing nothing.
const { deriveSteps } = await import("./steps.js");
const { readPlan, writePlan, subDir } = await import("./projects.js");
const { existsSync } = await import("node:fs");
type Sc = { n: number; approved?: boolean; kept?: boolean; stale?: number; kind?: "still" | "clip"; start?: { kind: "continue"; from: number } };
const old = (o: { chosen?: string; scenes?: Sc[]; made?: boolean; renders?: number[]; valid?: boolean }) => {
  const plan = readPlan("P", fresh()); plan.options = o.chosen ? [{ id: "a", title: "t", hook: "h", story: "s", scenes: 1 }] : undefined; plan.chosen = o.chosen; plan.scenes = (o.scenes ?? []).map(s => ({ prompt: "p", ...s })) as never;
  return deriveSteps({ plan, scenes: plan.scenes.map(s => ({ n: s.n, validPlan: o.valid ?? true, validSource: true, storyboardExists: o.made ?? true, clipExists: o.made ?? true, hasTakes: false, hasActiveJob: false })), renderVersions: o.renders ?? [], editTaskPhase: null });
};
const flow = (st: ReturnType<typeof old>) => STEP_ORDER.map(k => st.steps[k].status).join(",");
test("derive: nothing chosen is all idle", () => assert.equal(flow(old({})), "idle,idle,idle,idle,idle"));
test("derive: chosen with valid scenes approves idea and plan", () => assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1 }] })), "approved,approved,idle,idle,idle"));
test("derive: chosen with invalid scenes approves only idea", () => assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1 }], valid: false })), "approved,idle,idle,idle,idle"));
test("derive: every scene approved with a still approves look", () => assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1, approved: true }, { n: 2, approved: true }] })), "approved,approved,approved,idle,idle"));
test("derive: an unapproved scene stops look", () => assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1, approved: true }, { n: 2 }] })), "approved,approved,idle,idle,idle"));
test("derive: every scene kept and usable approves assets; a stale clip does not", () => {
  assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1, approved: true, kept: true }, { n: 2, approved: true, kept: true, kind: "still" }] })), "approved,approved,approved,approved,idle");
  assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1, approved: true, kept: true, stale: 1 }] })), "approved,approved,approved,idle,idle");
});
test("derive: a render after assets puts edit in review", () => assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1, approved: true, kept: true }], renders: [1] })), "approved,approved,approved,approved,review"));
test("derive: a render with unapproved scenes leaves edit idle", () => assert.equal(flow(old({ chosen: "a", scenes: [{ n: 1 }], renders: [1] })), "approved,approved,idle,idle,idle"));
test("derive: budgets 0, nothing reserved, paused or running", () => {
  const st = old({ chosen: "a", scenes: [{ n: 1, approved: true, kept: true }], renders: [1] });
  assert.ok(STEP_ORDER.every(k => st.steps[k].budget === 0 && !st.steps[k].reservations.length && !st.steps[k].paused && st.steps[k].status !== "working"));
});
test("deriving writes no file", () => {
  const v = fresh(); const plan = readPlan("P", v); plan.chosen = "a"; writePlan(plan);
  deriveSteps({ plan, scenes: [], renderVersions: [], editTaskPhase: null });
  assert.equal(existsSync(join(subDir("P", v), "steps.json")), false);
});
test("derive: a chosen id that is not one of the options does not approve idea", () => {
  const plan = readPlan("P", fresh()); plan.chosen = "ghost";
  const st = deriveSteps({ plan, scenes: [], renderVersions: [], editTaskPhase: null });
  assert.equal(st.steps.idea.status, "idle");
});
