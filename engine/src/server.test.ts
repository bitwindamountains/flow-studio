import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "fm-server-"));
const port = 20000 + Math.floor(Math.random() * 20000);
process.env.FLOW_MCP_PORT = String(port);
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_OUTPUT = join(home, "out");

test("server: /api/approve needs the UI token, never the flow token", async () => {
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js"); // namespace, so lastServer is read live
  const core = new LocalCore();
  const seen: unknown[] = [];
  // Real approve would start Chrome; a spy proves the endpoint reaches core.queue.approve.
  core.queue.approve = (t) => { seen.push(t); return []; };
  assert.equal(await srv.startServer(core), "owner");
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(base + "/")).text();
  const flow = /const TOKEN = "(\w+)"/.exec(html)![1];
  const ui = /const UI_TOKEN = "(\w+)"/.exec(html)![1];
  const post = (h: Record<string, string>) =>
    fetch(base + "/api/approve", { method: "POST", headers: h, body: JSON.stringify({ batch: "A" }) });

  assert.equal((await post({ "x-flow-token": flow })).status, 403);
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ "x-flow-token": flow, "x-ui-token": ui })).status, 200);
  assert.deepEqual(seen, [{ batch: "A", job_id: undefined }]);
  assert.equal((await fetch(base + "/api/pending", { headers: { "x-flow-token": flow } })).status, 200);
  assert.equal((await fetch(base + "/api/pending")).status, 401);
  srv.lastServer!.closeAllConnections();
  srv.lastServer!.close();
});
