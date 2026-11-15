import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "fm-core-"));
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_OUTPUT = join(home, "out");
process.env.STUDIO_REMOTION = join(home, "remotion");

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
