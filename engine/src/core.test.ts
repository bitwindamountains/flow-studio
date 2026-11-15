import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "fm-core-"));
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_OUTPUT = join(home, "out");
process.env.STUDIO_REMOTION = join(home, "remotion");
process.env.STUDIO_PROJECTS = join(home, "projects");

test("one generate call of 3 video scenes is one approval group; wait does not block on held", async () => {
  const { LocalCore } = await import("./core.js");
  const core = new LocalCore(); // no restore(): nothing is read or written, and held jobs never start
  const scene = { prompt: "a", type: "video" as const, max_credits: 4 };
  const r = (await core.generate({ project: "p", scenes: [scene, scene, scene] } as never)) as { batch: string };
  const groups = core.queue.pendingApproval();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].batch, r.batch);
  assert.equal(groups[0].jobs.length, 3);
  const w = (await core.wait({ timeout_seconds: 30 } as never)) as { finished: boolean; awaiting_approval: string[] };
  assert.equal(w.finished, false);
  assert.equal(w.awaiting_approval.length, 3);
});

test("an edit whose source clip Flow Studio did not make is refused before the browser is touched", async () => {
  const { LocalCore } = await import("./core.js");
  const core = new LocalCore({ queueOpts: { pauseMs: [0, 0] } });
  const r = (await core.edit({ project: "p", asset: "Someone else's clip", prompt: "make it red" } as never)) as { jobs: { id: string }[] };
  core.queue.approve({ job_id: r.jobs[0].id });
  await new Promise((res) => setTimeout(res, 50));
  const job = core.queue.get(r.jobs[0].id)!;
  assert.equal(job.status, "failed");
  assert.match(job.error!, /does not know which Google account holds .*Nothing was generated\./);
});

test("partial agent retry preserves its cached assets' source before queueing", async () => {
  const { LocalCore }=await import("./core.js");
  const file=join(mkdtempSync(join(tmpdir(),"flow-partial-retry-")),"queue.json");
  const core=new LocalCore({runner:async()=>[],queueOpts:{file,pauseMs:[0,0]}});
  core.queue.pause("test source binding");
  core.queue.restore();
  const original=core.queue.add({prompt:"batch",type:"image",max_credits:0,output_dir:tmpdir(),file_stem:"scene-01",agent_scenes:["one","two"],agent_ref_assets:["product"]});
  original.status="done";original.failed_scenes=[2];original.flow={account:"verified-account",flowProject:"/project/11111111-1111-1111-1111-111111111111"};
  await core.retry({job_ids:[original.id]});
  const retry=core.queue.list().find(j=>j.id!==original.id)!;
  assert.deepEqual(retry.params.agent_ref_assets,["product"]);
  assert.deepEqual(retry.flow,original.flow);
  assert.deepEqual(retry.params.agent_numbers,[2]);
  assert.deepEqual(JSON.parse(readFileSync(file,"utf8")).find((j:{id:string})=>j.id===retry.id).flow,original.flow,"binding is persisted atomically with the queued retry");
});

type FixtureJob = { id: string; credits?: number; params: { output_dir: string; file_stem: string; studio?: { scene: number } } };
// Budgeted steps: a sub whose Idea, Plan and Look are approved and whose Assets step is working with `budget` credits.
async function stepFixture(sub: string, budget: number, scenes = 3, runner?: (job: FixtureJob) => string[], file?: string) {
  const { LocalCore } = await import("./core.js");
  const P = await import("./projects.js");
  const S = await import("./steps.js");
  const write = (job: FixtureJob) => {
    mkdirSync(job.params.output_dir, { recursive: true });
    const f = join(job.params.output_dir, job.params.file_stem + ".mp4"); writeFileSync(f, "x"); return [f];
  };
  const core = new LocalCore({ runner: (async (job: FixtureJob) => (runner ?? write)(job)) as never, queueOpts: { pauseMs: [0, 0], ...(file && { file }) } });
  P.createSub("Bud", sub, "16:9");
  const plan = P.readPlan("Bud", sub);
  plan.scenes = Array.from({ length: scenes }, (_, i) => ({ n: i + 1, prompt: `s${i + 1}`, approved: true, model: "Omni 1.1 Flash" }));
  P.writePlan(plan);
  for (const n of ["idea", "plan", "look"] as const) { S.startStep("Bud", sub, n); S.submitStep("Bud", sub, n, { summary: "ok", flags: [] }); S.approveStep("Bud", sub, n); }
  S.setBudget("Bud", sub, "assets", budget);
  S.startStep("Bud", sub, "assets");
  return { core, S, P, write, assets: () => S.readSteps("Bud", sub).steps.assets };
}
const settled = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
const mine = (core: { queue: { list(): { params: { studio?: { sub: string } } }[] } }, sub: string) => core.queue.list().filter((j) => j.params.studio?.sub === sub);

