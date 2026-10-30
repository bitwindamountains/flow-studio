import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("plan_write keeps engine-owned clip path; explicit clip wins", async () => {
  const { core, readPlan } = await setup("f", [{ n: 1, prompt: "x", approved: true }]);
  const r = (await core.studio_generate({ project: "P", sub: "f", duration: 8, resolution: "720p", max_credits: 20 } as never)) as { batch: string };
  core.queue.approve({ batch: r.batch });
  await until(() => !!readPlan("P", "f").scenes[0].clip);
  const clip = readPlan("P", "f").scenes[0].clip!;
  await core.studio_plan_write({ project: "P", sub: "f", plan: { project: "P", sub: "f", aspect: "16:9", scenes: [{ n: 1, prompt: "edited" }] } } as never);
  assert.equal(readPlan("P", "f").scenes[0].clip, clip);
  assert.equal(readPlan("P", "f").scenes[0].prompt, "edited");
  await core.studio_plan_write({ project: "P", sub: "f", plan: { project: "P", sub: "f", aspect: "16:9", scenes: [{ n: 1, prompt: "e", clip: "Z:\other.mp4" }] } } as never);
  assert.equal(readPlan("P", "f").scenes[0].clip, "Z:\other.mp4");
});

test("storyboard reroll resets approved", async () => {
  const { core, readPlan } = await setup("g", [{ n: 1, prompt: "x", approved: true }]);
  await core.studio_storyboard({ project: "P", sub: "g", scenes: [1] } as never);
  await until(() => !!readPlan("P", "g").scenes[0].storyboard);
  assert.equal(readPlan("P", "g").scenes[0].approved, false);
});
