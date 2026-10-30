import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan } from "./projects.js";

const tmp = mkdtempSync(join(tmpdir(), "fm-ho-"));
process.env.STUDIO_REMOTION = join(tmp, "remotion");
const { handoff, nextLetter } = await import("./handoff.js");

const clip = (name: string, body: string) => { const p = join(tmp, name); writeFileSync(p, body); return p; };
const mk = (project: string): Plan => ({
  project, sub: "s", aspect: "9:16",
  scenes: [
    { n: 1, prompt: "x", kept: true, clip: clip(`${project}1.mp4`, "one"), caption: "C1", voiceover: "V1" },
    { n: 2, prompt: "x", kept: false, clip: clip(`${project}2.mp4`, "two"), caption: "C2" },
    { n: 3, prompt: "x", kept: true, clip: clip(`${project}3.mp4`, "three"), voiceover: "V3" },
  ],
});

test("copies kept clips in scene order as a.mp4, b.mp4; source clips remain; unkept skipped", () => {
  const plan = mk("Order");
  const r = handoff(plan, {});
  assert.equal(readFileSync(join(r.dir, "a.mp4"), "utf8"), "one");
  assert.equal(readFileSync(join(r.dir, "b.mp4"), "utf8"), "three");
  assert.ok(!existsSync(join(r.dir, "c.mp4")));
  assert.ok(existsSync(plan.scenes[0].clip!) && existsSync(plan.scenes[2].clip!));
  assert.deepEqual(r.files, ["a.mp4", "b.mp4", "captions.json"]);
});

test("existing public/x/a folder -> uses b", () => {
  mkdirSync(join(process.env.STUDIO_REMOTION!, "public", "x", "a"), { recursive: true });
  assert.equal(nextLetter(join(process.env.STUDIO_REMOTION!, "public", "x")), "b");
  assert.ok(handoff(mk("Any"), { folder: "x" }).dir.endsWith(join("x", "b")));
  assert.equal(nextLetter(join(tmp, "nope")), "a");
});

test("music and voiceover named bg.mp3 / vo.mp3", () => {
  const r = handoff(mk("Aud"), { music: clip("m.mp3", "m"), voiceover: clip("v.mp3", "v") });
  assert.equal(readFileSync(join(r.dir, "bg.mp3"), "utf8"), "m");
  assert.equal(readFileSync(join(r.dir, "vo.mp3"), "utf8"), "v");
});

test("captions.json carries planned caption + voiceover text", () => {
  const r = handoff(mk("Cap"), {});
  const c = JSON.parse(readFileSync(join(r.dir, "captions.json"), "utf8"));
  assert.deepEqual(c, [{ scene: 1, caption: "C1", voiceover: "V1" }, { scene: 2, caption: "C2" }, { scene: 3, voiceover: "V3" }]);
});

test("validation: no kept, missing clip, missing music throw before copying", () => {
  const p = mk("Bad");
  assert.throws(() => handoff({ ...p, scenes: [{ n: 1, prompt: "x" }] }, {}), /no kept/);
  assert.throws(() => handoff({ ...p, scenes: [{ n: 1, prompt: "x", kept: true }] }, {}), /no clip/);
  assert.throws(() => handoff({ ...p, scenes: [{ n: 1, prompt: "x", kept: true, clip: join(tmp, "gone.mp4") }] }, {}), /missing/);
  assert.throws(() => handoff(p, { music: join(tmp, "gone.mp3") }), /music/);
  assert.ok(!existsSync(join(process.env.STUDIO_REMOTION!, "public", "Bad")));
});
