import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "fm-server-"));
const port = 20000 + Math.floor(Math.random() * 20000);
process.env.FLOW_MCP_PORT = String(port);
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_OUTPUT = join(home, "out");
process.env.STUDIO_REMOTION = join(home, "remotion");
const STUDIO = { studio: true };
// A top-level navigation, the only request that may receive the one-shot UI token. fetch() forces sec-fetch-mode
// to "cors", so this goes through node:http (with a throwaway agent, since earlier tests' servers are closed).
let lastSet = ""; // Set-Cookie of the latest page() call
const NAV = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" };
const page = (headers: Record<string, string> = NAV) => new Promise<string>((ok, bad) =>
  get(`http://127.0.0.1:${port}/`, { agent: false, headers }, (r) => { lastSet = String(r.headers["set-cookie"] ?? ""); let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => ok(t)); }).on("error", bad));

test("server: /api/approve needs the UI token, never the flow token", async () => {
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js"); // namespace, so lastServer is read live
  const core = new LocalCore();
  const seen: unknown[] = [];
  // Real approve would start Chrome; a spy proves the endpoint reaches core.queue.approve.
  core.queue.approve = (t) => { seen.push(t); return []; };
  assert.equal(await srv.startServer(core, undefined, STUDIO), "owner");
  const base = `http://127.0.0.1:${port}`;
  assert.match(await page({}), /data-owner=""/); // not a navigation: no token, and it is not used up
  assert.match(await page({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }), /data-owner=""/);
  const html = await page();
  const flow = /data-token="(\w+)"/.exec(html)![1];
  const firstSet = lastSet;
  assert.match(firstSet, /HttpOnly/); assert.match(firstSet, /SameSite=Strict/); assert.match(firstSet, /Path=\//);
  assert.doesNotMatch(firstSet, /Expires|Max-Age/i);
  const ui = /fs_ui=([0-9a-f]+)/.exec(firstSet)![1];
  assert.ok(!html.includes(ui)); // the owner token is never in the page
  assert.match(html, /data-owner="1"/);
  const second = await page();
  assert.match(second, /data-owner=""/);
  assert.equal(lastSet, ""); // the cookie is given once
  // A reload resends the cookie: still the owner, no new Set-Cookie.
  const reloaded = await page({ cookie: "fs_ui=" + ui });
  assert.match(reloaded, /data-owner="1"/); assert.equal(lastSet, ""); assert.ok(!reloaded.includes(ui));
  assert.match(await page({ cookie: "fs_ui=wrong" }), /data-owner=""/);
  const post = (h: Record<string, string>) =>
    fetch(base + "/api/approve", { method: "POST", headers: h, body: JSON.stringify({ batch: "A" }) });

  assert.equal((await post({ "x-flow-token": flow })).status, 403);
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ cookie: "fs_ui=", origin: base })).status, 403);
  assert.equal((await post({ "x-flow-token": flow, cookie: "fs_ui=" + ui, origin: "http://evil.example" })).status, 403); // right cookie, wrong Origin
  assert.equal((await post({ "x-flow-token": flow, cookie: "fs_ui=" + ui })).status, 403); // right cookie, no Origin
  assert.equal((await post({ "x-flow-token": flow, cookie: "fs_ui=" + ui, origin: base })).status, 200);
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
  assert.equal(await srv.startServer(new LocalCore(), spawner as never, STUDIO), "owner");
  const html = await page();
  const ui = /fs_ui=([0-9a-f]+)/.exec(lastSet)![1];
  const origin = `http://127.0.0.1:${port}`;
  const socks: { terminate(): void }[] = [];
  const open = (path: string, headers: Record<string, string>) => new Promise<string>((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    socks.push(ws);
    ws.on("open", () => ok("open:" + ws.url));
    ws.on("unexpected-response", (_q, r) => { ok("rejected:" + r.statusCode); ws.terminate(); });
    ws.on("error", () => {});
  });
  const cookie = "fs_ui=" + ui;
  assert.match(await open("/pty", { origin }), /rejected:403/);
  assert.match(await open("/pty", { origin, cookie: "fs_ui=wrong" }), /rejected:403/);
  assert.match(await open("/pty", { origin: "http://evil.example", cookie }), /rejected:403/);
  assert.match(await open("/pty", { cookie }), /rejected:403/);
  assert.match(await open("/pty", { origin, cookie, host: "evil.example" }), /rejected:403/);
  assert.equal(spawned, 0);
  const a = await open("/pty", { origin, cookie });
  const b = await open("/pty", { origin, cookie });
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
  assert.equal(await srv.startServer(new LocalCore(), (() => { throw new Error("no claude here"); }) as never, STUDIO), "owner");
  const html = await page();
  const ui = /fs_ui=([0-9a-f]+)/.exec(lastSet)![1];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty`, { headers: { origin: `http://127.0.0.1:${port}`, cookie: "fs_ui=" + ui } });
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

