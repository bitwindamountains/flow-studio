import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "fm-sf-"));
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_OUTPUT = join(home, "out");
process.env.STUDIO_PROJECTS = join(home, "projects");

async function setup(sub: string, scenes: object[]) {
  const { LocalCore } = await import("./core.js");
  const { createSub, readPlan, writePlan } = await import("./projects.js");
  const runner = async (job: { params: { output_dir: string; file_stem: string; type: string } }) => {
    mkdirSync(job.params.output_dir, { recursive: true });
    const f = join(job.params.output_dir, job.params.file_stem + (job.params.type === "image" ? ".png" : ".mp4"));
    writeFileSync(f, "x");
    return [f];
  };
  const core = new LocalCore({ runner: runner as never, queueOpts: { pauseMs: [0, 0] } });
  createSub("P", sub, "16:9");
  const plan = readPlan("P", sub);
  plan.scenes = scenes as never;
  writePlan(plan);
  return { core, readPlan };
}
// Writes a plan at the current rev, the way a caller that just read it would.
async function write(core: { studio_plan_write(a: unknown): Promise<unknown> }, sub: string, scenes: object[]) {
  const { readPlan } = await import("./projects.js");
  return core.studio_plan_write({ project: "P", sub, rev: readPlan("P", sub).rev ?? 0, plan: { project: "P", sub, aspect: "16:9", scenes } });
}
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

test("storyboard queues image jobs that run without approval", async () => {
  const { core, readPlan } = await setup("a", [{ n: 1, prompt: "x" }, { n: 2, prompt: "y" }]);
  const r = (await core.studio_storyboard({ project: "P", sub: "a" } as never)) as { job_ids: string[] };
  assert.equal(r.job_ids.length, 2);
  await until(() => !!readPlan("P", "a").scenes[1].storyboard);
  const p = readPlan("P", "a");
  assert.ok(p.scenes[0].storyboard!.endsWith("scene-01.png") && existsSync(p.scenes[0].storyboard!));
  assert.ok(p.scenes[1].storyboard!.endsWith("scene-02.png"));
});

test("generate creates one held batch with the plan's aspect", async () => {
  const { core } = await setup("b", [{ n: 1, prompt: "x", approved: true }, { n: 2, prompt: "y" }, { n: 3, prompt: "z", approved: true }]);
  const r = (await core.studio_generate({ project: "P", sub: "b", duration: 8, resolution: "720p", max_credits: 20 } as never)) as { batch: string; held: number; quoted_max_credits: number };
  assert.equal(r.held, 2);
  assert.equal(r.quoted_max_credits, 40);
  const jobs = core.queue.list();
  assert.ok(jobs.every((j) => j.status === "held" && j.batch === r.batch && j.params.aspect_ratio === "16:9"));
  assert.deepEqual(jobs.map((j) => j.params.file_stem), ["scene-01", "scene-03"]);
  await assert.rejects(core.studio_generate({ project: "P", sub: "b", scenes: [9], duration: 8, resolution: "720p", max_credits: 20 } as never), /Unknown scene 9/);
});

test("generate uses the storyboard still as first_frame", async () => {
  const { core } = await setup("c", [{ n: 1, prompt: "x", approved: true, storyboard: "C:\\s\\scene-01.png" }]);
  await core.studio_generate({ project: "P", sub: "c", duration: 8, resolution: "720p", max_credits: 20 } as never);
  assert.equal(core.queue.list()[0].params.first_frame, "C:\\s\\scene-01.png");
});

test("finished job writes clip path into plan.json", async () => {
  const { core, readPlan } = await setup("d", [{ n: 1, prompt: "x", approved: true }]);
  const r = (await core.studio_generate({ project: "P", sub: "d", duration: 8, resolution: "720p", max_credits: 20 } as never)) as { batch: string };
  core.queue.approve({ batch: r.batch });
  await until(() => !!readPlan("P", "d").scenes[0].clip);
  assert.ok(readPlan("P", "d").scenes[0].clip!.endsWith("scene-01.mp4"));
  const st = (await core.studio_status({ project: "P", sub: "d" } as never)) as { scenes: { jobs: { status: string }[] }[]; pending: unknown[] };
  assert.equal(st.scenes[0].jobs[0].status, "done");
  assert.equal(st.pending.length, 0);
});

