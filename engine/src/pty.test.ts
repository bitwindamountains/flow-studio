import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { PtyHub, startAgent } from "./pty.js";

test("scoped submissions serialize across sockets, preserve raw mode and cannot cross sessions", async () => {
  const writes: string[] = [];
  const hub = new PtyHub((() => ({ onData() {}, onExit() {}, resize() {}, write(s: string) { writes.push(s); }, kill() {} })) as never,
    () => {}, raw => raw as never);
  const socket = () => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, messages: [] as any[], send(s: string) { this.messages.push(JSON.parse(s)); }, terminate() {} });
    hub.attach(ws as never); return ws;
  };
  const a = socket(), b = socket(), context = { project: "P", sub: "ad", stage: "plan" };
  const session = a.messages.find(m => m.t === "agent" && m.status === "running").session;
  const send = (ws: typeof a, m: object) => ws.emit("message", JSON.stringify(m));
  send(a, { t: "submit-message", requestId: "first", session, context, text: "shorten it", ready: true });
  assert.equal(writes.length, 0, "terminal mode cannot accept composer sends");
  send(a, { t: "input-mode", mode: "message", session });
  send(a, { t: "submit-message", requestId: "second", session, context, text: "shorten it", ready: true });
  assert.match(writes[0], /"stage":"plan"/);
  send(b, { t: "i", d: "competing input", session });
  assert.equal(writes.length, 1);
  send(a, { t: "submit-message", requestId: "second", session, context, text: "duplicate", ready: true });
  assert.equal(writes.length, 1);
  send(b, { t: "restart" });
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!writes.includes("\r"), "delayed Enter cannot reach the new session");
  assert.ok(a.messages.some(m => m.t === "message-delivery" && m.state === "uncertain"));
  hub.kill();
});

test("message mode forwards a bounded bracketed paste once and preserves terminal mode bytes", async () => {
  const writes: string[] = [];
  const hub = new PtyHub((() => ({ onData() {}, onExit() {}, resize() {}, write(s: string) { writes.push(s); }, kill() {} })) as never,
    () => {}, raw => { const c = raw as { project?: string }; if (c.project !== "P") throw new Error("Unknown project"); return raw as never; });
  const ws = Object.assign(new EventEmitter(), { readyState: 1, messages: [] as any[], send(s: string) { this.messages.push(JSON.parse(s)); }, terminate() {} });
  hub.attach(ws as never);
  const session = ws.messages.find(m => m.status === "running").session;
  const send = (m: object) => ws.emit("message", JSON.stringify(m));
  send({t:"input-mode",mode:"message",session});
  const request = { t:"submit-message", requestId:"message", session, ready:true, context:{project:"P",sub:"ad",stage:"plan"}, text:"line one\nline two" };
  send({...request,requestId:"not-ready",ready:false});
  send({...request,requestId:"bad-project",context:{...request.context,project:"Other"}});
  send({...request,requestId:"control",text:"\x1b[201~\r"});
  assert.equal(writes.length,0);
  send(request);
  await new Promise(r=>setTimeout(r,300));
  assert.equal(writes.length,2);
  assert.ok(writes[0].startsWith("\x1b[200~"));
  assert.ok(writes[0].endsWith("line one\nline two\x1b[201~"));
  assert.equal(writes[1],"\r");
  assert.ok(ws.messages.some(m=>m.requestId==="message"&&m.state==="forwarded"));
  send(request); assert.equal(writes.length,2,"duplicate does not forward twice");
  send({t:"input-mode",mode:"terminal",session});
  send({t:"i",session,d:"\x1b[A\r"});
  assert.equal(writes[2],"\x1b[A\r");
  hub.kill();
});

test("owner terminal switches between fixed agents, synchronizes windows, and drops old output", () => {
  const agents: string[] = [];
  const processes: { events: EventEmitter; writes: string[]; killed: boolean }[] = [];
  const hub = new PtyHub(((agent: string) => {
    agents.push(agent);
    const p = { events: new EventEmitter(), writes: [] as string[], killed: false };
    processes.push(p);
    return { onData: (f: () => void) => p.events.on("data", f), onExit: (f: () => void) => p.events.on("exit", f),
      write: (s: string) => p.writes.push(s), resize() {}, kill: () => { p.killed = true; p.events.emit("exit"); } };
  }) as never);
  const socket = () => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, messages: [] as string[], send(s: string) { this.messages.push(s); }, terminate() {} });
    hub.attach(ws as never);
    return ws;
  };
  const a = socket();
  assert.deepEqual(agents, ["claude"]);
  a.emit("message", JSON.stringify({ t: "agent", agent: "arbitrary-command" }));
  assert.equal(agents.length, 1);
  a.emit("message", JSON.stringify({ t: "agent", agent: "codex" }));
  assert.deepEqual(agents, ["claude", "codex"]);
  assert.ok(processes[0].killed);
  const b = socket();
  assert.equal(agents.length, 2, "reconnect must share the current process");
  assert.ok(b.messages.some((s) => { const m = JSON.parse(s); return m.t === "agent" && m.agent === "codex" && m.status === "running"; }));
  processes[0].events.emit("data", "old session output");
  assert.ok(!a.messages.some((s) => JSON.parse(s).data === "old session output"));
  a.emit("message", JSON.stringify({ t: "i", d: "hello codex" }));
  assert.deepEqual(processes[1].writes, ["hello codex"]);
  b.emit("message", JSON.stringify({ t: "agent", agent: "claude" }));
  assert.deepEqual(agents, ["claude", "codex", "claude"]);
  assert.ok(a.messages.some((s) => { const m = JSON.parse(s); return m.t === "agent" && m.agent === "claude" && m.status === "running"; }));
  hub.kill();
});