test("server: scene and cancel-job need the UI token and do only their one thing", async () => {
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js");
  const { createSub, readPlan, writePlan } = await import("./projects.js");
  process.env.STUDIO_PROJECTS = join(home, "projects");
  createSub("P", "ss", "9:16");
  const plan = readPlan("P", "ss");
  plan.scenes = [{ n: 1, prompt: "x" }];
  writePlan(plan);
  const core = new LocalCore();
  const held = core.queue.add({ prompt: "p", type: "video", max_credits: 5 } as never);
  assert.equal(await srv.startServer(core, undefined, STUDIO), "owner");
  const base = `http://127.0.0.1:${port}`;
  const html = await page();
  const ui = /fs_ui=([0-9a-f]+)/.exec(lastSet)![1];
  const flow = /data-token="(\w+)"/.exec(html)![1];
  const post = (path: string, body: object, h: Record<string, string>) => fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  const scene = { project: "P", sub: "ss", n: 1, approved: true, kept: true };
  for (const [path, body] of [["/api/scene", scene], ["/api/cancel-job", { id: held.id }]] as const) {
    assert.equal((await post(path, body, {})).status, 403, path);
    assert.equal((await post(path, body, { "x-flow-token": flow })).status, 403, path);
    assert.equal((await post(path, body, { cookie: "fs_ui=wrong", origin: base })).status, 403, path);
    assert.equal((await post(path, body, { cookie: "fs_ui=" + ui, origin: "http://evil.example" })).status, 403, path);
  }
  assert.equal(readPlan("P", "ss").scenes[0].approved, undefined);
  assert.equal(core.queue.list().find((j) => j.id === held.id)!.status, "held");
  const h = { cookie: "fs_ui=" + ui, origin: base };
  const media = (p: string) => fetch(`${base}/media?path=${encodeURIComponent(p)}&token=${flow}`).then((r) => r.status);
  const { projDir } = await import("./projects.js");
  writeFileSync(join(projDir("P"), "references", "a.png"), "x");
  assert.equal(await media(join(projDir("P"), "references", "a.png")), 200);
  writeFileSync(join(home, "outside.txt"), "x");
  assert.equal(await media(join(home, "outside.txt")), 404);
  writeFileSync(join(projDir("P"), "references", "x.html"), "<script>1</script>");
  assert.equal(await media(join(projDir("P"), "references", "x.html")), 404); // inside the projects folder, but not image/video/audio
  const png = await fetch(`${base}/media?path=${encodeURIComponent(join(projDir("P"), "references", "a.png"))}&token=${flow}`);
  assert.equal(png.headers.get("x-content-type-options"), "nosniff");
  const root = await fetch(base + "/");
  assert.doesNotMatch(root.headers.get("content-security-policy") ?? "", /frame-src/);
  assert.match(root.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal((await post("/api/remotion/dev", {}, { ...h, "x-flow-token": flow })).status, 404); // the owner route is gone
  // Remotion public (clips) and out (renders) are served too; never HTML there either.
  for (const d of ["public", "out"]) {
    const dir = join(home, "remotion", d, "P", "ss");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "v1.mp4"), "vid");
    writeFileSync(join(dir, "x.html"), "<script>1</script>");
    assert.equal(await media(join(dir, "v1.mp4")), 200, d);
    assert.equal(await media(join(dir, "x.html")), 404, d);
  }
  writeFileSync(join(home, "remotion", "Root.mp4"), "x");
  assert.equal(await media(join(home, "remotion", "Root.mp4")), 404); // the Remotion root itself is not served
  assert.equal((await post("/api/scene", { ...scene, prompt: "hacked" }, h)).status, 200);
  const s1 = readPlan("P", "ss").scenes[0];
  assert.deepEqual([s1.approved, s1.kept, s1.prompt], [true, true, "x"]);
  assert.equal((await post("/api/scene", { ...scene, n: 9 }, h)).status, 400);
  assert.equal((await post("/api/cancel-job", { id: "nope" }, h)).status, 400);
  assert.equal((await post("/api/cancel-job", { id: held.id }, h)).status, 200);
  assert.equal((await post("/api/cancel-job", { id: held.id }, h)).status, 400); // no longer held
  core.queue.pause("test"); // keeps an approved job queued instead of running it
  const queued = core.queue.add({ prompt: "p", type: "video", max_credits: 5 } as never);
  core.queue.approve({ job_id: queued.id });
  assert.equal(queued.status, "queued");
  assert.equal((await post("/api/cancel-job", { id: queued.id }, h)).status, 200);
  assert.equal(queued.status, "cancelled");
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});