test("redo keeps the previous clip file", async () => {
  const { core, readPlan } = await setup("e", [{ n: 1, prompt: "x", approved: true }]);
  const r = (await core.studio_generate({ project: "P", sub: "e", duration: 8, resolution: "720p", max_credits: 20 } as never)) as { batch: string };
  core.queue.approve({ batch: r.batch });
  await until(() => !!readPlan("P", "e").scenes[0].clip);
  const first = readPlan("P", "e").scenes[0].clip!;
  const d = (await core.studio_redo({ project: "P", sub: "e", scene: 1, prompt: "new" } as never)) as { batch: string };
  core.queue.approve({ batch: d.batch });
  await until(() => readPlan("P", "e").scenes[0].clip !== first);
  assert.ok(existsSync(first));
  assert.ok(readPlan("P", "e").scenes[0].clip!.endsWith("scene-01-take-2.mp4"));
});

test("plan_write keeps engine-owned clip/storyboard; incoming (stale) values are ignored, new scenes cannot set them", async () => {
  const { core, readPlan } = await setup("f", [{ n: 1, prompt: "x", approved: true }]);
  const r = (await core.studio_generate({ project: "P", sub: "f", duration: 8, resolution: "720p", max_credits: 20 } as never)) as { batch: string };
  core.queue.approve({ batch: r.batch });
  await until(() => !!readPlan("P", "f").scenes[0].clip);
  const clip = readPlan("P", "f").scenes[0].clip!;
  await write(core, "f", [{ n: 1, prompt: "edited" }]);
  assert.equal(readPlan("P", "f").scenes[0].clip, clip);
  assert.equal(readPlan("P", "f").scenes[0].prompt, "edited");
  await write(core, "f", [{ n: 1, prompt: "edited", clip: "Z:\\other.mp4", storyboard: "Z:\\old.png" }, { n: 2, prompt: "new", clip: "Z:\\c.mp4", storyboard: "Z:\\s.png" }]);
  const sc = readPlan("P", "f").scenes;
  assert.equal(sc[0].clip, clip);
  assert.equal(sc[0].storyboard, undefined);
  assert.equal(sc[1].clip, undefined);
  assert.equal(sc[1].storyboard, undefined);
});

test("plan_write with a stale rev is rejected and changes nothing", async () => {
  const { core, readPlan } = await setup("rev", [{ n: 1, prompt: "x" }]);
  const rev = readPlan("P", "rev").rev!;
  assert.equal(((await write(core, "rev", [{ n: 1, prompt: "y" }])) as { rev: number }).rev, rev + 1);
  await assert.rejects(core.studio_plan_write({ project: "P", sub: "rev", rev, plan: { project: "P", sub: "rev", aspect: "16:9", scenes: [{ n: 1, prompt: "stale" }] } } as never), /Plan changed since you read it/);
  assert.equal(readPlan("P", "rev").scenes[0].prompt, "y");
  const read = (await core.studio_plan_read({ project: "P", sub: "rev" } as never)) as { rev: number };
  assert.equal(read.rev, rev + 1);
});

test("plan_write rejects scene references outside the references/uploads folders", async () => {
  const { core, readPlan } = await setup("refs", [{ n: 1, prompt: "x" }]);
  const { projDir } = await import("./projects.js");
  await assert.rejects(write(core, "refs", [{ n: 1, prompt: "x", references: [join(home, "token")] }]), /reference .* must be inside/);
  await assert.rejects(write(core, "refs", [{ n: 1, prompt: "x", references: [join(projDir("P"), "references", "..", "..", "x.png")] }]), /must be inside/);
  const ok = join(projDir("P"), "references", "a.png");
  writeFileSync(ok, "x");
  await write(core, "refs", [{ n: 1, prompt: "x", references: [ok, join(home, "uploads", "u.png")] }]);
  assert.equal(readPlan("P", "refs").scenes[0].references!.length, 2);
});

