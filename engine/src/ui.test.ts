import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");

test("a reference edit stays bound to its original ad while the owner switches projects", async () => {
  const start=source.indexOf("async function savePlan(");
  let current="A",finish!:(plan:object)=>void;
  const pending=new Promise<object>(resolve=>{finish=resolve;});
  const writes:any[]=[];
  const save=runInNewContext(source.slice(start,source.indexOf("const slug",start))+"\nsavePlan",{
    cur:()=>({project:current,sub:"ad"}),apiOk:async(method:string,args:unknown)=>{if(method==="studio_plan_read") return pending;writes.push(args);return{ok:true};},
  });
  const saving=save((plan:any)=>{plan.references=[];});
  current="B";finish({project:"A",sub:"ad",rev:1,scenes:[]});await saving;
  assert.equal(writes[0].project,"A");
});

test("Start new ad proposes a fresh cut without resetting the finished ad", () => {
  const start = source.indexOf("function startNewAd(");
  assert.ok(start >= 0, "the finished-ad workflow needs a new-ad action");
  const elements: Record<string, any> = Object.fromEntries(["project-setup", "new-project-toggle", "new-project-name", "new-sub-name", "new-aspect", "create-project", "project-setup-copy"].map(id => [id, {hidden:true,value:"",setAttribute(){},focus(){},select(){}}]));
  const finished = {aspect:"16:9",scenes:[{n:1,clip:"kept.mp4"}]};
  const open = runInNewContext(source.slice(start, source.indexOf("async function createProject(",start)) + "\nstartNewAd", {
    $:(id:string)=>elements[id],cur:()=>({project:"Bottle",sub:"ad-01"}),
    projects:[{project:"Bottle",subs:["ad-01","ad-02"]}],data:{plan:finished},
  });
  open();
  assert.equal(elements["new-project-name"].value,"Bottle");
  assert.equal(elements["new-sub-name"].value,"ad-03");
  assert.equal(elements["new-aspect"].value,"16:9");
  assert.equal(elements["project-setup"].hidden,false);
  assert.equal(finished.scenes[0].clip,"kept.mp4");
});

test("guided navigation refuses future stages and keeps the conversation untouched", () => {
  const start = source.indexOf("function navigateTo(");
  assert.ok(start >= 0, "guided navigation must exist");
  let active = "plan", displayed = "plan", announced = "", refreshed = 0;
  const navigate = runInNewContext(source.slice(start, source.indexOf("function restoreStage(", start)) + "\nnavigateTo", {
    get view() { return active; }, set view(v: string) { active = v; },
    data: { workflow: { stages: { edit: { access: "locked", reason: "Keep a clip first" }, ideas: { access: "open" } } } },
    toast: (s: string) => announced = s, dataFresh: true, have: () => true, cur: () => ({ project: "P", sub: "ad" }),
    localStorage: { setItem() {} }, stageMemory: new Map(), selection: null, publishContextSoon() {}, renderNavigation() { displayed = active; },
    $: () => ({ replaceChildren() {} }), h: () => ({}), refresh() { assert.equal(displayed,active,"visible screen updates before async refresh"); refreshed++; },
  });
  assert.equal(navigate("edit"), false);
  assert.equal(active, "plan");
  assert.equal(announced, "Keep a clip first");
  assert.equal(navigate("ideas"), true);
  assert.equal(active, "ideas");
  assert.equal(refreshed, 1);
});

test("stage restoration has an in-memory fallback when browser storage is blocked", () => {
  const start = source.indexOf("function restoreStage(");
  const ui = runInNewContext(source.slice(start, source.indexOf("function getUiContext(", start)) + "\n({restoreStage,read:()=>view})", {
    restoredScope:"Other/ad", selection:null, view:"edit", stageMemory:new Map([["P/ad","ideas"]]), messageDrafts:new Map(),
    localStorage:{getItem(){throw new Error("blocked");}}, $:()=>({value:"",checked:false}),updateComposer(){},publishContextSoon(){},
  });
  ui.restoreStage("P/ad",{stages:{ideas:{access:"open"},edit:{access:"open"}},recommendedStage:"edit"});
  assert.equal(ui.read(),"ideas");
});