test("studio_generate inside a working Assets step with budget 60 queues all three and reserves 60", async () => {
  const { core, assets } = await stepFixture("b60", 60);
  core.queue.pause("fixture");
  await core.studio_generate({ project: "Bud", sub: "b60" } as never);
  const jobs = core.queue.list().filter((j) => j.params.studio?.sub === "b60");
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.status), ["queued", "queued", "queued"]);
  assert.ok(jobs.every((j) => j.params.studio?.step === "assets"));
  assert.deepEqual(assets().reservations.map((r) => r.job).sort(), jobs.map((j) => j.id).sort());
  assert.equal(assets().reservations.reduce((a, r) => a + r.credits, 0), 60);
  assert.equal(assets().status, "working");
});

test("budget 59: nothing is queued, step is blocked with 'needs 1 more credits'", async () => {
  const { core, assets } = await stepFixture("b59", 59);
  core.queue.pause("fixture");
  await assert.rejects(core.studio_generate({ project: "Bud", sub: "b59" } as never), (e: Error) => e.message === "needs 1 more credits");
  assert.equal(mine(core, "b59").length, 0);
  assert.equal(assets().status, "blocked");
  assert.equal(assets().blockedReason, "needs 1 more credits");
  assert.deepEqual(assets().reservations, []);
});

test("two batches of 20 against budget 30: first queued, second refused whole, step blocked", async () => {
  const { core, assets } = await stepFixture("b30", 30);
  core.queue.pause("fixture");
  await core.studio_generate({ project: "Bud", sub: "b30", scenes: [1] } as never);
  await assert.rejects(core.studio_generate({ project: "Bud", sub: "b30", scenes: [2] } as never), (e: Error) => e.message === "needs 10 more credits");
  const jobs = core.queue.list().filter((j) => j.params.studio?.sub === "b30");
  assert.deepEqual(jobs.map((j) => [j.params.studio?.scene, j.status]), [[1, "queued"]]);
  assert.deepEqual(assets().reservations, [{ job: jobs[0].id, credits: 20 }]);
  assert.equal(assets().status, "blocked");
  assert.equal(assets().blockedReason, "needs 10 more credits");
  // A blocked step releases nothing: the next request is held for the owner exactly as before.
  await core.studio_redo({ project: "Bud", sub: "b30", scene: 2 } as never);
  assert.equal(core.queue.list().find((j) => j.params.studio?.sub === "b30" && j.params.studio.scene === 2)?.status, "held");
});

test("finished job settles its reservation with job.credits, or the cap when credits is undefined", async () => {
  // Scene 1 reports 7 credits, scene 2 reports none (cap 20), scene 3 fails after running (cap 20), scene 4 is cancelled before it runs (0).
  const ctx = await stepFixture("settle", 80, 4, (job) => {
    const n = job.params.studio!.scene;
    if (n === 1) job.credits = 7;
    if (n === 3) throw new Error("Flow failed");
    return ctx.write(job);
  });
  const { core, assets } = ctx;
  core.queue.pause("fixture");
  await core.studio_generate({ project: "Bud", sub: "settle" } as never);
  assert.equal(assets().reservations.length, 4);
  const jobs = core.queue.list().filter((j) => j.params.studio?.sub === "settle");
  core.queue.cancel(jobs[3].id);
  core.queue.resume();
  await settled(() => jobs.every((j) => ["done", "failed", "cancelled"].includes(j.status)));
  assert.deepEqual(jobs.map((j) => j.status), ["done", "done", "failed", "cancelled"]);
  assert.deepEqual(assets().reservations, []);
  assert.equal(assets().spent, 7 + 20 + 20 + 0);
});