test("generate with an explicit scene list still skips (and reports) unapproved scenes", async () => {
  const { core } = await setup("ap", [{ n: 1, prompt: "x", approved: true }, { n: 2, prompt: "y" }]);
  const r = (await core.studio_generate({ project: "P", sub: "ap", scenes: [1, 2], duration: 8, resolution: "720p", max_credits: 20 } as never)) as { held: number; skipped_unapproved: number[] };
  assert.equal(r.held, 1);
  assert.deepEqual(r.skipped_unapproved, [2]);
  assert.deepEqual(core.queue.list().map((j) => j.params.studio!.scene), [1]);
  await assert.rejects(core.studio_generate({ project: "P", sub: "ap", scenes: [2], duration: 8, resolution: "720p", max_credits: 20 } as never), /No approved scenes/);
});

test("to_remotion only takes music/voiceover from uploads and kept clips from the sub's clips folder", async () => {
  const { core, readPlan } = await setup("rm", [{ n: 1, prompt: "x" }]);
  const { writePlan } = await import("./projects.js");
  process.env.STUDIO_REMOTION = mkdtempSync(join(tmpdir(), "fm-rm-"));
  const token = join(home, "token");
  writeFileSync(token, "secret");
  const call = (a: object) => core.studio_to_remotion({ project: "P", sub: "rm", ...a } as never);
  const plan = readPlan("P", "rm");
  plan.scenes[0] = { ...plan.scenes[0], kept: true, clip: token };
  writePlan(plan);
  await assert.rejects(call({}), /kept clip must be inside/);
  const clip = join(home, "projects", "P", "rm", "clips", "scene-01.mp4");
  writeFileSync(clip, "x");
  plan.scenes[0].clip = clip;
  writePlan(plan);
  await assert.rejects(call({ music: token }), /music must be a file uploaded/);
  await assert.rejects(call({ voiceover: token }), /voiceover must be a file uploaded/);
  mkdirSync(join(home, "uploads"), { recursive: true });
  const song = join(home, "uploads", "song.mp3");
  writeFileSync(song, "x");
  const out = (await call({ music: song })) as { files: string[] };
  assert.deepEqual(out.files, ["a.mp4", "bg.mp3", "captions.json"]);
});

test("storyboard reroll resets approved", async () => {
  const { core, readPlan } = await setup("g", [{ n: 1, prompt: "x", approved: true }]);
  await core.studio_storyboard({ project: "P", sub: "g", scenes: [1] } as never);
  await until(() => !!readPlan("P", "g").scenes[0].storyboard);
  assert.equal(readPlan("P", "g").scenes[0].approved, false);
});

test("plan_write cannot set or clear approved/kept", async () => {
  const { core, readPlan } = await setup("h", [{ n: 1, prompt: "x", approved: true, kept: false }]);
  const w = (scenes: object[]) => write(core, "h", scenes);
  await w([{ n: 1, prompt: "x", approved: false, kept: true }, { n: 2, prompt: "new", approved: true, kept: true }]);
  const sc = readPlan("P", "h").scenes;
  assert.equal(sc[0].approved, true);
  assert.equal(sc[0].kept, false);
  assert.equal(sc[1].approved, undefined);
  assert.equal(sc[1].kept, undefined);
});

