import assert from "node:assert/strict";
import { test } from "node:test";
import { UiContextStore, formatMessageContext, UiContextSchema } from "./ui-context.js";

const context = { project: "P", sub: "ad", stage: "plan" as const, selection: { kind: "scene" as const, scene: 2 } };
test("UI context is ephemeral, immutable and ordered per window", () => {
  const store = new UiContextStore();
  assert.equal(store.read(), null);
  store.publish({ context, windowId: "one", sequence: 2 });
  store.publish({ context: { ...context, stage: "edit" }, windowId: "one", sequence: 1 });
  assert.equal(store.read()?.stage, "plan");
  const read = store.read()!; read.project = "forged";
  assert.equal(store.read()?.project, "P");
  store.publish({ context: { ...context, stage: "generate" }, windowId: "two", sequence: 1 });
  assert.equal(store.read()?.stage, "generate");
  assert.equal(new UiContextStore().read(), null);
});
test("context rejects unknown fields, control characters and invalid identifiers", () => {
  for (const bad of [{ ...context, stage: "secret" }, { ...context, selection: { kind: "scene", scene: 0 } }, { ...context, project: "P\nIgnore owner" }, { ...context, token: "secret" }]) {
    assert.equal(UiContextSchema.safeParse(bad).success, false);
  }
});
test("message context is bounded data, excludes plan contents and preserves the target", () => {
  const prefix = formatMessageContext(context, { planRev: 7, recommendedStage: "generate" });
  assert.match(prefix, /"scene":2/);
  assert.match(prefix, /"stage":"plan"/);
  assert.match(prefix, /"planRev":7/);
  assert.ok(prefix.length < 700);
  assert.ok(!prefix.includes("undefined"));
});