test("a job refused before the browser is touched settles with 0", async () => {
  const ctx = await stepFixture("unspent", 20, 1);
  ctx.core.queue.pause("fixture");
  await ctx.core.studio_generate({ project: "Bud", sub: "unspent" } as never);
  const plan = ctx.P.readPlan("Bud", "unspent"); plan.scenes[0].approved = false; ctx.P.writePlan(plan); // prepare() refuses it
  ctx.core.queue.resume();
  const job = mine(ctx.core, "unspent")[0] as unknown as { status: string };
  await settled(() => job.status === "failed");
  assert.equal(job.status, "failed");
  assert.deepEqual(ctx.assets().reservations, []);
  assert.equal(ctx.assets().spent, 0);
});

test("outside a working step studio_generate holds jobs exactly as before", async () => {
  const { LocalCore } = await import("./core.js");
  const P = await import("./projects.js");
  const core = new LocalCore({ runner: async () => [] });
  P.createSub("Bud", "nostep", "16:9");
  const plan = P.readPlan("Bud", "nostep"); plan.scenes = [{ n: 1, prompt: "x", approved: true }]; P.writePlan(plan);
  const r = await core.studio_generate({ project: "Bud", sub: "nostep" } as never) as { held: number };
  assert.equal(r.held, 1);
  const job = core.queue.list().find((j) => j.params.studio?.sub === "nostep")!;
  assert.equal(job.status, "held");
  assert.equal(job.params.studio?.step, undefined);
  assert.equal(existsSync(join(P.subDir("Bud", "nostep"), "steps.json")), false, "no step file is created");
  // A paused working step releases nothing either.
  const ctx = await stepFixture("paused", 60, 1);
  ctx.S.pauseWorking("Bud", "paused");
  await ctx.core.studio_generate({ project: "Bud", sub: "paused" } as never);
  assert.equal(ctx.core.queue.list().find((j) => j.params.studio?.sub === "paused")?.status, "held");
  assert.deepEqual(ctx.assets().reservations, []);
});

test("startup with a working step marks it paused and leaves ledger numbers unchanged", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "flow-step-restart-")), "queue.json");
  const first = await stepFixture("restart", 60, 2, undefined, file);
  first.core.queue.pause("fixture");
  first.core.queue.restore(); // the owner process: from here the queue file is written
  first.S.resumeStep("Bud", "restart", "assets"); // restore paused it; this test wants the step running first
  await first.core.studio_generate({ project: "Bud", sub: "restart" } as never);
  const before = first.assets();
  assert.equal(before.reservations.length, 2);
  const { LocalCore } = await import("./core.js");
  first.P.createSub("Bud", "nosteps", "16:9");
  const core = new LocalCore({ runner: async () => [], queueOpts: { file, pauseMs: [0, 0] } });
  core.queue.pause("fixture");
  core.queue.restore();
  const after = first.assets();
  assert.equal(after.paused, true);
  assert.equal(after.status, "working");
  assert.deepEqual([after.budget, after.spent, after.reservations], [before.budget, before.spent, before.reservations]);
  assert.equal(existsSync(join(first.P.subDir("Bud", "nosteps"), "steps.json")), false, "subs without steps.json get none");
  const jobs = core.queue.list().filter((j) => j.params.studio?.sub === "restart");
  assert.deepEqual(jobs.map((j) => j.status), ["held", "held"]);
  // Only jobs that still hold a reservation are released (a retried job lost its reservation when it first finished).
  const unfunded = core.queue.add({ ...jobs[0].params, file_stem: "scene-01-take-9" });
  assert.equal(unfunded.status, "held");
  assert.deepEqual(core.resumeStepJobs("Bud", "restart", "look"), []);
  assert.deepEqual(core.resumeStepJobs("Bud", "restart", "assets").sort(), jobs.map((j) => j.id).sort());
  assert.deepEqual(jobs.map((j) => j.status), ["queued", "queued"]);
  assert.equal(unfunded.status, "held");
});