test("server: Claude's (non-studio) server never hands out the UI token", async () => {
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js");
  assert.equal(await srv.startServer(new LocalCore()), "owner");
  assert.match(await page(), /data-owner=""/);
  assert.match(await page(), /data-token="\w+"/);
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});

test("media: bad ranges answer 416 and never crash the server", async () => {
  const { LocalCore } = await import("./core.js");
  const srv = await import("./server.js");
  assert.equal(await srv.startServer(new LocalCore()), "owner");
  const html = await page();
  const flow = /data-token="(\w+)"/.exec(html)![1];
  const dir = join(home, "out", "M");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "empty.mp4"), "");
  writeFileSync(join(dir, "small.mp4"), "0123456789");
  const media = (f: string, range: string) => new Promise<number>((ok, bad) =>
    get(`http://127.0.0.1:${port}/media?token=${flow}&path=${encodeURIComponent(join(dir, f))}`, { agent: false, headers: { range } }, (r) => { r.resume(); ok(r.statusCode!); }).on("error", bad));
  assert.equal(await media("empty.mp4", "bytes=0-"), 416);
  assert.equal(await media("small.mp4", "bytes=500-100"), 416);
  assert.equal(await media("small.mp4", "bytes=7-3"), 416);
  assert.equal(await media("small.mp4", "bytes=10-"), 416);
  assert.equal(await media("small.mp4", "bytes=2-5"), 206);
  await new Promise((r) => setTimeout(r, 100));
  const health = await new Promise<number>((ok, bad) => get(`http://127.0.0.1:${port}/api/health`, { agent: false }, (r) => { r.resume(); ok(r.statusCode!); }).on("error", bad));
  assert.equal(health, 200);
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});

test("RemoteCore.cancel (flow_cancel from a client process) reaches the owner with the flow token", async () => {
  const { LocalCore } = await import("./core.js");
  const { RemoteCore } = await import("./remote.js");
  const srv = await import("./server.js");
  const core = new LocalCore();
  core.queue.pause("test");
  assert.equal(await srv.startServer(core), "owner");
  const held = core.queue.add({ prompt: "p", type: "video", max_credits: 5 } as never);
  const queued = core.queue.add({ prompt: "p", type: "video", max_credits: 5 } as never);
  core.queue.approve({ job_id: queued.id });
  const remote = new RemoteCore();
  assert.equal(((await remote.cancel({ job_id: held.id })) as { status: string }).status, "cancelled");
  assert.equal(((await remote.cancel({ job_id: queued.id })) as { status: string }).status, "cancelled");
  srv.lastServer!.closeAllConnections();
  await new Promise((r) => srv.lastServer!.close(r));
});