test("Codex launch contract keeps sandbox, MCP project discovery, and owner approval boundaries", async () => {
  const pty = await import("./pty.js") as unknown as { CODEX_ARGS: string[]; STUDIO: string };
  assert.ok(pty.CODEX_ARGS, "Codex launch arguments must be explicit");
  assert.ok(pty.CODEX_ARGS.includes("workspace-write"));
  assert.ok(pty.CODEX_ARGS.includes("on-request"));
  assert.ok(pty.CODEX_ARGS.includes("--no-daemon"), "embedded Codex must not leave work running in a shared daemon");
  assert.ok(pty.CODEX_ARGS.includes(`${pty.STUDIO}/remotion`));
  assert.ok(!pty.CODEX_ARGS.some((s) => s.includes("dangerously")));
});

test("the embedded CLI gets a real color terminal even when the server inherits TERM=dumb", () => {
  const previous = process.env.TERM;
  process.env.TERM = "dumb";
  try {
    startAgent("codex", ((_file: string, _args: string[], options: { env: Record<string, string> }) => {
      assert.equal(options.env.TERM, "xterm-256color");
      assert.equal(options.env.COLORTERM, "truecolor");
      return {};
    }) as never);
  } finally {
    if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous;
  }
});

test("an exited agent stays exited on reconnect and exposes its exit code", () => {
  let exit!: (e: { exitCode: number }) => void;
  let spawned = 0;
  const hub = new PtyHub((() => {
    spawned++;
    return { onData() {}, onExit: (f: typeof exit) => { exit = f; }, write() {}, resize() {}, kill() {} };
  }) as never);
  const socket = () => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, messages: [] as string[], send(s: string) { this.messages.push(s); }, terminate() {} });
    hub.attach(ws as never);
    return ws;
  };
  const a = socket();
  exit({ exitCode: 1 });
  const b = socket();
  assert.equal(spawned, 1, "reconnect must not silently start a new chat");
  const state = b.messages.map((s) => { try { return JSON.parse(s); } catch { return null; } }).find((m) => m?.t === "agent");
  assert.equal(state?.status, "exited");
  assert.equal(state?.exitCode, 1);
  a.emit("message", JSON.stringify({ t: "restart" }));
  assert.equal(spawned, 2);
  hub.kill();
});

test("switching applies the existing terminal dimensions before accepting input", () => {
  const sizes: number[][][] = [];
  const hub = new PtyHub((() => {
    const resizes: number[][] = [];
    sizes.push(resizes);
    return { onData() {}, onExit() {}, write() {}, resize: (cols: number, rows: number) => resizes.push([cols, rows]), kill() {} };
  }) as never);
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send() {}, terminate() {} });
  hub.attach(ws as never);
  ws.emit("message", JSON.stringify({ t: "r", cols: 73, rows: 12 }));
  ws.emit("message", JSON.stringify({ t: "agent", agent: "codex" }));
  assert.deepEqual(sizes[1], [[73, 12]]);
  hub.kill();
});

test("agent state arrives before startup errors so the terminal reset does not erase the error", () => {
  const hub = new PtyHub(() => { throw new Error("CLI missing"); });
  const ws = Object.assign(new EventEmitter(), { readyState: 1, messages: [] as string[], send(s: string) { this.messages.push(s); }, terminate() {} });
  hub.attach(ws as never);
  assert.equal(JSON.parse(ws.messages[0]).status, "starting");
  assert.equal(JSON.parse(ws.messages[1]).status, "failed");
  assert.match(JSON.parse(ws.messages[2]).data, /could not start claude: CLI missing/i);
  assert.equal(ws.messages.filter((s) => JSON.parse(s).t === "output").length, 1, "startup errors should appear once, then replay on reconnect");
});

test("a failing task-status callback cannot leave the old agent alive during a switch", () => {
  let killed = 0;
  const hub = new PtyHub((() => ({ onData() {}, onExit() {}, resize() {}, write() {}, kill() { killed++; } })) as never, () => { throw new Error("status file unavailable"); });
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send() {}, terminate() {} });
  hub.attach(ws as never);
  ws.emit("message", JSON.stringify({ t: "agent", agent: "codex" }));
  assert.equal(killed, 1);
  hub.kill();
});
