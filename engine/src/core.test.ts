import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "fm-core-"));
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_OUTPUT = join(home, "out");

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