test("plan_write: content edits clear approval, unchanged rewrite keeps it, an incoming clip cannot swap the kept one", async () => {
  const { core, readPlan } = await setup("i", [{ n: 1, prompt: "x", approved: true, kept: true, clip: "C:\\a.mp4" }]);
  const w = (sc: object) => write(core, "i", [sc]);
  await w({ n: 1, prompt: "x" });
  assert.equal(readPlan("P", "i").scenes[0].approved, true);
  assert.equal(readPlan("P", "i").scenes[0].kept, true);
  await w({ n: 1, prompt: "x", clip: "C:\\b.mp4" });
  assert.equal(readPlan("P", "i").scenes[0].clip, "C:\\a.mp4");
  assert.equal(readPlan("P", "i").scenes[0].kept, true);
  assert.equal(readPlan("P", "i").scenes[0].approved, true);
  await w({ n: 1, prompt: "changed" });
  assert.equal(readPlan("P", "i").scenes[0].approved, false);
});

test("sceneSettings: overrides > scene > defaults; Veo forces 8s and no resolution", async () => {
  const { sceneSettings, VIDEO_DEFAULTS } = await import("./projects.js");
  assert.deepEqual(sceneSettings({}), { model: "Omni 1.1 Flash", duration: 8, resolution: "720p", max_credits: 20 });
  assert.deepEqual(VIDEO_DEFAULTS, { model: "Omni 1.1 Flash", duration: 8, resolution: "720p" });
  assert.deepEqual(sceneSettings({ duration: 4, resolution: "360p" }, { duration: 10 }), { model: "Omni 1.1 Flash", duration: 10, resolution: "360p", max_credits: 20 });
  assert.deepEqual(sceneSettings({ model: "Veo 3.1 - Fast", duration: 4, resolution: "360p" }), { model: "Veo 3.1 - Fast", duration: 8, resolution: undefined, max_credits: 25 });
  assert.equal(sceneSettings({ model: "Veo 3.1 - Quality" }).max_credits, 110);
  assert.equal(sceneSettings({ model: "Mystery" }).max_credits, 25);
});

test("generate with no settings queues Omni 1.1 Flash / 8s / 720p, max 20; scene duration wins over default", async () => {
  const { core } = await setup("set1", [{ n: 1, prompt: "x", approved: true }, { n: 2, prompt: "y", approved: true, duration: 4 }]);
  await core.studio_generate({ project: "P", sub: "set1" } as never);
  const [a, b] = core.queue.list().map((j) => j.params);
  assert.deepEqual([a.model, a.duration, a.resolution, a.max_credits], ["Omni 1.1 Flash", 8, "720p", 20]);
  assert.equal(b.duration, 4);
});

test("redo reuses the scene's own settings; an override duration wins", async () => {
  const { core } = await setup("set2", [{ n: 1, prompt: "x", model: "Omni 1.1 Flash", duration: 4, resolution: "360p" }]);
  await core.studio_redo({ project: "P", sub: "set2", scene: 1 } as never);
  await core.studio_redo({ project: "P", sub: "set2", scene: 1, duration: 10 } as never);
  const [a, b] = core.queue.list().map((j) => j.params);
  assert.deepEqual([a.model, a.duration, a.resolution], ["Omni 1.1 Flash", 4, "360p"]);
  assert.deepEqual([b.model, b.duration, b.resolution], ["Omni 1.1 Flash", 10, "360p"]);
});

test("changing only video settings in plan_write keeps approved", async () => {
  const { core, readPlan } = await setup("set3", [{ n: 1, prompt: "x", approved: true }]);
  await write(core, "set3", [{ n: 1, prompt: "x", duration: 6, model: "Veo 3.1 - Lite" }]);
  const s = readPlan("P", "set3").scenes[0];
  assert.equal(s.approved, true);
  assert.equal(s.duration, 6);
});

