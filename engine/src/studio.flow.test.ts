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
