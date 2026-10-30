import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobQueue, type Job, type SceneParams } from "./queue.js";

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
  assert.equal(q.get("abc")?.status, "failed");
  assert.equal(q.get("abc")?.error, "Studio stopped while this was generating — it may have spent credits. Check Flow before retrying.");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].status, "failed");
});

test("status changes persist and reload", async () => {
  const file = join(dir(), "sub", "q.json");
  const q = mk(file);
  q.add(params("image"));
  await tick();
  assert.equal(mk(file).list()[0].status, "done");
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
