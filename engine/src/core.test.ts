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

test("studio_generate skips still scenes and lists them in skipped_stills", async () => {
  const { core, P, S } = await stepFixture("stl", 100, 3);
  const plan = P.readPlan("Bud", "stl");
  plan.scenes[1].kind = "still";
  P.writePlan(plan);
  core.queue.pause("fixture");
  const r = await core.studio_generate({ project: "Bud", sub: "stl" } as never) as { queued: number; skipped_stills: number[] };
  assert.deepEqual(r.skipped_stills, [2]);
  assert.equal(r.queued, 2);
  assert.deepEqual(mine(core, "stl").map((j) => (j.params as { studio?: { scene: number } }).studio!.scene).sort(), [1, 3]);
  assert.equal(S.readSteps("Bud", "stl").steps.assets.reservations.length, 2);
  await assert.rejects(core.studio_redo({ project: "Bud", sub: "stl", scene: 2 } as never), /Scene 2 is a still; redo its image with studio_storyboard/);
});

test("studio_plan_write refuses a continue scene whose source is a still; studio_to_remotion returns scenes", async () => {
  const { core, P } = await stepFixture("stl2", 100, 2);
  const plan = P.readPlan("Bud", "stl2");
  plan.scenes[0].kind = "still"; plan.scenes[1].start = { kind: "continue", from: 1 };
  await assert.rejects(core.studio_plan_write({ project: "Bud", sub: "stl2", rev: plan.rev ?? 0, plan } as never), /Scene 2 continues from a still/);
  plan.scenes[1].start = undefined;
  await core.studio_plan_write({ project: "Bud", sub: "stl2", rev: plan.rev ?? 0, plan } as never);
  assert.equal(P.readPlan("Bud", "stl2").scenes[0].kind, "still");
  const img = join(home, "stl2.png"); writeFileSync(img, "i");
  const cur = P.readPlan("Bud", "stl2"); cur.scenes[0].storyboard = img; cur.scenes[0].kept = true; P.writePlan(cur);
  const r = await core.studio_to_remotion({ project: "Bud", sub: "stl2" } as never) as { scenes: { n: number; kind: string }[] };
  assert.deepEqual(r.scenes.map((s) => [s.n, s.kind]), [[1, "still"]]);
});

test("agent step tools: read, submit, blocked, picks, active jobs, no owner tools", async () => {
  const { shapes } = await import("./core.js");
  for (const k of ["studio_step_approve", "studio_step_budget", "studio_step_reopen", "studio_step_resume"]) assert.ok(!(k in shapes), k);
  for (const k of ["studio_step_read", "studio_step_submit", "studio_step_blocked", "studio_production_plan_read", "studio_production_plan_write"]) assert.ok(k in shapes, k);
  const { core, S } = await stepFixture("agt", 60, 2);
  const rd = await core.studio_step_read({ project: "Bud", sub: "agt" } as never) as { step: string; status: string; budget: number; remaining: number; steps: { name: string; status: string }[]; rev: number; paused: boolean; feedback: unknown[] };
  assert.equal(rd.step, "assets"); assert.equal(rd.status, "working"); assert.equal(rd.budget, 60); assert.equal(rd.remaining, 60);
  assert.deepEqual(rd.steps.map((s) => s.name), ["idea", "plan", "look", "assets", "edit"]);
  await assert.rejects(core.studio_step_submit({ project: "Bud", sub: "agt", step: "assets", summary: "x", picks: [{ scene: 1, clip: "C:/nope.mp4" }] } as never), /scene 1/i);
  core.queue.pause("fixture");
  await core.studio_generate({ project: "Bud", sub: "agt" } as never);
  await assert.rejects(core.studio_step_submit({ project: "Bud", sub: "agt", step: "assets", summary: "x" } as never), /2 jobs still running/);
  for (const j of mine(core, "agt")) core.queue.cancel((j as unknown as { id: string }).id);
  const r = await core.studio_step_submit({ project: "Bud", sub: "agt", step: "assets", summary: "done", flags: [{ note: "check" }] } as never) as { steps: { assets: { status: string } } };
  assert.equal(r.steps.assets.status, "review");
  const b = await stepFixture("agb", 10, 1);
  const rb = await b.core.studio_step_blocked({ project: "Bud", sub: "agb", step: "assets", reason: "no ref" } as never) as { steps: { assets: { status: string; blockedReason: string } } };
  assert.deepEqual([rb.steps.assets.status, rb.steps.assets.blockedReason], ["blocked", "no ref"]);
  void S;
});

test("production plan read/write uses revisions and refuses stale writes", async () => {
  const { core, P } = await stepFixture("ppl", 10, 1);
  const a = await core.studio_production_plan_read({ project: "Bud", sub: "ppl" } as never) as { text: string; rev: string };
  assert.equal(a.text, "");
  const w = await core.studio_production_plan_write({ project: "Bud", sub: "ppl", text: "one", rev: a.rev } as never) as { ok: boolean; rev: string };
  assert.equal(w.ok, true);
  await assert.rejects(core.studio_production_plan_write({ project: "Bud", sub: "ppl", text: "two", rev: a.rev } as never), /changed since/);
  assert.equal(readFileSync(join(P.subDir("Bud", "ppl"), "production-plan.md"), "utf8"), "one");
  assert.equal(((await core.studio_production_plan_read({ project: "Bud", sub: "ppl" } as never)) as { text: string }).text, "one");
});

test("funded studio_generate and studio_redo report queued and step with held 0", async () => {
  const { core } = await stepFixture("fq", 100, 2);
  core.queue.pause("fixture");
  const r = await core.studio_generate({ project: "Bud", sub: "fq" } as never) as { queued: number; step: string; held: number };
  assert.deepEqual([r.queued, r.step, r.held], [2, "assets", 0]);
  const x = await core.studio_redo({ project: "Bud", sub: "fq", scene: 1 } as never) as unknown as { already_queued: number[] };
  assert.deepEqual(x.already_queued, [1]); // active already: deduplicated
  for (const j of mine(core, "fq")) core.queue.cancel((j as unknown as { id: string }).id);
  const y = await core.studio_redo({ project: "Bud", sub: "fq", scene: 1 } as never) as unknown as { queued: number; step: string; held: number };
  assert.deepEqual([y.queued, y.step, y.held], [1, "assets", 0]);
});
