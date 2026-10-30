import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { get } from "node:http";
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
  const second = await (await fetch(base + "/")).text();
  assert.match(second, /const UI_TOKEN = "";/);
  const ui = /const UI_TOKEN = "(\w+)"/.exec(html)![1];
  const post = (h: Record<string, string>) =>
    fetch(base + "/api/approve", { method: "POST", headers: h, body: JSON.stringify({ batch: "A" }) });

  assert.equal((await post({ "x-flow-token": flow })).status, 403);
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ "x-ui-token": "" })).status, 403);
  assert.equal((await post({ "x-flow-token": flow, "x-ui-token": ui })).status, 200);
  assert.deepEqual(seen, [{ batch: "A", job_id: undefined }]);
  assert.equal((await fetch(base + "/api/pending", { headers: { "x-flow-token": flow } })).status, 200);
  assert.equal((await fetch(base + "/api/pending")).status, 401);
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});

test("pty websocket: rejects missing token, bad Origin, bad Host; one process per session", async () => {
  const { WebSocket } = await import("ws");
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js");
  const { EventEmitter } = await import("node:events");
  let spawned = 0;
  const writes: string[] = [];
  const ev = new EventEmitter();
  const fake = {
    onData: (f: (d: string) => void) => { ev.on("d", f); return { dispose() {} }; },
    onExit: (f: () => void) => { ev.on("x", f); return { dispose() {} }; },
    write: (d: string) => void writes.push(d), resize() {}, kill: () => void ev.emit("x"),
  };
  const spawner = () => { spawned++; return fake as never; };
  assert.equal(await srv.startServer(new LocalCore(), spawner as never), "owner");
  // node:http with a throwaway agent: fetch's pooled socket from the previous test's server is dead.
  const html = await new Promise<string>((ok, bad) => get(`http://127.0.0.1:${port}/`, { agent: false }, (r) => { let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => ok(t)); }).on("error", bad));
  const ui = /const UI_TOKEN = "(\w+)"/.exec(html)![1];
  const origin = `http://127.0.0.1:${port}`;
  const socks: { terminate(): void }[] = [];
  const open = (path: string, headers: Record<string, string>) => new Promise<string>((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    socks.push(ws);
    ws.on("open", () => ok("open:" + ws.url));
    ws.on("unexpected-response", (_q, r) => { ok("rejected:" + r.statusCode); ws.terminate(); });
    ws.on("error", () => {});
  });
  assert.match(await open("/pty", { origin }), /rejected:403/);
  assert.match(await open("/pty?ui=wrong", { origin }), /rejected:403/);
  assert.match(await open(`/pty?ui=${ui}`, { origin: "http://evil.example" }), /rejected:403/);
  assert.match(await open(`/pty?ui=${ui}`, {}), /rejected:403/);
  assert.match(await open(`/pty?ui=${ui}`, { origin, host: "evil.example" }), /rejected:403/);
  assert.equal(spawned, 0);
  const a = await open(`/pty?ui=${ui}`, { origin });
  const b = await open(`/pty?ui=${ui}`, { origin });
  assert.match(a, /^open:/); assert.match(b, /^open:/);
  assert.equal(spawned, 1);
  // fetch cannot set Host; node:http can.
  const status = (path: string, host?: string) => new Promise<number>((ok, bad) =>
    get(`http://127.0.0.1:${port}${path}`, { agent: false, headers: host ? { host } : {} }, (r) => { r.resume(); ok(r.statusCode!); }).on("error", bad));
  assert.equal(await status("/api/accounts"), 200);
  assert.equal(await status("/api/accounts", "evil.example"), 403);
  assert.equal(await status("/vendor/..%2fpackage.json"), 404);
  assert.equal(await status("/vendor/constructor"), 404);
  assert.equal(await status("/vendor/xterm.js"), 200);
  for (const w of socks) w.terminate();
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});