test("studio selection: omitted project/sub follow it, none errors, survives a core reload; references are listed", async () => {
  const { core } = await setup("sel", [{ n: 1, prompt: "x" }]);
  const { LocalCore } = await import("./core.js");
  assert.equal(await core.studio_current(), null);
  await assert.rejects(core.studio_status({} as never), /No project selected in the studio - ask the owner to pick one\./);
  await core.studio_select({ project: "P", sub: "sel" });
  assert.deepEqual(await core.studio_current(), { project: "P", sub: "sel" });
  await assert.rejects(core.studio_status({ project: "Other" } as never), /sub is required for project Other/);
  assert.equal(((await core.studio_status({} as never)) as { scenes: unknown[] }).scenes.length, 1);
  assert.equal(((await core.studio_plan_read({} as never)) as { sub: string }).sub, "sel");
  const { projDir, subDir } = await import("./projects.js");
  mkdirSync(join(subDir("P", "sel"), "references"), { recursive: true });
  writeFileSync(join(projDir("P"), "references", "p.png"), "x");
  writeFileSync(join(subDir("P", "sel"), "references", "s.png"), "x");
  const refs = (await core.studio_references({} as never)) as { project: string[]; sub: string[] };
  const names = (l: string[]) => l.map((f) => basename(f));
  assert.ok(names(refs.project).includes("p.png"));
  assert.deepEqual(names(refs.sub), ["s.png"]);
  assert.deepEqual(await new LocalCore().studio_current(), { project: "P", sub: "sel" }); // persisted to selection.json
});

test("storyboard draws frame_prompt, falls back to prompt with a note, skips continue scenes", async () => {
  const { core } = await setup("fp", [
    { n: 1, frame_prompt: "a still", prompt: "clip one" },
    { n: 2, prompt: "clip two" },
    { n: 3, prompt: "clip three", start: { kind: "continue", from: 1 } },
  ]);
  core.queue.pause("hold for inspection");
  const r = (await core.studio_storyboard({ project: "P", sub: "fp" } as never)) as { job_ids: string[]; skipped_continue: number[]; note: string };
  assert.deepEqual(core.queue.list().map((j) => [j.params.studio!.scene, j.params.prompt]), [[1, "a still"], [2, "clip two"]]);
  assert.equal(r.job_ids.length, 2);
  assert.deepEqual(r.skipped_continue, [3]);
  assert.match(r.note, /Scene\(s\) 2 have no frame_prompt/);
});

test("plan_write rejects continue.from that is forward, self or missing; frame_prompt/start changes clear approval", async () => {
  const { core, readPlan } = await setup("st", [{ n: 1, prompt: "a", approved: true }, { n: 2, prompt: "b", approved: true }, { n: 3, prompt: "c", approved: true }]);
  const cont = (from: number) => ({ kind: "continue", from });
  await assert.rejects(write(core, "st", [{ n: 1, prompt: "a", start: cont(2) }, { n: 2, prompt: "b" }]), /earlier scene/);
  await assert.rejects(write(core, "st", [{ n: 1, prompt: "a" }, { n: 2, prompt: "b", start: cont(2) }]), /earlier scene/);
  await assert.rejects(write(core, "st", [{ n: 2, prompt: "b" }, { n: 3, prompt: "c", start: cont(1) }]), /not a scene in this plan/);
  await write(core, "st", [{ n: 1, prompt: "a", start: { kind: "frame" } }, { n: 2, prompt: "b", frame_prompt: "new still" }, { n: 3, prompt: "c", start: cont(2), stale: true }]);
  const sc = readPlan("P", "st").scenes;
  assert.deepEqual(sc.map((s) => s.approved), [true, false, false]); // explicit "frame" equals the default
  assert.equal(sc[2].stale, undefined); // engine-owned
  const plan = { project: "P", sub: "st", aspect: "16:9", scenes: sc, options: [{ id: "o1", title: "t", hook: "h", story: "s", scenes: 3 }] };
  await assert.rejects(core.studio_plan_write({ project: "P", sub: "st", rev: readPlan("P", "st").rev, plan: { ...plan, chosen: "o9" } } as never), /chosen/);
  await core.studio_plan_write({ project: "P", sub: "st", rev: readPlan("P", "st").rev, plan: { ...plan, chosen: "o1" } } as never);
  assert.equal(readPlan("P", "st").chosen, "o1");
});

