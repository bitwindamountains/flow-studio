import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
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

test("stale kept clips refuse handoff before moving audio or writing captions", () => {
  const p = mk("Stale");
  p.scenes[2].stale = 1;
  const music = join(tmp, "stale.wav");
  writeFileSync(music, "music");
  assert.throws(() => handoff(p, { music }), /Scene 3.*stale.*redo/i);
  assert.ok(existsSync(music));
  assert.ok(!existsSync(join(subPublicDir("Stale", "s"), "captions.json")));
});

test("music and voiceover moved in as bg.<ext> / vo.<ext>", () => {
  const m = join(tmp, "m.wav"); writeFileSync(m, "m");
  const v = join(tmp, "v.mp3"); writeFileSync(v, "v");
  const r = handoff(mk("Aud"), { music: m, voiceover: v });
  assert.deepEqual([r.music, r.voiceover], ["Aud/s/bg.wav", "Aud/s/vo.mp3"]);
  assert.equal(readFileSync(join(r.dir, "bg.wav"), "utf8"), "m");
  assert.ok(!existsSync(m) && !existsSync(v));
});

test("revision audio is reusable and replacements preserve previous imported files", () => {
  const plan = mk("Versions");
  const first = join(tmp, "first.wav"), next = join(tmp, "next.wav");
  writeFileSync(first, "first"); writeFileSync(next, "next");
  const a = handoff(plan, { music: first });
  assert.equal(handoff(plan, { music: first }).music, a.music);
  const b = handoff(plan, { music: next });
  assert.notEqual(a.music, b.music);
  assert.equal(readFileSync(join(subPublicDir("Versions", "s"), "bg.wav"), "utf8"), "first");
  assert.equal(handoff(plan, {}).music, b.music);
});

test("missing current voiceover does not orphan newly supplied replacement music", () => {
  const plan = mk("AudioRecovery"), first = join(tmp, "recovery-first.wav"), voice = join(tmp, "recovery-voice.wav"), replacement = join(tmp, "recovery-next.wav");
  writeFileSync(first, "first"); writeFileSync(voice, "voice"); writeFileSync(replacement, "replacement");
  handoff(plan, { music: first, voiceover: voice });
  unlinkSync(join(subPublicDir("AudioRecovery", "s"), "vo.wav"));
  assert.throws(() => handoff(plan, { music: replacement }), /missing/i);
  assert.ok(existsSync(replacement), "replacement remains in uploads if another selected file is missing");
  assert.ok(!existsSync(join(subPublicDir("AudioRecovery", "s"), "bg-v2.wav")));
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

test("audio: only audio extensions, never the same file twice, both moves or neither, studio captions only", () => {
  const p = mk("Aud2");
  const txt = join(tmp, "notes.txt"); writeFileSync(txt, "t");
  assert.throws(() => handoff(p, { music: txt }), /audio file/);
  const m = join(tmp, "m2.mp3"); writeFileSync(m, "m");
  assert.throws(() => handoff(p, { music: m, voiceover: m }), /same file/);
  // Existing audio is never overwritten: replacements get their own immutable version.
  mkdirSync(subPublicDir("Aud2", "s"), { recursive: true });
  writeFileSync(join(subPublicDir("Aud2", "s"), "vo.mp3"), "old");
  const v = join(tmp, "v2.mp3"); writeFileSync(v, "v");
  const imported = handoff(p, { music: m, voiceover: v });
  assert.equal(imported.voiceover, "Aud2/s/vo-v2.mp3");
  assert.equal(readFileSync(join(subPublicDir("Aud2", "s"), "vo.mp3"), "utf8"), "old");
  assert.ok(!existsSync(m) && !existsSync(v));
  // A captions.json the studio did not write is never overwritten.
  writeFileSync(join(subPublicDir("Aud2", "s"), "captions.json"), '{"owner":true}');
  assert.throws(() => handoff(p, {}), /not written by the studio/);
});

const stillPlan = (project: string): Plan => {
  const dir = join(tmp, "src-" + project); mkdirSync(dir, { recursive: true });
  const img = (n: string, body: string) => { const p = join(dir, n); writeFileSync(p, body); return p; };
  mkdirSync(clipsDir(project, "s"), { recursive: true });
  const clip = join(clipsDir(project, "s"), "scene-02.mp4"); writeFileSync(clip, "clip");
  return { project, sub: "s", aspect: "16:9", scenes: [
    { n: 1, prompt: "a", kind: "still", kept: true, storyboard: img("one.png", "ONE") },
    { n: 2, prompt: "b", kept: true, clip },
    { n: 3, prompt: "c", kind: "still", kept: true, storyboard: img("three.jpg", "THREE") },
    { n: 4, prompt: "d", kind: "still", kept: false, storyboard: img("four.png", "FOUR") },
  ] };
};

test("handoff copies each kept still to stills/scene-NNN.<ext>, never overwrites a different existing file, and returns scenes in plan order mixing kinds", () => {
  const plan = stillPlan("Stills");
  const r = handoff(plan, {});
  assert.deepEqual(r.scenes.map((s) => [s.n, s.kind, s.file]), [
    [1, "still", "Stills/s/stills/scene-001.png"], [2, "clip", "Stills/s/clips/scene-02.mp4"], [3, "still", "Stills/s/stills/scene-003.jpg"]]);
  assert.deepEqual(r.clips, ["Stills/s/clips/scene-02.mp4"]);
  const dir = join(subPublicDir("Stills", "s"), "stills");
  assert.equal(readFileSync(join(dir, "scene-001.png"), "utf8"), "ONE");
  assert.equal(existsSync(join(dir, "scene-004.png")), false);
  handoff(plan, {}); // same bytes: reused, no -v2
  assert.equal(existsSync(join(dir, "scene-001-v2.png")), false);
  writeFileSync(plan.scenes[0].storyboard!, "ONE-CHANGED");
  assert.equal(handoff(plan, {}).scenes[0].file, "Stills/s/stills/scene-001-v2.png");
  assert.equal(readFileSync(join(dir, "scene-001.png"), "utf8"), "ONE");
  writeFileSync(plan.scenes[0].storyboard!, "ONE-AGAIN");
  assert.equal(handoff(plan, {}).scenes[0].file, "Stills/s/stills/scene-001-v3.png");
});

test("handoff still refuses a kept clip scene with no clip", () => {
  const plan = stillPlan("Stills2");
  delete plan.scenes[1].clip;
  assert.throws(() => handoff(plan, {}), /scene 2 is kept but has no clip/);
  const missing = stillPlan("Stills3"); unlinkSync(missing.scenes[0].storyboard!);
  assert.throws(() => handoff(missing, {}), /Scene 1.*image/);
});