test("saving a recovered conflicting draft writes the draft rather than silently deleting it", async () => {
  const storage = new Map([["flow-studio-draft:notes:A/ad", JSON.stringify({ text: "owner draft", rev: "old" })]]);
  const buttons: { label: string; click: () => Promise<void> }[] = [], writes: { text: string; rev: string }[] = [];
  const makeNotes = runInNewContext(source.slice(source.indexOf("function makeNotes("), source.indexOf("const notes = makeNotes")) + "\nmakeNotes", {
    notesKey: () => "A/ad", cur: () => ({ project: "A", sub: "ad" }),
    document: { activeElement: null, getElementById: () => null },
    localStorage: { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    apiOk: async (method: string, body: { text: string; rev: string }) => {
      if (method === "read") return { text: "new remote notes", rev: "new" };
      writes.push(body); return { rev: "saved" };
    },
    h: () => ({}), btn: (label: string, click: () => Promise<void>) => { const b = { label, click }; buttons.push(b); return b; },
    clearTimeout, setTimeout, refresh() {}, toast() {},
  });
  const notes = makeNotes("notes", "Notes", "read", "write");
  await notes.load(); notes.box({ project: "A", sub: "ad" }, "4", "Notes");
  assert.equal(notes.conflict["A/ad"], "owner draft");
  await buttons.find((b) => b.label.toLowerCase().includes("draft"))!.click();
  assert.equal(writes[0].text, "owner draft");
  assert.equal(writes[0].rev, "new");
  assert.equal(storage.size, 0);
});

function terminalHarness() {
  const elements: Record<string, any> = Object.fromEntries(["term", "agent", "agent-status", "switch-agent", "restart", "expand-terminal", "mode-terminal", "mode-message", "message-input", "message-ready", "send-message", "message-status"].map((id) => [id, { value: "claude", checked: false, setAttribute() {} }]));
  const sent: any[] = [];
  const timers: (() => void)[] = [];
  let socket: any;
  class FakeSocket {
    readyState = 1;
    onopen?: () => void;
    onmessage?: (m: { data: string }) => void;
    constructor() { socket = this; }
    send(raw: string) { sent.push(JSON.parse(raw)); }
  }
  const terminal = runInNewContext(source.slice(source.indexOf("// ---- terminal ----"), source.indexOf("// ---- resizable split")) + "\n({typeToAgent, termUp})", {
    Terminal: class { cols = 80; rows = 20; loadAddon() {} open() {} reset() {} write() {} onData() {} onResize() {} focus() {} },
    FitAddon: { FitAddon: class { fit() {} } }, WebSocket: FakeSocket, OWNER: true,
    $: (id: string) => elements[id], location: { host: "fixture" },
    setTimeout: (fn: () => void) => timers.push(fn), clearTimeout() {}, refresh() {}, toast() {}, addEventListener() {},
    getUiContext: () => ({ project: "P", sub: "ad", stage: "edit" }), dataFresh: true,
  });
  socket.onopen();
  const state = (session: number, status = "running") => socket.onmessage({ data: JSON.stringify({ t: "agent", agent: "codex", session, status }) });
  return { terminal, state, sent, timers, elements, mode: () => socket.onmessage({ data: JSON.stringify({ t: "input-mode", mode: "message", session: 1 }) }) };
}

test("an open socket to an exited CLI cannot receive Edit instructions", () => {
  const ui = terminalHarness();
  ui.state(1);
  assert.equal(ui.terminal.termUp(), true);
  ui.state(1, "exited");
  assert.equal(ui.terminal.termUp(), false);
});

test("a delayed submit never sends Enter into a replacement chat", async () => {
  const ui = terminalHarness();
  ui.state(1);
  ui.mode(); ui.elements["message-ready"].checked = true;
  const delivery = ui.terminal.typeToAgent("Edit this video");
  const failed = assert.rejects(delivery, /session changed/i);
  ui.state(2);
  ui.timers.forEach((fn) => fn());
  await failed;
  assert.ok(!ui.sent.some((m) => m.t === "i" && m.d === "\r"));
});

test("notes flush waits for an autosave already in flight", async () => {
  let finish!: (value: object) => void;
  const request = new Promise<object>((r) => { finish = r; });
  const makeNotes = runInNewContext(source.slice(source.indexOf("function makeNotes("), source.indexOf("const notes = makeNotes")) + "\nmakeNotes", {
    notesKey: () => "P/ad", cur: () => ({ project: "P", sub: "ad" }),
    clearTimeout, apiOk: () => request, refresh() {}, toast() {},
  });
  const notes = makeNotes("notes", "Notes", "read", "write");
  notes.text["P/ad"] = "latest";
  const saving = notes.save("P/ad", { project: "P", sub: "ad" });
  let flushed = false;
  const flushing = notes.flush().then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false, "must not send edit instructions while the save is pending");
  finish({ rev: "saved" });
  await Promise.all([saving, flushing]);
  assert.equal(flushed, true);
});

