import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.STUDIO_PROJECTS = mkdtempSync(join(tmpdir(), "fm-proj-")); // root is also read lazily
const P = await import("./projects.js");

test("createSub makes the folder layout and 9:16 default", () => {
  const d = P.createSub("Aqua", "v1");
  for (const f of ["storyboard", "clips", "notes.md", "plan.json"]) assert.ok(existsSync(join(d, f)), f);
  assert.ok(existsSync(join(d, "..", "references")));
  assert.equal(P.readPlan("Aqua", "v1").aspect, "9:16");
  assert.deepEqual(P.listProjects(), [{ project: "Aqua", subs: ["v1"] }]);
});

test("createSub twice throws", () => {
  P.createSub("Dup", "a");
  assert.throws(() => P.createSub("Dup", "a"), /exists/);
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
  P.createSub("RT", "s");
  const plan = { project: "RT", sub: "s", aspect: "16:9" as const, scenes: [{ n: 1, prompt: "x" }] };
  P.writePlan(plan);
  assert.deepEqual(P.readPlan("RT", "s"), plan);
  P.writeNotes("RT", "s", "hi");
  assert.equal(P.readNotes("RT", "s"), "hi");
});

test("addReference copies, never overwrites", () => {
  P.createSub("Ref", "s");
  const src = join(mkdtempSync(join(tmpdir(), "fm-src-")), "a.png");
  writeFileSync(src, "x");
  const a = P.addReference("Ref", undefined, src);
  const b = P.addReference("Ref", undefined, src);
  const c = P.addReference("Ref", "s", src);
  assert.ok(existsSync(src) && existsSync(a) && existsSync(b) && existsSync(c));
  assert.notEqual(a, b);
  assert.ok(c.includes(join("s", "references")));
});

test("PlanSchema rejects duplicate scene numbers", () => {
  const bad = { project: "p", sub: "s", aspect: "9:16", scenes: [{ n: 1, prompt: "a" }, { n: 1, prompt: "b" }] };
  assert.equal(P.PlanSchema.safeParse(bad).success, false);
});