test("pty websocket: garbage frames and a throwing spawner never crash the server", async () => {
  const { WebSocket } = await import("ws");
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js");
  assert.equal(await srv.startServer(new LocalCore(), (() => { throw new Error("no claude here"); }) as never), "owner");
  const html = await new Promise<string>((ok, bad) => get(`http://127.0.0.1:${port}/`, { agent: false }, (r) => { let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => ok(t)); }).on("error", bad));
  const ui = /const UI_TOKEN = "(\w+)"/.exec(html)![1];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?ui=${ui}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const first = await new Promise<string>((ok, bad) => { ws.once("message", (d) => ok(d.toString())); ws.once("error", bad); });
  assert.match(first, /could not start claude: no claude here/);
  for (const g of ["null", "5", "[]", "garbage", '"x"', '{"t":"i","d":1}', '{"t":"r","cols":-1}']) ws.send(g);
  ws.send(JSON.stringify({ t: "restart" })); // spawner still throws: reported, not thrown
  await new Promise((r) => setTimeout(r, 200));
  const status = await new Promise<number>((ok, bad) => get(`http://127.0.0.1:${port}/api/health`, { agent: false }, (r) => { r.resume(); ok(r.statusCode!); }).on("error", bad));
  assert.equal(status, 200);
  ws.terminate();
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});

test("server: scene, cancel and remotion/dev need the UI token and do only their one thing", async () => {
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js");
  const { createSub, readPlan, writePlan } = await import("./projects.js");
  process.env.STUDIO_PROJECTS = join(home, "projects");
  createSub("P", "s", "9:16");
  const plan = readPlan("P", "s");
  plan.scenes = [{ n: 1, prompt: "x" }];
  writePlan(plan);
  const core = new LocalCore();
  const held = core.queue.add({ prompt: "p", type: "video", max_credits: 5 } as never);
  const starts: string[] = [];
  let up = false;
  assert.equal(await srv.startServer(core, undefined, { answering: async () => up, start: (cwd) => void starts.push(cwd) }), "owner");
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(base + "/", { headers: { connection: "close" } })).text();
  const ui = /const UI_TOKEN = "(\w+)"/.exec(html)![1];
  const flow = /const TOKEN = "(\w+)"/.exec(html)![1];
  const post = (path: string, body: object, h: Record<string, string>) => fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  const scene = { project: "P", sub: "s", n: 1, approved: true, kept: true };
  for (const [path, body] of [["/api/scene", scene], ["/api/cancel", { id: held.id }], ["/api/remotion/dev", {}]] as const) {
    assert.equal((await post(path, body, {})).status, 403, path);
    assert.equal((await post(path, body, { "x-flow-token": flow })).status, 403, path);
    assert.equal((await post(path, body, { "x-ui-token": "wrong" })).status, 403, path);
  }
  assert.equal(readPlan("P", "s").scenes[0].approved, undefined);
  assert.equal(core.queue.list().find((j) => j.id === held.id)!.status, "held");
  assert.deepEqual(starts, []);
  const h = { "x-ui-token": ui };
  const media = (p: string) => fetch(`${base}/media?path=${encodeURIComponent(p)}&token=${flow}`).then((r) => r.status);
  const { projDir } = await import("./projects.js");
  writeFileSync(join(projDir("P"), "references", "a.png"), "x");
  assert.equal(await media(join(projDir("P"), "references", "a.png")), 200);
  assert.equal(await media(join(projDir("P"), "..", "..", "x")), 404);
  assert.equal((await post("/api/scene", { ...scene, prompt: "hacked" }, h)).status, 200);
  const s1 = readPlan("P", "s").scenes[0];
  assert.deepEqual([s1.approved, s1.kept, s1.prompt], [true, true, "x"]);
  assert.equal((await post("/api/scene", { ...scene, n: 9 }, h)).status, 400);
  assert.equal((await post("/api/cancel", { id: "nope" }, h)).status, 400);
  assert.equal((await post("/api/cancel", { id: held.id }, h)).status, 200);
  assert.equal((await post("/api/cancel", { id: held.id }, h)).status, 400); // no longer held
  assert.equal((await (await post("/api/remotion/dev", { cmd: "calc" }, h)).json() as { started: boolean }).started, true);
  assert.equal((await (await post("/api/remotion/dev", {}, h)).json() as { started: boolean }).started, false);
  assert.equal(starts.length, 1);
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});
