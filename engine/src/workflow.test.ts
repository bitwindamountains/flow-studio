import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveWorkflow, type WorkflowFacts } from "./workflow.js";

const base = (): WorkflowFacts => ({ plan: { project: "P", sub: "ad", aspect: "9:16", scenes: [] }, scenes: [], renderVersions: [], editTaskPhase: null });
test("future stages lock until a choice, legacy scenes remain editable", () => {
  const f = base();
  assert.equal(deriveWorkflow(f).stages.plan.access, "locked");
  f.plan.options = [{ id: "o1", title: "One", hook: "Hook", story: "Story", scenes: 1 }];
  f.plan.chosen = "missing";
  assert.equal(deriveWorkflow(f).stages.plan.access, "locked");
  f.plan.chosen = "o1";
  assert.equal(deriveWorkflow(f).stages.plan.access, "open");
  delete f.plan.chosen;
  f.plan.scenes = [{ n: 3, prompt: "camera moves" }];
  f.scenes = [{ n: 3, validPlan: true, validSource: true, storyboardExists: false, clipExists: false, hasTakes: false, hasActiveJob: false }];
  assert.equal(deriveWorkflow(f).stages.plan.access, "open");
  assert.equal(deriveWorkflow(f).stages.storyboard.access, "open");
  assert.equal(deriveWorkflow(f).stages.generate.access, "locked");
});
test("approved subsets unlock generation; edit requires only the usable kept set", () => {
  const f = base();
  f.plan.scenes = [{ n: 1, prompt: "x", approved: true, kept: true, clip: "a" }, { n: 2, prompt: "y", stale: 1 }];
  f.scenes = f.plan.scenes.map(s => ({ n: s.n, validPlan: true, validSource: true, storyboardExists: true, clipExists: s.n === 1, hasTakes: false, hasActiveJob: false }));
  assert.equal(deriveWorkflow(f).stages.generate.access, "open");
  assert.equal(deriveWorkflow(f).stages.edit.access, "open");
  f.plan.scenes[0].stale = 2;
  assert.equal(deriveWorkflow(f).stages.edit.access, "locked");
  f.renderVersions = [1];
  assert.equal(deriveWorkflow(f).stages.edit.access, "review");
  assert.equal(deriveWorkflow(f).stages.edit.status, "needs_attention");
  assert.equal(deriveWorkflow(f).recommendedStage, "generate");
});
test("missing kept media blocks editing and active jobs retain monitoring access", () => {
  const f = base();
  f.plan.scenes = [{ n: 7, prompt: "x", kept: true, clip: "missing" }];
  f.scenes = [{ n: 7, validPlan: true, validSource: true, storyboardExists: false, clipExists: false, hasTakes: false, hasActiveJob: true }];
  assert.equal(deriveWorkflow(f).stages.generate.access, "review");
  assert.equal(deriveWorkflow(f).stages.edit.access, "locked");
  f.editTaskPhase = "rendering";
  assert.equal(deriveWorkflow(f).stages.edit.access, "review");
});
test("invalid scene sources block new storyboard work while retaining old artifacts", () => {
  const f = base();
  f.plan.scenes = [{ n: 2, prompt: "x", start: { kind: "continue", from: 99 } }];
  f.scenes = [{ n: 2, validPlan: true, validSource: false, storyboardExists: false, clipExists: false, hasTakes: false, hasActiveJob: false }];
  assert.equal(deriveWorkflow(f).stages.storyboard.access, "locked");
  f.scenes[0].storyboardExists = true;
  assert.equal(deriveWorkflow(f).stages.storyboard.access, "review");
});

test("a kept scene without a clip blocks editing even alongside a usable kept scene", () => {
  const f = base();
  f.plan.scenes = [{ n: 1, prompt: "x", kept: true, clip: "a" }, { n: 2, prompt: "y", kept: true }];
  f.scenes = f.plan.scenes.map(s => ({ n: s.n, validPlan: true, validSource: true, storyboardExists: false, clipExists: s.n === 1, hasTakes: false, hasActiveJob: false }));
  assert.equal(deriveWorkflow(f).stages.edit.access, "locked");
});