async function chainSetup(sub: string, scenes: object[], fail?: (job: { params: { studio?: { scene: number } } }) => boolean) {
  const { LocalCore } = await import("./core.js");
  const { createSub, readPlan, writePlan } = await import("./projects.js");
  const ran: { scene?: number; first_frame?: string }[] = [];
  const runner = async (job: { params: { output_dir: string; file_stem: string; type: string; first_frame?: string; studio?: { scene: number } } }) => {
    ran.push({ scene: job.params.studio?.scene, first_frame: job.params.first_frame });
    if (fail?.(job)) throw new Error("Flow reported a failure");
    mkdirSync(job.params.output_dir, { recursive: true });
    const f = join(job.params.output_dir, job.params.file_stem + (job.params.type === "image" ? ".png" : ".mp4"));
    writeFileSync(f, "x");
    return [f];
  };
  const core = new LocalCore({ runner: runner as never, queueOpts: { pauseMs: [0, 0] }, lastFrame: async (v) => `${v}#last` });
  createSub("P", sub, "16:9");
  const plan = readPlan("P", sub);
  plan.scenes = scenes as never;
  writePlan(plan);
  return { core, readPlan, ran };
}
const cont = (from: number) => ({ kind: "continue", from });

test("generate: a continue scene waits for its source job in the batch and starts on its last frame", async () => {
  const { core, readPlan, ran } = await chainSetup("ch1", [
    { n: 3, prompt: "z", approved: true, start: cont(2) }, // listed first on purpose
    { n: 1, prompt: "x", approved: true, storyboard: "C:\\s\\1.png" },
    { n: 2, prompt: "y", approved: true, start: cont(1) },
  ]);
  const r = (await core.studio_generate({ project: "P", sub: "ch1" } as never)) as { batch: string; held: number };
  assert.equal(r.held, 3);
  const jobs = core.queue.list();
  assert.ok(jobs.every((j) => j.status === "held" && j.batch === r.batch)); // one approval covers the chain
  assert.equal(jobs[1].params.chain_from, jobs[0].id);
  assert.equal(jobs[2].params.chain_from, jobs[1].id);
  assert.equal(jobs[2].params.first_frame, undefined);
  core.queue.approve({ batch: r.batch });
  await until(() => !!readPlan("P", "ch1").scenes.find((s) => s.n === 3)!.clip);
  assert.deepEqual(ran.map((x) => x.scene), [1, 2, 3]);
  assert.equal(ran[0].first_frame, "C:\\s\\1.png");
  assert.ok(ran[1].first_frame!.endsWith("scene-01.mp4#last"));
  assert.ok(ran[2].first_frame!.endsWith("scene-02.mp4#last"));
});

