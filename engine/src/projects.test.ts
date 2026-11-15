import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.STUDIO_PROJECTS = mkdtempSync(join(tmpdir(), "fm-proj-")); // root is also read lazily
const P = await import("./projects.js");

test("createSub makes the folder layout and 9:16 default", () => {
  const d = P.createSub("Aqua", "v1");
  for (const f of ["storyboard", "notes.md", "plan.json"]) assert.ok(existsSync(join(d, f)), f);
  assert.ok(!existsSync(join(d, "clips")), "clips live in Remotion public, not here");
  assert.ok(existsSync(join(d, "..", "references")));
  assert.equal(P.readPlan("Aqua", "v1").aspect, "9:16");
  assert.deepEqual(P.readPlan("Aqua", "v1").references, [], "new ads must not inherit shared product references");
  assert.deepEqual(P.listProjects(), [{ project: "Aqua", subs: ["v1"] }]);
});

test("createSub twice throws", () => {
  P.createSub("Dup", "aa");
  assert.throws(() => P.createSub("Dup", "aa"), /exists/);
});

test("safeName", () => {
  assert.equal(P.safeName("Aqua Pure!"), "Aqua-Pure");
  assert.throws(() => P.safeName("!!"));
});

test("path traversal: safeName('../x') has no '..' or separators", () => {
  const s = P.safeName("../x");
  assert.ok(!s.includes("..") && !/[\/]/.test(s));
});

test("writePlan/readPlan round-trip and notes", () => {
  P.createSub("RT", "ss");
  const plan = { project: "RT", sub: "ss", aspect: "16:9" as const, scenes: [{ n: 1, prompt: "x" }] };
  P.writePlan(plan);
  assert.deepEqual(P.readPlan("RT", "ss"), { ...plan, rev: 1 });
  P.writePlan(P.readPlan("RT", "ss"));
  assert.equal(P.readPlan("RT", "ss").rev, 2);
  P.writeNotes("RT", "ss", "hi");
  assert.equal(P.readNotes("RT", "ss"), "hi");
});

test("addReference copies, never overwrites", () => {
  P.createSub("Ref", "ss");
  const root = mkdtempSync(join(tmpdir(), "fm-src-"));
  const src = join(root, "a.png");
  writeFileSync(src, "x");
  const a = P.addReference("Ref", undefined, src, [root]);
  const b = P.addReference("Ref", undefined, src, [root]);
  const c = P.addReference("Ref", "ss", src, [root]);
  assert.ok(existsSync(src) && existsSync(a) && existsSync(b) && existsSync(c));
  assert.notEqual(a, b);
  assert.ok(c.includes(join("ss", "references")));
});

test("PlanSchema rejects duplicate scene numbers", () => {
  const bad = { project: "p", sub: "ss", aspect: "9:16", scenes: [{ n: 1, prompt: "aa" }, { n: 1, prompt: "b" }] };
  assert.equal(P.PlanSchema.safeParse(bad).success, false);
});

test("addReference rejects a source outside the allowed roots", () => {
  P.createSub("Ref2", "ss");
  const outside = join(mkdtempSync(join(tmpdir(), "fm-out-")), "b.png");
  writeFileSync(outside, "x");
  assert.throws(() => P.addReference("Ref2", undefined, outside, [mkdtempSync(join(tmpdir(), "fm-ok-"))]), /inside/);
});

test("reserved names rejected", () => {
  P.createSub("Res", "ok");
  for (const n of ["references", "References", "con", "NUL", "com1"]) assert.throws(() => P.createSub("Res", n), /reserved/, n);
  assert.throws(() => P.createSub("con", "xx"), /reserved/);
  assert.throws(() => P.createSub("Aqua", "b"), /too short/);
});

test("missing sub: notes/plan throw and create nothing", () => {
  const d = join(process.env.STUDIO_PROJECTS!, "Ghost");
  assert.throws(() => P.readNotes("Ghost", "x"), /No sub-project Ghost\/x/);
  assert.throws(() => P.writeNotes("Ghost", "x", "t"), /No sub-project/);
  assert.throws(() => P.writePlan({ project: "Ghost", sub: "x", aspect: "9:16", scenes: [] }), /No sub-project/);
  assert.ok(!existsSync(d));
});

test("readPlan('..','x') stays inside root and throws", () => {
  assert.throws(() => P.readPlan("..", "x"), /Invalid name|No plan/);
});

test("writeNotes with a stale base rev is rejected", () => {
  P.createSub("Nt", "ss");
  const base = P.notesRev(P.readNotes("Nt", "ss"));
  const next = P.writeNotes("Nt", "ss", "first", base);
  assert.throws(() => P.writeNotes("Nt", "ss", "second", base), /changed since you read/);
  assert.equal(P.readNotes("Nt", "ss"), "first");
  P.writeNotes("Nt", "ss", "second", next);
  assert.equal(P.readNotes("Nt", "ss"), "second");
});

test("a plan without kind parses and every scene is a clip", () => {
  const plan = P.PlanSchema.parse({ project: "K", sub: "s", aspect: "9:16", scenes: [{ n: 1, prompt: "a" }, { n: 2, prompt: "b", kind: "still", section: "Intro" }] });
  assert.equal("kind" in plan.scenes[0], false);
  assert.deepEqual(plan.scenes.map(P.isStill), [false, true]);
  assert.throws(() => P.PlanSchema.parse({ project: "K", sub: "s", aspect: "9:16", scenes: [{ n: 1, prompt: "a", section: "x".repeat(61) }] }));
});