function editHarness(revise = false) {
  let project = "A";
  let nodes: any[] = [];
  const sent: string[] = [];
  const context = {
    data: { plan: { scenes: [{ kept: true, clip: "clip.mp4" }], style: "A" }, renders: revise ? [{ version: 1, path: "v1.mp4" }] : [] },
    have: () => true, cur: () => ({ project, sub: "ad" }),
    editNotes: { box: () => [null, null], flush: async () => {}, conflict: {} },
    agentSession: 1, owner: async () => ({ task: { id: "fixture", phase: "sent" } }), termUp: () => true, typeToAgent: (s: string) => sent.push(s),
    inputMode: "message", $: () => ({ checked: true }), getUiContext: () => ({ project, sub: "ad", stage: "edit" }),
    selection: null as {kind: string; version: number} | null, publishContextSoon() {}, startNewAd() {},
    h: (...args: any[]) => ({ args }),
    btn: (label: string, click: () => unknown) => ({ label, click, dataset: {} }),
    picker: (label: string, pick: (f: string) => unknown) => ({ label, pick }),
    upload: async (f: string) => f, media: (f: string) => f, setTimeout: () => 0,
  };
  const render = runInNewContext(source.slice(source.indexOf("const editFiles ="), source.lastIndexOf("refresh(true);")) + "\nrenderEdit", context);
  const show = (name: string) => { project = name; render({ replaceChildren: (...args: any[]) => { nodes = args; } }); };
  const find = (label: string): any => {
    const visit = (x: any): any => x?.label === label ? x : (Array.isArray(x) ? x : x?.args ?? []).map(visit).find(Boolean);
    return visit(nodes);
  };
  return { show, find, sent, setRenders: (renders: {version:number;path:string}[]) => { context.data.renders = renders; }, target: () => context.selection };
}

test("the message target follows the render actually displayed when a new version arrives", () => {
  const ui = editHarness(true); ui.show("A");
  assert.equal(ui.target()?.version, 1);
  ui.setRenders([{version:1,path:"v1.mp4"},{version:2,path:"v2.mp4"}]);
  ui.show("A");
  assert.equal(ui.target()?.version, 2);
});

test("edit audio belongs to the selected project and survives switching back", async () => {
  const ui = editHarness();
  ui.show("A");
  await ui.find("Music").pick("a.wav");
  ui.show("B");
  await ui.find("Edit video").click();
  assert.ok(!ui.sent[0].includes("a.wav"));
  ui.show("A");
  await ui.find("Edit video").click();
  assert.ok(ui.sent[1].includes('Music file: "a.wav"'));
});

test("revision instructions include newly selected music and voiceover", async () => {
  const ui = editHarness(true);
  ui.show("A");
  await ui.find("Music").pick("revision.wav");
  await ui.find("Voiceover").pick("voice.wav");
  await ui.find("Revise").click();
  assert.match(ui.sent[0], /Music file: "revision.wav"/);
  assert.match(ui.sent[0], /Voiceover file: "voice.wav"/);
});