test("generate: a failed source cancels its (transitive) continue jobs with a note, nothing run", async () => {
  const { core, ran } = await chainSetup("ch2", [
    { n: 1, prompt: "x", approved: true },
    { n: 2, prompt: "y", approved: true, start: cont(1) },
    { n: 3, prompt: "z", approved: true, start: cont(2) },
  ], (j) => j.params.studio?.scene === 1);
  const r = (await core.studio_generate({ project: "P", sub: "ch2" } as never)) as { batch: string };
  core.queue.approve({ batch: r.batch });
  await until(() => core.queue.list().every((j) => j.status === "failed" || j.status === "cancelled"));
  const [a, b, c] = core.queue.list();
  assert.deepEqual([a.status, b.status, c.status], ["failed", "cancelled", "cancelled"]);
  assert.match(b.note!, /scene 1's clip failed.*Nothing spent/);
  assert.match(c.note!, /scene 2's clip was cancelled/);
  assert.deepEqual(ran.map((x) => x.scene), [1]);
});

test("generate: cancelling the source job cancels the continue job too", async () => {
  const { core } = await chainSetup("ch3", [{ n: 1, prompt: "x", approved: true }, { n: 2, prompt: "y", approved: true, start: cont(1) }]);
  await core.studio_generate({ project: "P", sub: "ch3" } as never);
  const [a, b] = core.queue.list();
  core.queue.cancel(a.id);
  assert.equal(b.status, "cancelled");
});

test("generate: a source scene outside the batch uses its finished clip; none at all is refused before queueing", async () => {
  const { core, ran, readPlan } = await chainSetup("ch4", [
    { n: 1, prompt: "x", clip: "C:\\c\\scene-01.mp4" },
    { n: 2, prompt: "y", approved: true, start: cont(1) },
  ]);
  const r = (await core.studio_generate({ project: "P", sub: "ch4" } as never)) as { batch: string };
  const [j] = core.queue.list();
  assert.equal(j.params.chain_file, "C:\\c\\scene-01.mp4");
  assert.equal(j.params.studio!.from, 1);
  core.queue.approve({ batch: r.batch });
  await until(() => !!readPlan("P", "ch4").scenes[1].clip);
  assert.equal(ran[0].first_frame, "C:\\c\\scene-01.mp4#last");

  const n = await chainSetup("ch5", [{ n: 1, prompt: "x" }, { n: 2, prompt: "y", approved: true, start: cont(1) }]);
  await assert.rejects(n.core.studio_generate({ project: "P", sub: "ch5" } as never), /Scene 1 has no clip yet/);
  assert.equal(n.core.queue.list().length, 0);
});

test("a finished redo marks continuing scenes stale transitively; a dependent redo on the new clip clears it", async () => {
  const { core, readPlan } = await chainSetup("ch6", [
    { n: 1, prompt: "x", clip: "C:\\c\\1.mp4" },
    { n: 2, prompt: "y", clip: "C:\\c\\2.mp4", start: cont(1) },
    { n: 3, prompt: "z", clip: "C:\\c\\3.mp4", start: cont(2) },
    { n: 4, prompt: "w", clip: "C:\\c\\4.mp4" },
  ]);
  const r = (await core.studio_redo({ project: "P", sub: "ch6", scene: 1 } as never)) as { batch: string };
  assert.deepEqual(readPlan("P", "ch6").scenes.map((s) => s.stale), [undefined, undefined, undefined, undefined]); // nothing changed yet
  // Redoing scene 2 before scene 1's redo finished chains to that live job, not to the old clip, and is not cancelled.
  const r2 = (await core.studio_redo({ project: "P", sub: "ch6", scene: 2 } as never)) as { batch: string };
  const [j1, j2] = core.queue.list();
  assert.equal(j2.params.chain_from, j1.id);
  core.queue.approve({ batch: r.batch });
  await until(() => readPlan("P", "ch6").scenes[2].stale !== undefined);
  assert.deepEqual(readPlan("P", "ch6").scenes.map((s) => s.stale), [undefined, 1, 1, undefined]);
  core.queue.approve({ batch: r2.batch });
  await until(() => readPlan("P", "ch6").scenes[1].stale === undefined);
  const sc = readPlan("P", "ch6").scenes;
  assert.equal(j2.status, "done");
  assert.equal(sc[1].stale, undefined);
  assert.equal(sc[2].stale, 2); // now scene 2 is the one that changed under it
});

test("a cancelled source redo leaves no stale marks", async () => {
  const { core, readPlan } = await chainSetup("ch7", [{ n: 1, prompt: "x", clip: "C:\\c\\1.mp4" }, { n: 2, prompt: "y", clip: "C:\\c\\2.mp4", start: cont(1) }]);
  const r = (await core.studio_redo({ project: "P", sub: "ch7", scene: 1 } as never)) as { job_id: string };
  core.queue.cancel(r.job_id);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(readPlan("P", "ch7").scenes[1].stale, undefined);
});

test("a held dependent chained to the old clip is cancelled when the source redo finishes", async () => {
  const { core, readPlan } = await chainSetup("ch8", [{ n: 1, prompt: "x", clip: "C:\\c\\1.mp4" }, { n: 2, prompt: "y", clip: "C:\\c\\2.mp4", start: cont(1) }]);
  await core.studio_redo({ project: "P", sub: "ch8", scene: 2 } as never); // starts on the old clip of scene 1
  const r = (await core.studio_redo({ project: "P", sub: "ch8", scene: 1 } as never)) as { batch: string };
  const [dep] = core.queue.list();
  assert.equal(dep.params.chain_file, "C:\\c\\1.mp4");
  core.queue.approve({ batch: r.batch });
  await until(() => dep.status === "cancelled");
  assert.equal(dep.status, "cancelled");
  assert.match(dep.note!, /Scene 1 changed after this was approved - redo it\. Nothing spent\./);
  assert.equal(readPlan("P", "ch8").scenes[1].stale, 1);
});

test("a dependent finishing on an outdated source keeps stale", async () => {
  const { core, readPlan } = await chainSetup("ch9", [{ n: 1, prompt: "x", clip: "C:\\c\\1.mp4" }, { n: 2, prompt: "y", clip: "C:\\c\\2.mp4", start: cont(1) }]);
  const { writePlan } = await import("./projects.js");
  const r = (await core.studio_redo({ project: "P", sub: "ch9", scene: 2 } as never)) as { batch: string };
  // Scene 1's clip changes while this one is already under way (a running job is never cancelled).
  const plan = readPlan("P", "ch9");
  plan.scenes[0].clip = "C:\\c\\1-take-2.mp4";
  plan.scenes[1].stale = 1;
  writePlan(plan);
  core.queue.approve({ batch: r.batch });
  await until(() => readPlan("P", "ch9").scenes[1].clip !== "C:\\c\\2.mp4");
  assert.equal(readPlan("P", "ch9").scenes[1].stale, 1);
});

test("regenerating a scene through studio_generate marks its dependents", async () => {
  const { core, readPlan } = await chainSetup("ch10", [{ n: 1, prompt: "x", approved: true, clip: "C:\\c\\1.mp4" }, { n: 2, prompt: "y", clip: "C:\\c\\2.mp4", start: cont(1) }]);
  const r = (await core.studio_generate({ project: "P", sub: "ch10" } as never)) as { batch: string; skipped_unapproved: number[] };
  assert.deepEqual(r.skipped_unapproved, [2]);
  core.queue.approve({ batch: r.batch });
  await until(() => readPlan("P", "ch10").scenes[1].stale !== undefined);
  assert.equal(readPlan("P", "ch10").scenes[1].stale, 1);
});

test("plan_write drops stale when a scene stops continuing; prepare does not repeat a reference still", async () => {
  const { core, readPlan } = await chainSetup("ch11", [{ n: 1, prompt: "x" }, { n: 2, prompt: "y", start: cont(1) }]);
  const { writePlan } = await import("./projects.js");
  const plan = readPlan("P", "ch11");
  plan.scenes[1].stale = 1;
  writePlan(plan);
  await write(core, "ch11", [{ n: 1, prompt: "x" }, { n: 2, prompt: "y", start: cont(1) }]);
  assert.equal(readPlan("P", "ch11").scenes[1].stale, 1);
  await write(core, "ch11", [{ n: 1, prompt: "x" }, { n: 2, prompt: "y" }]);
  assert.equal(readPlan("P", "ch11").scenes[1].stale, undefined);

  const prev = core.queue.add({ prompt: "a", type: "image", max_credits: 0, output_dir: join(home, "out", "ref"), file_stem: "scene-01" });
  await until(() => prev.status === "done");
  const still = prev.files[0];
  const next = core.queue.add({ prompt: "b", type: "image", max_credits: 0, output_dir: join(home, "out", "ref"), file_stem: "scene-02", reference_from: prev.id, reference_images: [still] });
  await until(() => next.status === "done");
  assert.deepEqual(next.params.reference_images, [still]);
});
