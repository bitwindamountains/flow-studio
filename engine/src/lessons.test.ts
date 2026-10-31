import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
let lastSet = "";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "fm-lessons-"));
const port = 20000 + Math.floor(Math.random() * 20000);
process.env.FLOW_MCP_PORT = String(port);
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_OUTPUT = join(home, "out");
const fresh = () => { process.env.STUDIO_LESSONS = join(mkdtempSync(join(tmpdir(), "fm-l-")), "lessons.md"); };

test("proposed lesson is not in readLessons until saved", async () => {
  fresh();
  const L = await import("./lessons.js");
  const p = L.proposeLesson("  keep   shots\nshort ");
  assert.equal(p.text, "keep shots short");
  assert.deepEqual(L.readLessons(), []);
  assert.equal(L.pendingLessons().length, 1);
  assert.throws(() => L.proposeLesson("   "));
  L.resolveLesson(p.id, "save");
  assert.deepEqual(L.readLessons(), [{ scope: "global", text: "keep shots short" }]);
  assert.equal(L.pendingLessons().length, 0);
  assert.throws(() => L.resolveLesson("nope", "save"));
});

test("discard never writes", async () => {
  fresh();
  const L = await import("./lessons.js");
  const p = L.proposeLesson("x");
  L.resolveLesson(p.id, "discard");
  assert.equal(existsSync(process.env.STUDIO_LESSONS!), false);
  assert.equal(L.pendingLessons().length, 0);
});

test("save with editedText writes the edited text; other lines preserved", async () => {
  fresh();
  const L = await import("./lessons.js");
  L.addLesson("first", "global");
  const p = L.proposeLesson("orig");
  L.resolveLesson(p.id, "save", "edited\ntext");
  assert.deepEqual(L.readLessons().map((l) => l.text), ["first", "edited text"]);
  assert.match(readFileSync(process.env.STUDIO_LESSONS!, "utf8"), /^- \[global\] first\n- \[global\] edited text\n$/);
});

test("model scope round-trips", async () => {
  fresh();
  const L = await import("./lessons.js");
  L.addLesson("no text in frame", "model:veo-3.1");
  assert.deepEqual(L.readLessons(), [{ scope: "model:veo-3.1", text: "no text in frame" }]);
});

test("resolve endpoint rejects x-flow-token", async () => {
  fresh();
  const { LocalCore } = await import("./core.js");
  const L = await import("./lessons.js");
  const srv = await import("./server.js");
  assert.equal(await srv.startServer(new LocalCore(), undefined, undefined, { studio: true }), "owner");
  const base = `http://127.0.0.1:${port}`;
  // fetch() forces sec-fetch-mode "cors"; the UI token goes only to a real navigation, so use node:http.
  const html = await new Promise<string>((ok, bad) => get(base + "/", { agent: false, headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" } }, (r) => { lastSet = String(r.headers["set-cookie"] ?? ""); let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => ok(t)); }).on("error", bad));
  const flow = /data-token="(\w+)"/.exec(html)![1];
  const ui = /fs_ui=([0-9a-f]+)/.exec(lastSet)![1];
  const p = L.proposeLesson("a rule");
  const post = (path: string, h: Record<string, string>, b: object) =>
    fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(b) });
  const r = { id: p.id, action: "save" };
  assert.equal((await post("/api/lessons/resolve", { "x-flow-token": flow }, r)).status, 403);
  assert.equal((await post("/api/lessons/resolve", { cookie: "fs_ui=", origin: base }, r)).status, 403);
  assert.equal((await post("/api/lessons/add", { "x-flow-token": flow }, { text: "t" })).status, 403);
  assert.deepEqual(L.readLessons(), []);
  assert.equal((await post("/api/lessons/resolve", { cookie: "fs_ui=" + ui, origin: base }, r)).status, 200);
  assert.equal((await post("/api/lessons/add", { cookie: "fs_ui=" + ui, origin: base }, { text: "mine", scope: "model:omni" })).status, 200);
  assert.equal(L.readLessons().length, 2);
  const g = await (await fetch(base + "/api/lessons", { headers: { "x-flow-token": flow } })).json() as { lessons: unknown[]; pending: unknown[] };
  assert.equal(g.lessons.length, 2);
  assert.equal(g.pending.length, 0);
  srv.lastServer!.closeAllConnections();
  srv.lastServer!.close();
});
