import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan } from "./projects.js";

const tmp = mkdtempSync(join(tmpdir(), "fm-ho-"));
process.env.STUDIO_REMOTION = join(tmp, "remotion");
const { handoff, clipsDir, subPublicDir } = await import("./handoff.js");

const mk = (project: string): Plan => {
  mkdirSync(clipsDir(project, "s"), { recursive: true });
  const clip = (n: string) => { const p = join(clipsDir(project, "s"), n); writeFileSync(p, n); return p; };
  return {
    project, sub: "s", aspect: "9:16",
    scenes: [
      { n: 1, prompt: "x", kept: true, clip: clip("scene-01.mp4"), caption: "C1", voiceover: "V1" },
      { n: 2, prompt: "x", kept: false, clip: clip("scene-02.mp4"), caption: "C2" },
      { n: 3, prompt: "x", kept: true, clip: clip("scene-03.mp4"), voiceover: "V3" },
    ],
  };
};

test("kept clips in scene order as staticFile paths; unkept skipped; nothing copied", () => {
  const r = handoff(mk("Order"), {});
  assert.deepEqual(r.clips, ["Order/s/clips/scene-01.mp4", "Order/s/clips/scene-03.mp4"]);
  assert.equal(r.dir, subPublicDir("Order", "s"));
  assert.ok(!existsSync(join(r.dir, "a.mp4")));
});

test("music and voiceover moved in as bg.<ext> / vo.<ext>", () => {
  const m = join(tmp, "m.wav"); writeFileSync(m, "m");
  const v = join(tmp, "v.mp3"); writeFileSync(v, "v");
  const r = handoff(mk("Aud"), { music: m, voiceover: v });
  assert.deepEqual([r.music, r.voiceover], ["Aud/s/bg.wav", "Aud/s/vo.mp3"]);
  assert.equal(readFileSync(join(r.dir, "bg.wav"), "utf8"), "m");
  assert.ok(!existsSync(m) && !existsSync(v));
});

test("captions.json carries planned caption + voiceover text, rewritten on each handoff", () => {
  const p = mk("Cap");
  handoff(p, {});
  p.scenes[1].caption = "C2b";
  const r = handoff(p, {});
  const c = JSON.parse(readFileSync(join(r.dir, "captions.json"), "utf8"));
  assert.deepEqual(c, [{ scene: 1, caption: "C1", voiceover: "V1" }, { scene: 2, caption: "C2b" }, { scene: 3, voiceover: "V3" }]);
});

test("validation: no kept, missing clip, missing music throw before anything is written", () => {
  const p = mk("Bad");
  assert.throws(() => handoff({ ...p, scenes: [{ n: 1, prompt: "x" }] }, {}), /no kept/);
  assert.throws(() => handoff({ ...p, scenes: [{ n: 1, prompt: "x", kept: true }] }, {}), /no clip/);
  assert.throws(() => handoff({ ...p, scenes: [{ n: 1, prompt: "x", kept: true, clip: join(tmp, "gone.mp4") }] }, {}), /missing/);
  assert.throws(() => handoff(p, { music: join(tmp, "gone.mp3") }), /music/);
  assert.ok(!existsSync(join(subPublicDir("Bad", "s"), "captions.json")));
});
