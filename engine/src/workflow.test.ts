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

const fact = (n: number, storyboardExists: boolean, clipExists: boolean) => ({ n, validPlan: true, validSource: true, storyboardExists, clipExists, hasTakes: false, hasActiveJob: false });
test("kept still with an existing storyboard makes edit open; a kept still whose image is missing locks it", () => {
  const f = base();
  f.plan.scenes = [{ n: 1, prompt: "x", kind: "still", kept: true, storyboard: "a" }, { n: 2, prompt: "y", kept: true, clip: "c" }];
  f.scenes = [fact(1, true, false), fact(2, false, true)];
  assert.equal(deriveWorkflow(f).stages.edit.access, "open");
  f.scenes = [fact(1, false, false), fact(2, false, true)];
  assert.equal(deriveWorkflow(f).stages.edit.access, "locked");
  // a still with an image counts as generated; a clip scene still needs its clip
  f.scenes = [fact(1, true, false), fact(2, false, false)];
  assert.notEqual(deriveWorkflow(f).stages.generate.status, "complete");
  f.scenes = [fact(1, true, false), fact(2, false, true)];
  assert.equal(deriveWorkflow(f).stages.generate.status, "complete");
});

test("300 kept stills and no clips: edit access is open", () => {
  const f = base();
  f.plan.scenes = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, prompt: "x", kind: "still" as const, kept: true, storyboard: "a" }));
  f.scenes = f.plan.scenes.map((s) => fact(s.n, true, false));
  assert.equal(deriveWorkflow(f).stages.edit.access, "open");
});
