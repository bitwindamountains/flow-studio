import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobQueue, Requeue, type Job, type SceneParams } from "./queue.js";

const dir = () => mkdtempSync(join(tmpdir(), "fm-queue-"));
const params = (type: "video" | "image", extra: Partial<SceneParams> = {}): SceneParams => ({
  prompt: "p", type, max_credits: 10, output_dir: "o", file_stem: "scene-01", ...extra,
});
const mk = (file?: string) => new JobQueue(async () => ["f.mp4"], { file, pauseMs: [0, 0] });
const tick = () => new Promise((r) => setTimeout(r, 50));

test("video job starts held; image job runs", async () => {
  const q = mk();
  const v = q.add(params("video"));
  const i = q.add(params("image"));
  await tick();
  assert.equal(v.status, "held");
  assert.equal(i.status, "done");
});

test("approve by batch releases only that batch", async () => {
  const q = mk();
  const a = q.add(params("video"), { batch: "A" });
  const b = q.add(params("video"), { batch: "B" });
  assert.equal(q.pendingApproval().length, 2);
  assert.equal(q.approve({ batch: "A" }).length, 1);
  await tick();
  assert.equal(a.status, "done");
  assert.equal(b.status, "held");
  assert.deepEqual(q.approve({}), []);
});

test("retry of failed video job goes back to held", async () => {
  const q = new JobQueue(async () => { throw new Error("boom"); }, { pauseMs: [0, 0] });
  const j = q.add(params("video"));
  q.approve({ job_id: j.id });
  await tick();
  assert.equal(j.status, "failed");
  assert.equal(q.retry(j.id)?.status, "held");
});

test("running job at load becomes failed with may-have-spent message", () => {
  const file = join(dir(), "q.json");
  const job: Job = { id: "abc", status: "running", params: params("video"), files: [], attempts: 1, createdAt: "x" };
  writeFileSync(file, JSON.stringify([job]));
  const q = mk(file);
  q.restore();
  assert.equal(q.get("abc")?.status, "failed");
  assert.equal(q.get("abc")?.error, "Studio stopped while this was generating — it may have spent credits. Check Flow before retrying.");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].status, "failed");
});

test("status changes persist and reload", async () => {
  const file = join(dir(), "sub", "q.json");
  const q = mk(file);
  q.restore();
  q.add(params("image"));
  await tick();
  const again = mk(file);
  again.restore();
  assert.equal(again.list()[0].status, "done");
});

test("paused queue does not start jobs until resume", async () => {
  const q = mk();
  q.pause("owner away");
  const j = q.add(params("image"));
  await tick();
  assert.equal(j.status, "queued");
  assert.equal(q.pausedReason, "owner away");
  q.resume();
  await tick();
  assert.equal(j.status, "done");
});

test("a queue that never called restore() neither reads nor writes the shared file", async () => {
  const file = join(dir(), "q.json");
  const job: Job = { id: "abc", status: "running", params: params("video"), files: [], attempts: 1, createdAt: "x" };
  const bytes = JSON.stringify([job]);
  writeFileSync(file, bytes);
  const q = mk(file);
  q.add(params("image"));
  await tick();
  assert.equal(q.get("abc"), undefined);
  assert.equal(readFileSync(file, "utf8"), bytes);
});

test("pendingApproval flags unknown cost for edit and continue jobs", () => {
  const q = mk();
  q.add(params("video", { max_credits: 0, edit_asset: "x" }));
  q.add(params("video", { max_credits: 5 }), { batch: "B" });
  const g = q.pendingApproval();
  assert.equal(g.find((x) => !x.batch)!.cost_unknown, true);
  assert.equal(g.find((x) => x.batch === "B")!.cost_unknown, false);
});

test("restore re-holds approved (queued) paid jobs, keeps their batch; free jobs stay queued", async () => {
  const file = join(dir(), "q.json");
  const mkJob = (id: string, p: SceneParams): Job => ({ id, status: "queued", params: p, files: [], attempts: 0, batch: "B", createdAt: "x" });
  writeFileSync(file, JSON.stringify([mkJob("vid", params("video")), mkJob("edt", params("image", { edit_asset: "a" })), mkJob("img", params("image"))]));
  const q = mk(file);
  q.restore();
  assert.equal(q.get("vid")?.status, "held");
  assert.equal(q.get("vid")?.batch, "B");
  assert.equal(q.get("edt")?.status, "held");
  await tick();
  assert.equal(q.get("img")?.status, "done");
  assert.equal(q.get("vid")?.status, "held");
});

test("a Requeue error puts the job back in line, adds to its note, and the note is cleaned when it runs again", async () => {
  let calls = 0;
  const q = new JobQueue(async (j) => {
    if (++calls === 1) {
      j.note = "acct 0 out of credits → acct 1";
      q.pause("All accounts are out of credits.");
      throw new Requeue("All accounts are out of credits.");
    }
    return ["f.png"];
  }, { pauseMs: [0, 0] });
  const job = q.add(params("image"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.finishedAt, undefined);
  assert.equal(job.note, "acct 0 out of credits → acct 1 · All accounts are out of credits.");
  assert.equal(q.pausedReason, "All accounts are out of credits.");
  q.resume();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.status, "done");
  assert.equal(job.note, "acct 0 out of credits → acct 1");
});

test("queued job waits for every whileIdle read, including one that replaced the gate", async () => {
  const q = mk();
  let releaseA!: () => void, releaseB!: () => void;
  void q.whileIdle(() => new Promise<void>((r) => (releaseA = r)));
  const job = q.add(params("image"));
  await tick();
  assert.equal(job.status, "queued");
  void q.whileIdle(() => new Promise<void>((r) => (releaseB = r)));
  releaseA();
  await tick();
  assert.equal(job.status, "queued");
  releaseB();
  await tick();
  assert.equal(job.status, "done");
});

test("whileIdle declines while a job runs", async () => {
  let finish!: () => void;
  const q = new JobQueue(() => new Promise<string[]>((r) => (finish = () => r(["f.jpg"]))), { pauseMs: [0, 0] });
  q.add(params("image"));
  await tick();
  assert.equal(await q.whileIdle(async () => "read"), undefined);
  finish();
});

test("restore: a chained job whose prior was running when the studio stopped is cancelled, not run", async () => {
  const f = join(dir(), "q.json");
  const at = new Date().toISOString();
  const prior = { id: "a", status: "running", params: params("video"), files: [], attempts: 1, batch: "b", createdAt: at };
  const next = { id: "c", status: "queued", params: params("video", { chain_from: "a" }), files: [], attempts: 0, batch: "b", createdAt: at };
  writeFileSync(f, JSON.stringify([prior, next]));
  const q = mk(f);
  q.restore();
  assert.equal(q.get("a")!.status, "failed");
  assert.equal(q.get("c")!.status, "cancelled");
  assert.match(q.get("c")!.note!, /failed.*Nothing spent/);
});

test("image jobs use the shorter image pause; video keeps the long one", async () => {
  const q = new JobQueue(async () => ["f"], { pauseMs: [60_000, 60_000], imagePauseMs: [0, 0] });
  const a = q.add(params("image"));
  const b = q.add(params("image", { file_stem: "scene-02" }));
  await tick();
  assert.equal(a.status, "done");
  assert.equal(b.status, "done"); // with the 60 s video pause this would still be queued
});
