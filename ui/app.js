// Plain JS, no build step. The server writes the tokens into data attributes on <body> (no inline script, for the CSP).
const TOKEN = document.body.dataset.token;
document.body.removeAttribute("data-token"); // keep the API token out of the DOM once read
// The owner session is an HttpOnly cookie the server sets on the first load; the page only learns whether it is the owner.
const OWNER = document.body.dataset.owner === "1";
// Reload is harmless now (the cookie is resent); only warn when typed notes are not saved yet.
addEventListener("beforeunload", (e) => { if (notes.dirty() || editNotes.dirty() || $("message-input")?.value) { e.preventDefault(); e.returnValue = ""; } });
const $ = (id) => document.getElementById(id);
let dataFresh = false, connectionMessage = "";
// Write controls inside the drawers; offline or expired windows disable them all.
const WRITES = "#details [data-write], #details input, #details textarea, #details select, #alerts-list [data-write], #alerts-list input";
function connectionState(ok, message = "") {
  dataFresh = ok; connectionMessage = message;
  $("connection").hidden = ok;
  // The banner keeps its two recovery buttons; the full sentence is in the alert list.
  $("connection-message").textContent = /^Loading/.test(message) ? "Loading" : /Reload/.test(message) ? "Reconnect needed" : "Offline";
  if (!ok) for (const el of document.querySelectorAll(WRITES)) el.disabled = true;
  if ($("message-input")) updateComposer();
  gateControls();
  renderAlerts();
}
async function requestJson(path, options = {}) {
  try {
    const r = await fetch(path, { ...options, signal: AbortSignal.timeout(20000) });
    const value = await r.json();
    if (r.ok === false || value?.error) {
      const error = new Error(value?.error || `Request failed (${r.status}).`);
      error.status = r.status;
      if (r.status === 401) connectionState(false, "Studio restarted or your connection expired. Reload this window to reconnect.");
      throw error;
    }
    return value;
  } catch (error) {
    if (!error.status) connectionState(false, "Studio is unreachable. Your drafts are kept in this browser. Retry when it is running.");
    throw error;
  }
}
const api = (method, body = {}) =>
  requestJson("/api/" + method, { method: "POST", headers: { "x-flow-token": TOKEN }, body: JSON.stringify(body) });
$("retry-connection").onclick = () => { loadProjects(); };
$("reload-studio").onclick = () => location.reload();

// ---- terminal ----
const term = new Terminal({ fontSize: 14, cursorBlink: true, theme: { background: "#0f1326", foreground: "#e8ebf8", cursor: "#c3ceff", selectionBackground: "#5266a866" } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("term"));
let ws;
let activeAgent = "claude";
let agentStatus = "connecting", agentSession = null;
let inputMode = "terminal", pendingMessage = null;
const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
function terminalControls(exitCode) {
  const connected = OWNER && ws && ws.readyState === 1;
  const name = activeAgent === "codex" ? "Codex CLI" : "Claude Code";
  $("agent-status").textContent = `${name} · ${agentStatus}${exitCode === undefined ? "" : " (" + exitCode + ")"}`;
  $("agent").disabled = !OWNER;
  $("switch-agent").disabled = !connected || agentStatus === "starting" || $("agent").value === activeAgent;
  $("restart").disabled = !OWNER || agentStatus === "starting";
  updateComposer();
}
let retry = 0;
function connect() {
  if (!OWNER || (ws && ws.readyState <= 1)) return;
  ws = new WebSocket(`ws://${location.host}/pty`);
  ws.onopen = () => { retry = 0; agentSession = null; agentStatus = "connecting"; terminalControls(); refresh(true); fit.fit(); send({ t: "r", cols: term.cols, rows: term.rows }); };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m && m.t === "agent" && (m.agent === "claude" || m.agent === "codex")) {
        const changed = agentSession !== m.session;
        const wasRunning = agentStatus === "running";
        activeAgent = m.agent; agentStatus = m.status; agentSession = m.session;
        if (changed) {
          inputMode = "terminal";
          if ($("message-ready")) $("message-ready").checked = false;
          failPendingMessage("Agent session changed. Review the terminal before retrying.", "uncertain");
          $("agent").value = m.agent;
          // xterm writes asynchronously: queue the reset after old output, before the new session's output.
          term.write("", () => term.reset());
        }
        terminalControls(m.exitCode); fit.fit();
        send({ t: "r", cols: term.cols, rows: term.rows });
        if (agentStatus === "running" && (changed || !wasRunning)) term.focus();
        refresh(true);
        return;
      }
      if (m?.t === "input-mode" && m.session === agentSession) {
        inputMode = m.mode; $("message-ready").checked = false;
        $("message-status").textContent = inputMode === "message" ? "Context will be attached. Confirm the normal agent prompt before sending." : "Terminal input has no automatic screen context.";
        updateComposer(); return;
      }
      if (m?.t === "message-delivery" && pendingMessage?.id === m.requestId) {
        const pending = pendingMessage; pendingMessage = null; clearTimeout(pending.timer);
        if (m.state === "forwarded") pending.resolve();
        else { const error = new Error(m.reason || "Message delivery could not be confirmed."); error.delivery = m.state; pending.reject(error); }
        updateComposer(); return;
      }
      if (m && m.t === "output" && typeof m.data === "string") term.write(m.data);
    } catch { /* ignore malformed protocol frames; terminal output is always wrapped as output */ }
  };
  ws.onclose = () => {
    inputMode = "terminal";
    if ($("message-ready")) $("message-ready").checked = false;
    failPendingMessage("Connection lost. Review the terminal before retrying; delivery is uncertain.", "uncertain");
    agentStatus = "disconnected"; terminalControls();
    refresh(true); // the Edit button is disabled while the terminal is down
    if (retry >= 6) return void term.write("\r\n[disconnected - press Restart to retry]\r\n");
    term.write("\r\n[disconnected - reconnecting]\r\n");
    setTimeout(connect, [1000, 2000, 5000, 10000][Math.min(retry++, 3)]);
  };
}
const termUp = () => !!ws && ws.readyState === 1 && agentStatus === "running";
// Same as the owner typing it: text, then Enter (a beat later so the TUI does not treat it as one pasted block).
function typeToAgent(text, context = getUiContext()) {
  if (!termUp()) throw new Error("The agent is not running. Check the terminal and press Restart if it exited.");
  if (inputMode !== "message" || !$("message-ready")?.checked) throw new Error("Choose Message mode and confirm the agent is at its normal input prompt.");
  if (pendingMessage) throw new Error("Wait for the previous message delivery.");
  const id = globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random();
  const target = JSON.parse(JSON.stringify(context));
  $("message-ready").checked = false;
  return new Promise((resolve, reject) => {
    pendingMessage = { id, resolve, reject, timer: setTimeout(() => failPendingMessage("No delivery confirmation. Review the terminal before retrying.", "uncertain"), 5000) };
    send({ t: "submit-message", requestId: id, session: agentSession, context: target, text, ready: true });
    updateComposer();
  });
}
function failPendingMessage(reason, delivery) {
  if (!pendingMessage) return;
  const pending = pendingMessage; pendingMessage = null; clearTimeout(pending.timer);
  const error = new Error(reason); error.delivery = delivery; pending.reject(error);
}
function updateComposer() {
  if (!$("message-input")) return;
  const running = OWNER && ws?.readyState === 1 && agentStatus === "running";
  $("message-input").disabled = !running || inputMode !== "message" || !!pendingMessage;
  $("message-ready").disabled = !running || inputMode !== "message" || !!pendingMessage;
  $("send-message").disabled = !running || !dataFresh || inputMode !== "message" || !$("message-ready").checked || !!pendingMessage;
}
// Chat tabs: Message shows the composer, Terminal the xterm. Picking a tab also asks for that input mode, as the old mode buttons did.
let chatPane = "message";
function showChatPane(mode) {
  chatPane = mode;
  for (const m of ["message", "terminal"]) $("chat-tab-" + m).setAttribute("aria-selected", String(m === mode));
  $("term").hidden = mode !== "terminal"; $("composer").hidden = mode !== "message";
  if (mode === "terminal") fit.fit(); // xterm cannot measure itself while hidden
}
for (const mode of ["terminal", "message"]) $("chat-tab-" + mode).onclick = () => {
  showChatPane(mode);
  if (termUp() && !pendingMessage) send({ t: "input-mode", mode, session: agentSession });
};
function focusChat() {
  if (chatPane === "terminal") return term.focus();
  ($("message-input").disabled ? $("chat-tab-message") : $("message-input")).focus();
}
if ($("message-ready")) $("message-ready").onchange = () => updateComposer();
if ($("message-input")) $("message-input").oninput = () => {
  if (have()) messageDrafts.set(notesKey(), $("message-input").value);
  if (have()) try { localStorage.setItem("flow-studio-message:" + notesKey(), $("message-input").value); } catch { /* memory draft retained */ }
};
if ($("send-message")) $("send-message").onclick = async () => {
  const box = $("message-input"), text = box.value, scope = notesKey(), context = getUiContext();
  if (!text.trim() || !have()) return;
  try {
    await typeToAgent(text, context);
    if (notesKey() === scope && box.value === text) box.value = "";
    messageDrafts.delete(scope);
    try { localStorage.removeItem("flow-studio-message:" + scope); } catch { /* optional storage */ }
    $("message-status").textContent = "Forwarded to the CLI. Check its response above; this is not a completion receipt.";
  } catch (e) { $("message-status").textContent = e.message; }
  updateComposer();
};
term.onData((d) => { if (termUp() && inputMode === "terminal" && !pendingMessage) send({ t: "i", d, session: agentSession }); });
term.onResize(({ cols, rows }) => send({ t: "r", cols, rows }));
$("restart").onclick = () => {
  retry = 0;
  if (ws && ws.readyState === 1) send({ t: "restart" });
  else connect(); // reconnect to the existing session; an exited process stays exited until Restart
};
$("agent").onchange = () => terminalControls();
$("switch-agent").onclick = () => {
  if (!ws || ws.readyState !== 1) return toast("Connect the terminal with Restart before switching agents.");
  if ($("agent").value !== activeAgent) send({ t: "agent", agent: $("agent").value });
};
terminalControls();
$("expand-terminal").onclick = () => {
  const expanded = document.body.classList.toggle("terminal-expanded");
  if (expanded) showChatPane("terminal");
  $("expand-terminal").textContent = expanded ? "Restore layout" : "Expand terminal";
  $("expand-terminal").setAttribute("aria-pressed", String(expanded));
  fit.fit(); term.focus();
};
// The terminal stays mounted while Chat is closed, so the session and its scrollback survive (drawers below).
addEventListener("resize", () => fit.fit());
fit.fit();
if (OWNER) connect();
else term.write("View-only window. Open Alerts for how to fix it.\r\n");

// ---- screen context: the stage follows the step the video is at; drafts are kept per video ----
let selection = null, restoredScope = "";
const messageDrafts = new Map();
const expandedGuides = new Set();
const stageNames = { ideas: "Ideas", plan: "Plan", storyboard: "Storyboard", generate: "Generate", edit: "Edit" };
// The agent's context schema still speaks in the five old stages; each step maps onto one.
const STAGE_OF = { idea: "ideas", plan: "plan", look: "storyboard", assets: "generate", edit: "edit" };
function restoreScope(scope) {
  if (restoredScope === scope) return;
  restoredScope = scope; selection = null;
  let draft = messageDrafts.get(scope) || "";
  try { draft = localStorage.getItem("flow-studio-message:" + scope) || draft; } catch { /* in-memory draft */ }
  $("message-input").value = draft;
  $("message-ready").checked = false; updateComposer();
  publishContextSoon();
}
function getUiContext() {
  return { ...cur(), stage: view, ...(selection ? { selection: { ...selection } } : {}) };
}
function selectContextItem(item) {
  selection = item; publishContextSoon(); refresh(true);
}
let contextTimer, contextSequence = 0, contextChain = Promise.resolve();
const contextWindow = globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random();
function publishContextSoon() {
  clearTimeout(contextTimer);
  updateContextLabel();
  if (!OWNER || !have() || document.visibilityState !== "visible" || !document.hasFocus()) return;
  const context = getUiContext(), sequence = ++contextSequence;
  contextTimer = setTimeout(() => {
    contextChain = contextChain.catch(() => {}).then(async () => {
      if (sequence !== contextSequence || document.visibilityState !== "visible" || !document.hasFocus()) return;
      try {
        await owner("/api/ui-context", { context, windowId: contextWindow, sequence });
        if (sequence === contextSequence) { $("context-sync").textContent = "Screen context synced"; $("context-sync").hidden = true; }
      } catch { $("context-sync").hidden = false; $("context-sync").textContent = "Screen sync unavailable. Messages still carry their captured target."; }
    });
  }, 120);
}
function updateContextLabel() {
  const item = selection?.kind === "render" ? ` · Render v${selection.version}` : selection?.kind === "take" ? ` · Scene ${selection.scene}, take ${selection.takeIndex}` : selection ? ` · Scene ${selection.scene}` : "";
  $("context-target").textContent = have() ? `${cur().project} / ${cur().sub} · ${stageNames[view]}${item}` : "Viewing: no project selected";
}
addEventListener("focus", () => publishContextSoon());
$("new-project-toggle").onclick = () => {
  const box = $("project-setup"); box.hidden = !box.hidden;
  $("project-setup-copy").textContent = "Create a project or another video. Existing work stays intact.";
  $("create-project").textContent = "Create project";
  $("new-project-toggle").setAttribute("aria-expanded", String(!box.hidden));
};
$("start-new-ad").onclick = startNewAd;
$("activity-toggle").onclick = () => { const box = $("activity-panel"); box.hidden = !box.hidden; $("activity-toggle").setAttribute("aria-expanded", String(!box.hidden)); refresh(true); };
// Bar toggles: each shows or hides one panel and mirrors it in aria-expanded.
function toggle(button, panel, open = panel.hidden) {
  panel.hidden = !open; button.setAttribute("aria-expanded", String(open));
}
$("project-menu").onclick = () => toggle($("project-menu"), $("project-panel"));
addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("project-panel").hidden) { toggle($("project-menu"), $("project-panel"), false); $("project-menu").focus(); } });
// Notices stay out of the way behind the badge; the connection banner shows itself because it disables writes.
// The badge names the worst alert from this fixed map (never server text), most severe first; the list holds one entry per notice.
let flowFailed = []; // names of the failed Flow health checks
const HEALTH_LABEL = { "signed in": "Flow signed out", flow: "Flow not open" };
let lessonSig = "";
function renderAlerts() {
  const health = flowFailed.length > 0, lessons = data.lessons || [];
  const flow = HEALTH_LABEL[["signed in", "flow"].find((n) => flowFailed.includes(n))] || "Flow check failed";
  const stale = (data.plan?.scenes || []).filter((s) => s.kept && s.clip && s.stale !== undefined).map((s) => s.n);
  const held = [...(data.pending || []), ...(data.other || [])].reduce((n, g) => n + g.jobs.length, 0);
  const labels = [!OWNER && "View-only window", health && flow, !dataFresh && "Offline", stale.length && "Stale kept clips", held && "Jobs await approval", ...lessons.map(() => "Lesson to review")].filter(Boolean);
  $("alerts").hidden = !labels.length;
  $("alerts").textContent = labels.length > 1 ? `${labels[0]} (${labels.length})` : labels[0] || "";
  $("alerts").setAttribute("aria-label", `Alerts: ${labels.length}, worst: ${labels[0] || "none"}`);
  $("alert-owner").hidden = OWNER;
  $("alert-health").hidden = !health; $("health-label").textContent = flow;
  $("alert-offline").hidden = dataFresh; $("connection-full").textContent = connectionMessage || "Studio is not connected.";
  $("alert-stale").hidden = !stale.length; $("stale-full").textContent = `Kept scenes ${stale.join(", ")} need a redo because their source changed. Redo them in Details before editing.`;
  $("alert-held").hidden = !held; $("held-full").textContent = `${held} job${held === 1 ? "" : "s"} wait for your credit approval. Nothing is spent until you approve.`;
  $("alerts-empty").hidden = labels.length > 0;
  // Lesson proposals: the Save/Discard actions moved here unchanged; rebuilt only when they change, so typing survives polls.
  const sig = JSON.stringify([lessons.map((l) => [l.id, l.text, l.scope]), dataFresh]);
  if (sig === lessonSig) return;
  lessonSig = sig;
  $("lesson-items").replaceChildren(...lessons.map((l) => {
    const txt = h("input", { value: lessonText[l.id] ?? l.text, "aria-label": "Lesson text" });
    txt.oninput = () => (lessonText[l.id] = txt.value);
    return h("li", {}, h("details", {}, h("summary", {}, "Lesson to review"), h("div", { class: "lesson" }, h("b", {}, "Learned: "), txt, h("small", {}, ` [${l.scope}] `),
      btn("Save", () => owner("/api/lessons/resolve", { id: l.id, action: "save", editedText: txt.value }), true),
      btn("Discard", () => owner("/api/lessons/resolve", { id: l.id, action: "discard" }), true))));
  }));
}
function startNewAd() {
  const project = cur().project;
  const subs = new Set(projects.find(p => p.project === project)?.subs || []);
  let number = 1;
  while (subs.has(`ad-${String(number).padStart(2, "0")}`)) number++;
  $("new-project-name").value = project;
  $("new-sub-name").value = `ad-${String(number).padStart(2, "0")}`;
  $("new-aspect").value = data.plan?.aspect || "9:16";
  $("project-setup-copy").textContent = "Start a fresh video at Idea. Your finished video and its renders stay available in the Video picker.";
  $("create-project").textContent = "Create video";
  $("project-setup").hidden = false;
  $("new-project-toggle").setAttribute("aria-expanded", "true");
  $("new-sub-name").focus(); $("new-sub-name").select();
}
async function createProject() {
  const button = $("create-project"); button.disabled = true;
  try {
    const project = slug($("new-project-name").value), sub = slug($("new-sub-name").value);
    await apiOk("studio_new", { project, sub, aspect: $("new-aspect").value });
    await apiOk("studio_select", { project, sub });
    await loadProjects(); $("project").value = project; fillSubs(); $("sub").value = sub;
    projectChanged(); $("project-setup").hidden = true; $("new-project-toggle").setAttribute("aria-expanded", "false");
  } catch (e) { toast(e.message); }
  finally { button.disabled = false; }
}
$("create-project").onclick = createProject;

// ---- account chips: index + credits only; amber under 20, red when exhausted with the refresh time ----
async function accounts() {
  try {
    const list = await (await fetch("/api/accounts")).json();
    $("chips").replaceChildren(...list.map((a) => {
      const c = document.createElement("span");
      c.className = "chip" + (a.exhausted ? " out" : a.credits !== null && a.credits < 20 ? " low" : "");
      const when = a.exhausted && a.refreshAt ? " - back " + new Date(a.refreshAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
      c.textContent = `#${a.index} ${a.credits ?? "?"}${when}`;
      return c;
    }));
  } catch { /* keep the old chips */ }
}
accounts();
setInterval(accounts, 60000);

// ---- project / sub picker (studio_projects returns [{project, subs: string[]}]) ----
let projects = [];
function fillSubs() {
  const p = projects.find((x) => x.project === $("project").value);
  $("sub").replaceChildren(...(p ? p.subs : []).map((s) => new Option(s, s)));
}
async function loadProjects() {
  try {
    const r = await api("studio_projects");
    projects = Array.isArray(r) ? r : [];
    $("project").replaceChildren(...projects.map((p) => new Option(p.project, p.project)));
    fillSubs();
    // Follow what the engine already has selected (e.g. after a reload) instead of defaulting to the first project.
    const s = await api("studio_current");
    const p = s && projects.find((x) => x.project === s.project);
    if (p && p.subs.includes(s.sub)) { $("project").value = s.project; fillSubs(); $("sub").value = s.sub; }
  } catch { /* picker stays empty */ }
  refresh(true);
}
function projectChanged() {
  selection = null; data.workflow = null;
  connectionState(false, "Loading selected project…");
  renderGate(stepState());
  updateContextLabel(); refresh(true);
}
$("project").onchange = () => { fillSubs(); projectChanged(); };
$("sub").onchange = projectChanged;
loadProjects();

// ---- health banner: /api/health/flow lists the Flow checks that failed (textContent only) ----
function checkHealth() {
  return fetch("/api/health/flow", { headers: { "x-flow-token": TOKEN } }).then((r) => (r.ok ? r.json() : null)).then((h) => {
    const failed = h && h.ok === false && Array.isArray(h.checks) ? h.checks.filter((c) => c && !c.ok).map((c) => String(c.name)) : [];
    flowFailed = failed.length || !(h && h.ok === false && h.message) ? failed : ["unknown"];
    $("health").textContent = flowFailed.length ? "Flow check: " + h.message : "";
    renderAlerts();
  }).catch(() => {});
}
checkHealth();

// ======== step views ========
// Plan text is written by Claude: every string goes in through textContent, never innerHTML.
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 6000); }
const btn = (label, onclick, owner = false, cls = "") => {
  const b = h("button", { type: "button", class: cls, "data-write": "1" }, label);
  b.onclick = async () => {
    b.disabled = true;
    try { await onclick(); } catch (e) { toast(String(e.message || e)); }
    b.disabled = !dataFresh || (owner && !OWNER) || b.dataset.locked === "1";
    refresh(true);
  };
  if (owner && !OWNER) { b.disabled = true; b.title = "This window is not the owner window and cannot approve credits."; }
  if (!dataFresh) b.disabled = true;
  return b;
};
const cur = () => ({ project: $("project").value, sub: $("sub").value });
const have = () => { const c = cur(); return !!(c.project && c.sub); };
const apiOk = async (method, body) => {
  const r = await api(method, body);
  if (r && r.error) throw new Error(r.error);
  return r;
};
const owner = async (path, body) => {
  const r = await requestJson(path, { method: "POST", headers: { "x-flow-token": TOKEN }, body: JSON.stringify(body) });
  if (r && r.error) throw new Error(r.error);
  return r;
};
const media = (p) => "/media?token=" + encodeURIComponent(TOKEN) + "&path=" + encodeURIComponent(p);
async function upload(file) {
  const r = await (await fetch("/api/upload?name=" + encodeURIComponent(file.name), { method: "POST", headers: { "x-flow-token": TOKEN }, body: file })).json();
  if (r.error) throw new Error(r.error);
  return r.path;
}
function picker(label, onFile, accept) {
  const i = h("input", { type: "file", accept: accept || "image/*" });
  i.onchange = async () => {
    if (!i.files[0]) return;
    try { await onFile(i.files[0]); toast("Uploaded " + i.files[0].name); } catch (e) { toast(String(e.message || e)); }
    i.value = "";
    refresh(true);
  };
  return h("label", { class: "pick" }, label + " ", i);
}
// Per-scene duration; saves through the plan (settings changes do not clear approval).
const isVeo = (s) => /^veo/i.test(s.model || "");
function durationPick(s) {
  const scope = cur();
  if (isVeo(s)) return h("span", {}, "8 s · fixed"); // Flow fixes Veo clips at 8 s
  const sel = h("select", { "aria-label": `Scene ${s.n} duration` }, ...[4, 6, 8, 10].map((d) => h("option", { value: d, selected: d === (s.duration || 8) }, d + " s")));
  sel.onchange = () => savePlan((pl) => { pl.scenes.find((x) => x.n === s.n).duration = Number(sel.value); }, scope).then(() => refresh(true), (e) => { toast(e.message); refresh(true); });
  return sel;
}
async function savePlan(mut, scope = cur()) {
  const target = { ...scope };
  const { lessons, note, creative_guide, ...plan } = await apiOk("studio_plan_read", target);
  mut(plan);
  // rev: refused if the plan changed between this read and the write. approved/kept/storyboard/clip are ignored here.
  await apiOk("studio_plan_write", { ...target, rev: plan.rev ?? 0, plan });
}
const slug = (s) => s.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");

let view = "ideas";
let data = { plan: null, workflow: null, pending: [], other: [], status: null, lessons: [], notes: null };
let sig = "";
const notesKey = () => cur().project + "/" + cur().sub;
// Notes and Edit notes share this: the page re-reads on every poll unless the box has focus or a save is pending (then local text wins).
function makeNotes(id, label, readM, writeM) {
  const st = { text: {}, rev: {}, conflict: {}, status: {}, timers: new Map(), pending: new Map(), inFlight: new Map() };
  const draftKey = (key) => `flow-studio-draft:${id}:${key}`;
  const persist = (key) => { try { localStorage.setItem(draftKey(key), JSON.stringify({ text: st.text[key], rev: st.rev[key] })); } catch {} };
  const forget = (key) => { try { localStorage.removeItem(draftKey(key)); } catch {} };
  st.paint = (key, message) => {
    st.status[key] = message;
    if (typeof document !== "undefined" && key === notesKey()) {
      const el = document.getElementById(id + "-status"); if (el) el.textContent = message;
    }
  };
  st.dirty = () => !!(st.timers.size || st.inFlight.size || Object.keys(st.conflict).length);
  st.load = async () => {
    const key = notesKey();
    if (!st.timers.has(key) && !st.inFlight.has(key) && !st.conflict[key] && document.activeElement?.id !== id) {
      const r = await apiOk(readM, cur());
      if (r && typeof r.text === "string") {
        let draft; try { draft = JSON.parse(localStorage.getItem(draftKey(key))); } catch {}
        st.text[key] = r.text; st.rev[key] = r.rev;
        if (draft && typeof draft.text === "string" && draft.text !== r.text) {
          if (draft.rev === r.rev) { st.text[key] = draft.text; st.paint(key, "Unsaved draft restored"); }
          else { st.conflict[key] = draft.text; st.paint(key, "Save failed: saved notes changed; review your draft below"); }
        } else st.paint(key, "Saved");
      }
    }
    return st.text[key] ?? null;
  };
  st.save = (key, c) => {
    clearTimeout(st.timers.get(key)); st.timers.delete(key); st.pending.delete(key);
    const text = st.text[key], previous = st.inFlight.get(key);
    st.paint(key, "Saving..."); persist(key);
    const work = (async () => {
      await previous;
      try {
        const r = await apiOk(writeM, { ...c, text, rev: st.rev[key] });
        st.rev[key] = r.rev;
        if (st.text[key] === text) { forget(key); delete st.conflict[key]; st.paint(key, "Saved"); }
        else { persist(key); st.paint(key, "Unsaved changes"); }
      } catch (e) {
        st.conflict[key] = st.text[key]; persist(key);
        st.paint(key, "Save failed: " + (e.message || e));
        toast(String(e.message || e) + " Your draft is preserved below " + label + ".");
      } finally {
        if (st.inFlight.get(key) === work) st.inFlight.delete(key);
        // Preserve the live textarea and caret; update the save status without replacing the focused element.
        refresh(false);
      }
    })();
    st.inFlight.set(key, work); return work;
  };
  st.flush = async (key = notesKey()) => {
    while (st.timers.has(key) || st.inFlight.has(key)) {
      if (st.timers.has(key)) await st.save(key, st.pending.get(key));
      else await st.inFlight.get(key);
    }
    if (st.status[key] === "Unsaved draft restored") await st.save(key, cur());
  };
  st.box = (c, rows, placeholder) => {
    const ta = h("textarea", { id, rows, "aria-label": label, placeholder }), key = c.project + "/" + c.sub;
    ta.value = st.text[key] ?? ""; ta.disabled = !(key in st.text);
    ta.oninput = () => {
      if (!(key in st.text)) return;
      st.text[key] = ta.value; persist(key); st.paint(key, "Unsaved changes");
      clearTimeout(st.timers.get(key)); st.pending.set(key, c);
      st.timers.set(key, setTimeout(() => st.save(key, c), 800));
    };
    const lost = st.conflict[key];
    const lostBox = lost === undefined ? null : h("div", { class: "lesson" },
      h("b", {}, `Your unsaved ${label.toLowerCase()} (copy what you need before dismissing):`),
      h("textarea", { rows: "4", readonly: true, "aria-label": "Unsaved " + label.toLowerCase() }, lost),
      btn("Save preserved draft instead", async () => {
        const draft = st.conflict[key]; if (draft === undefined) return;
        const latest = await apiOk(readM, c);
        st.rev[key] = latest.rev; st.text[key] = draft; persist(key);
        await st.save(key, c);
      }),
      btn("Reload saved notes", async () => {
        const r = await apiOk(readM, c); st.rev[key] = r.rev; st.text[key] = r.text;
        delete st.conflict[key]; forget(key); st.paint(key, "Saved");
      }));
    return [h("div", {}, ta, h("p", { id: id + "-status", role: "status", class: "dim" }, st.status[key] || "Loading notes...")), lostBox];
  };
  return st;
}
const notes = makeNotes("notes", "Notes", "studio_notes_read", "studio_notes_write");
const editNotes = makeNotes("edit-notes", "Edit notes", "studio_edit_notes_read", "studio_edit_notes_write");
let reported = "", seen = "";
async function fetchData() {
  // Tell the engine (and so Claude) which project/sub the owner has selected; awaited so the next read is not stale.
  if (have() && reported !== notesKey()) {
    const k = notesKey();
    try { await api("studio_select", cur()); reported = seen = k; } catch { /* retried on the next poll */ }
  }
  // If Claude (or anything else) changed the selection, say so and follow it rather than fight it.
  const s = await api("studio_current").catch(() => null);
  if (s && s.project && s.sub) {
    const k = s.project + "/" + s.sub;
    if (k !== seen) {
      seen = k;
      const p = projects.find((x) => x.project === s.project);
      if (p && p.subs.includes(s.sub) && k !== notesKey()) {
        $("project").value = s.project; fillSubs(); $("sub").value = s.sub; reported = k;
        renderGate(stepState()); // clears the old video's gate at once, before its data arrives
        toast("The agent switched the project to " + k);
      }
    }
  }
  const get = (p) => requestJson(p, { headers: { "x-flow-token": TOKEN } });
  const pendingAll = await get("/api/pending");
  const groups = Array.isArray(pendingAll) ? pendingAll : [];
  if (!have()) { data = { plan: null, pending: [], other: groups, status: null, lessons: [], notes: null }; return; }
  const scope = cur(), scopeKey = scope.project + "/" + scope.sub;
  // The desk needs every step's status, each scene's jobs and the latest render, whether or not Details is open.
  const [plan, workflow, st, r] = await Promise.all([api("studio_plan_read", scope), apiOk("studio_workflow_read", scope), api("studio_status", scope), api("studio_renders", scope)]);
  if (cur().project + "/" + cur().sub !== scopeKey) { again = true; return false; }
  data.plan = plan.error ? null : plan;
  if (!workflow?.stages) throw new Error("Workflow readiness unavailable");
  data.workflow = workflow;
  data.status = st.error ? null : st; data.statusScope = scopeKey;
  data.renders = r && r.renders ? r.renders : [];
  restoreScope(scopeKey);
  view = data.status?.steps ? STAGE_OF[currentStep() ?? "edit"] : workflow.recommendedStage;
  const requestedStage = view, details = !$("details").hidden;
  data.guide = details && ["ideas", "plan", "storyboard"].includes(requestedStage) ? await apiOk("studio_guide_read", { stage: requestedStage }) : null;
  if (selection?.scene && !plan.scenes?.some(s => s.n === selection.scene)) { selection = null; publishContextSoon(); }
  const mine = (g) => g.jobs.some((j) => j.params.studio && j.params.studio.project === plan.project && j.params.studio.sub === plan.sub);
  data.pending = groups.filter(mine);
  data.other = groups.filter((g) => !mine(g)); // non-studio jobs and other sub-projects: still approvable/cancellable here
  if (details && data.plan) {
    data.notes = await notes.load();
    const refs = await api("studio_references", scope);
    data.activeRefs = refs.active ?? [];
    data.libraryRefs = refs.library ?? [];
  }
  if (details) {
    data.editNotes = await editNotes.load();
    const task = await api("studio_edit_task_read", scope); data.editTask = task.task || null;
  }
  data.lessons = (await get("/api/lessons")).pending || []; // lesson proposals are alerts
  if (notesKey() !== scopeKey || view !== requestedStage) { again = true; return false; }
  return true;
}
const editing = () => { const a = document.activeElement; return !!a && !!a.closest("#details, #alerts-list") && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== "file"; };
let busy = false, again = false;
async function refresh(force) {
  if (busy) { if (force) again = true; return; }
  if (!force && (document.visibilityState !== "visible" || editing())) return;
  busy = true;
  try {
    const fetched = await fetchData();
    if (fetched === false) { busy = false; again = false; refresh(true); return; }
    const recovered = !dataFresh;
    connectionState(true);
    const s = view + JSON.stringify(data);
    if (force || recovered || s !== sig) { sig = s; render(); }
  } catch (error) {
    connectionState(false, error.status === 401 ? "Studio restarted. Reload this window to reconnect." : "Could not refresh Studio: " + error.message + ". Retry to reconnect; your drafts are kept.");
  }
  busy = false;
  if (again) { again = false; refresh(true); }
}
// Cheap local polling, only while the window is visible.
setInterval(() => { if (document.visibilityState === "visible") { refresh(false); accounts(); } }, 4000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh(true));
// A hidden window polls only while a step of this video is working, and slower, so the title and notification still arrive.
function hiddenPoll() { if (document.visibilityState !== "visible" && have() && STEPS.some((n) => stepState()[n]?.status === "working")) refresh(true); }
setInterval(hiddenPoll, 15000);

// ======== review desk: steps row, player and scene strip ========
// Scene and plan text from the agent only ever reaches the DOM through h() (text nodes and attributes).
const STEPS = ["idea", "plan", "look", "assets", "edit"];
const STEP_ICON = { approved: "✓", working: "◌", review: "●", changes: "↺", blocked: "!", idle: "" };
const STEP_WORD = { approved: "approved", working: "working", review: "ready for review", changes: "changes asked", blocked: "blocked", idle: "not started" };
const MARK_ICON = { done: "✓", flag: "⚑", working: "◌", stale: "↻", none: "" };
const MARK_WORD = { done: "done", flag: "flagged", working: "working", stale: "stale", none: "not started" };
const isStillScene = (s) => s.kind === "still"; // no kind = clip
const stepState = () => data.status?.steps?.steps || {};
const currentStep = () => STEPS.find((n) => stepState()[n]?.status !== "approved") ?? null;
let stripFilter = "all", stripSig = "";
const collapsedSections = new Set();
function selectScene(n) {
  selectContextItem(n == null ? null : { kind: "scene", scene: n });
  renderDesk();
}
// Precedence: flag, working, stale, done, none.
function markOf(s, flagged, jobs, assetStepWorking) {
  const asset = isStillScene(s) ? s.storyboard : s.clip;
  if (flagged.has(s.n)) return "flag";
  if ((jobs.get(s.n) || []).some((j) => ["held", "queued", "running"].includes(j.status)) || (!asset && assetStepWorking)) return "working";
  if (s.stale !== undefined) return "stale";
  return asset ? "done" : "none";
}
function renderSteps() {
  const st = stepState(), now = currentStep();
  for (const li of document.querySelectorAll("#steps li")) {
    const step = li.dataset.step, status = st[step]?.status || "idle";
    li.dataset.status = status;
    if (step === now) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    li.replaceChildren(h("span", { class: "step-icon", "aria-hidden": "true" }, STEP_ICON[status] || ""),
      h("span", { class: "step-name" }, step[0].toUpperCase() + step.slice(1)), h("span", { class: "sr-only" }, ", " + (STEP_WORD[status] || status)));
  }
}
function renderStrip(scenes, flags) {
  const flagged = new Set(flags.map((f) => f.scene).filter((n) => n != null));
  const jobs = new Map((data.status?.scenes || []).map((x) => [x.n, x.jobs || []]));
  const now = currentStep(), assetStepWorking = (now === "look" || now === "assets") && stepState()[now]?.status === "working";
  const tiles = scenes.map((s) => ({ s, kind: isStillScene(s) ? "still" : "clip", mark: markOf(s, flagged, jobs, assetStepWorking) }))
    .filter((t) => stripFilter === "all" || t.mark === "flag");
  const grouped = stripFilter === "all" && scenes.some((s) => s.section);
  const sig = JSON.stringify([stripFilter, grouped, tiles.map((t) => [t.s.n, t.kind, t.mark, t.s.storyboard, t.s.section])]);
  const strip = $("strip");
  if (sig !== stripSig) {
    stripSig = sig;
    const focused = document.activeElement?.closest?.("#strip .tile")?.dataset.scene;
    const tile = (t) => {
      const b = h("button", { type: "button", class: "tile", tabindex: "-1", "data-scene": t.s.n, "data-kind": t.kind, "data-mark": t.mark, "aria-label": `Scene ${t.s.n}, ${t.kind}, ${MARK_WORD[t.mark]}` },
        // ponytail: clips without a still show no thumbnail; a video frame per tile would be too heavy for hundreds of scenes.
        t.s.storyboard ? h("img", { src: media(t.s.storyboard), alt: "", loading: "lazy", decoding: "async", onerror: (e) => { e.target.hidden = true; } }) : null,
        h("span", { class: "tile-kind", "aria-hidden": "true" }, t.kind === "still" ? "▣" : "▶"),
        t.mark === "none" ? null : h("span", { class: "tile-mark", "aria-hidden": "true" }, MARK_ICON[t.mark]),
        h("span", { class: "tile-n", "aria-hidden": "true" }, String(t.s.n)));
      b.onclick = () => selectScene(t.s.n);
      return b;
    };
    let kids = tiles.map(tile);
    if (grouped) {
      const groups = [];
      for (const t of tiles) {
        const name = t.s.section || "";
        if (groups.at(-1)?.name !== name) groups.push({ name, tiles: [] });
        groups.at(-1).tiles.push(t);
      }
      kids = groups.map(({ name, tiles: list }) => {
        const body = h("div", { class: "group-tiles", hidden: collapsedSections.has(name) }, list.map(tile));
        const label = name ? h("button", { type: "button", class: "group-label", "aria-expanded": String(!collapsedSections.has(name)) }, name) : null;
        if (label) label.onclick = () => {
          const open = body.hidden;
          if (open) collapsedSections.delete(name); else collapsedSections.add(name);
          for (const g of strip.querySelectorAll(".group")) if (g.dataset.section === name) {
            g.querySelector(".group-tiles").hidden = !open;
            g.querySelector(".group-label").setAttribute("aria-expanded", String(open));
          }
          renderStrip(scenes, flags);
        };
        return h("div", { class: "group", role: "group", "data-section": name, "aria-label": name || "Scenes" }, label, body);
      });
    }
    strip.replaceChildren(...(kids.length ? kids : [h("p", { class: "strip-empty" }, stripFilter === "flag" ? "No flags" : "No scenes")]));
    if (focused) strip.querySelector(`.tile[data-scene="${Number(focused)}"]`)?.focus();
  }
  // Roving tabindex: the selected tile (or the first visible one) is the strip's single tab stop.
  const all = [...strip.querySelectorAll(".tile")], visible = all.filter((b) => b.checkVisibility());
  for (const b of all) { b.tabIndex = -1; if (Number(b.dataset.scene) === selection?.scene) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); }
  const stop = visible.find((b) => Number(b.dataset.scene) === selection?.scene) || visible[0];
  if (stop) stop.tabIndex = 0;
}
$("strip").onkeydown = (e) => {
  const tile = e.target.closest?.(".tile");
  if (!tile) return;
  const all = [...$("strip").querySelectorAll(".tile")].filter((b) => b.checkVisibility()), i = all.indexOf(tile);
  const next = all[{ ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key]];
  if (!next) return;
  e.preventDefault();
  selectScene(Number(next.dataset.scene));
  next.focus();
};
// A mouse wheel scrolls the one-row strip sideways.
$("strip").onwheel = (e) => {
  const el = $("strip");
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { el.scrollLeft += e.deltaY; e.preventDefault(); }
};
for (const b of document.querySelectorAll("#strip-filter button")) b.onclick = () => {
  stripFilter = b.dataset.filter;
  for (const x of document.querySelectorAll("#strip-filter button")) x.setAttribute("aria-pressed", String(x === b));
  renderDesk();
};
function renderPlayer(sel) {
  const scenes = data.plan?.scenes || [], renders = data.renders || [];
  const s = sel?.scene ? scenes.find((x) => x.n === sel.scene) : null;
  let label = "Player", src = "", tag = "";
  if (s) {
    label = `Scene ${s.n}, ${isStillScene(s) ? "still" : "clip"}`;
    const take = sel.kind === "take" ? data.status?.scenes?.find((x) => x.n === s.n)?.takes?.[sel.takeIndex - 1] : null;
    if (take) { label += `, take ${sel.takeIndex}`; src = take.clip; tag = "video"; }
    else if (isStillScene(s) || !s.clip) { src = s.storyboard; tag = "img"; }
    else { src = s.clip; tag = "video"; }
  } else if (renders.length) {
    const r = renders.find((x) => sel?.kind === "render" && x.version === sel.version) || renders[renders.length - 1];
    label = `Render v${r.version}`; src = r.path; tag = "video";
  }
  const empty = s ? "" : have() ? "Select a scene" : "Choose a project";
  const el = $("player"), key = label + "\n" + (src || "") + "\n" + empty;
  if (el.dataset.key === key) return; // keep a playing video playing across refreshes
  el.dataset.key = key;
  el.setAttribute("aria-label", label);
  // A scene with no file yet, or one that fails to load, gets a quiet placeholder instead of the broken-media icon.
  const placeholder = () => h("p", { class: "player-empty" }, s ? h("span", { class: "player-icon", "aria-hidden": "true" }, isStillScene(s) ? "\u25a3" : "\u25b6") : null, s ? label : empty);
  const fail = () => { if (el.dataset.key === key) el.replaceChildren(placeholder()); };
  el.replaceChildren(...[!src ? placeholder()
    : tag === "img" ? h("img", { src: media(src), alt: label, onerror: fail }) : h("video", { src: media(src), controls: true, preload: "metadata", playsinline: true, onerror: fail }),
    src ? h("span", { class: "player-label", "aria-hidden": "true" }, label) : null].filter(Boolean));
}
function renderDesk() {
  $("project-name").textContent = have() ? `${cur().project} · ${cur().sub}` : "Projects";
  renderSteps();
  renderStrip(data.plan?.scenes || [], stepState()[currentStep()]?.flags || []);
  renderPlayer(selection);
  renderFlagNote();
  renderGate(stepState());
  renderAlerts();
}
// The agent's note on the selected flagged scene: one line under the player, the whole note on click.
function renderFlagNote() {
  const flag = selection?.scene && (stepState()[currentStep()]?.flags || []).find((f) => f.scene === selection.scene), el = $("flag-note");
  const text = flag ? flag.note : "";
  el.hidden = !flag;
  if (el.dataset.note !== text) { el.dataset.note = text; el.setAttribute("aria-expanded", "false"); el.replaceChildren(h("span", { "aria-hidden": "true" }, "⚑ "), h("span", { class: "sr-only" }, "Flag: "), text); }
}
$("flag-note").onclick = () => $("flag-note").setAttribute("aria-expanded", String($("flag-note").getAttribute("aria-expanded") !== "true"));

// ======== gate bar: the one place the owner approves, asks for changes, sets budgets and resumes ========
// Every action goes to POST /api/step (owner cookie); a non-owner or offline window has every control disabled.
const stepLabel = (n) => n[0].toUpperCase() + n.slice(1);
const GATE_WORD = { working: "working", paused: "paused", review: "ready for review", changes: "changes sent", blocked: "blocked", idle: "not started" };
const GATE_CONTROLS = ["start", "approve", "ask-changes", "resume", "add-credits", "send-changes", "budget-look", "budget-assets", "credits-budget", "changes-text", "pin-scene"];
let gatePending = false, gateTarget = null, gateKey = "", gateScope = "", gateNotice = "", askedNotify = false;
const gateSeen = new Map(); // scope -> "step:status" last rendered, so only a real transition notifies
function gateControls() {
  const off = !OWNER || !dataFresh || gatePending;
  for (const id of GATE_CONTROLS) $(id).disabled = off;
  $("send-changes").disabled = off || !$("changes-text").value.trim();
  if (!selection?.scene && !(data.renders || []).length) $("pin-scene").disabled = true;
}
const GATE_ICON = { working: "◌", paused: "‖", review: "●", changes: "◌", blocked: "!", idle: "○" };
const MAX_BUDGET = 100000; // a sanity cap: an absurd number in an input is one click from being a real budget
const wholeNumber = (v) => /^\d+$/.test(v.trim()) ? Number(v) : null;
const capped = (n) => n !== null && n <= MAX_BUDGET ? n : null;
const moreCredits = (reason) => Number(/^needs (\d+) more credits?\.?$/.exec(reason || "")?.[1]) || 0;
const creditsLeft = (x) => x.budget - x.spent - (x.reservations || []).reduce((a, r) => a + r.credits, 0); // remaining() in steps.ts
const currentScope = () => cur().project + "/" + cur().sub;
const gateStatusOf = (x) => !x?.status ? "" : x.status === "working" && x.paused ? "paused" : x.status;
function renderGate(steps) {
  // Steps fetched for another video (the selection just changed) draw nothing until this video's arrive.
  const scope = currentScope(), mine = have() && data.statusScope === scope;
  const step = mine ? STEPS.find((n) => steps[n]?.status !== "approved") ?? null : null, x = step ? steps[step] : null;
  const status = gateStatusOf(x);
  notifyGate(scope, step, status);
  $("gate").hidden = !status; $("gate").dataset.status = status;
  $("gate-live").textContent = status ? `${stepLabel(step)} ${GATE_WORD[status]}` : "";
  // A new video or step closes the forms and discards their drafts; the gate's one-line notice survives only into the redraw it asked for.
  if (scope + "/" + step !== gateScope) {
    gateScope = scope + "/" + step; gateKey = "";
    gateForm(false); $("changes-text").value = ""; $("pin-scene").checked = false;
    $("budget-look").value = $("budget-assets").value = $("credits-budget").value = "";
    $("gate-error").textContent = status ? gateNotice : "";
    if (status) gateNotice = "";
  }
  // Every request from this gate goes to exactly this video, step and state (gatePost), never to cur() at send time.
  gateTarget = status ? { project: cur().project, sub: cur().sub, step, status } : null;
  if (!status) return;
  const review = status === "review", plan = review && step === "plan", more = status === "blocked" ? moreCredits(x.blockedReason) : 0;
  const key = [gateScope, status, x.summary, x.blockedReason, x.budget].join("\n"), fresh = key !== gateKey;
  gateKey = key;
  $("gate-icon").textContent = GATE_ICON[status];
  $("gate-label").textContent = `${stepLabel(step)} · ${GATE_WORD[status]}`;
  const text = review ? x.summary || "" : status === "blocked" ? x.blockedReason || "" : "";
  $("gate-summary").textContent = text; $("gate-summary").hidden = !text;
  const scenes = data.plan?.scenes?.length || 0, flagged = x.flags?.length || 0;
  $("gate-counts").textContent = [scenes && `${scenes} scenes`, (scenes || flagged) && `${flagged} flagged`, x.budget && `${x.budget - creditsLeft(x)} of ${x.budget} credits`].filter(Boolean).join(" · ");
  $("gate-counts").hidden = !["review", "blocked", "paused"].includes(status) || !$("gate-counts").textContent;
  $("start").hidden = status !== "idle";
  $("approve").hidden = $("ask-changes").hidden = !review;
  $("approve").textContent = plan ? "Approve and set budgets" : "Approve";
  $("budget-form").hidden = !plan;
  $("gate-plan").hidden = !plan; // the whole plan document, at the gate that approves it
  $("resume").hidden = !(status === "paused" || (status === "blocked" && !more));
  $("add-credits").hidden = $("credits-label").hidden = !more;
  if (!review) gateForm(false);
  if (fresh) {
    // The Plan summary's third line is exactly "Estimate: Look N credits, Assets M credits"; anything else leaves the budgets empty.
    const est = plan ? /^Estimate: Look (\d+) credits, Assets (\d+) credits$/.exec((x.summary || "").split("\n")[2]?.trim() || "") : null;
    const ok = est && capped(Number(est[1])) !== null && capped(Number(est[2])) !== null;
    $("budget-look").value = ok ? est[1] : ""; $("budget-assets").value = ok ? est[2] : "";
    $("credits-budget").value = more && capped(x.budget + more) !== null ? x.budget + more : "";
    $("gate-summary").classList.remove("expanded"); $("gate-more").setAttribute("aria-expanded", "false"); $("gate-more").textContent = "More";
  }
  $("pin-label").textContent = !selection?.scene && (data.renders || []).length ? "Pin to this moment" : "Pin to this scene";
  const sum = $("gate-summary");
  $("gate-more").hidden = !text || (!sum.classList.contains("expanded") && sum.scrollHeight <= sum.clientHeight + 1);
  gateControls();
}
function notifyGate(scope, step, status) {
  if (!status) { document.title = "Flow Studio"; return; }
  const now = step + ":" + status, before = gateSeen.get(scope), asks = status === "review" || status === "blocked";
  gateSeen.set(scope, now);
  document.title = asks ? `● Review — ${cur().sub}` : "Flow Studio";
  // Video and step names only, never the agent's own text.
  if (asks && before !== undefined && before !== now && window.Notification?.permission === "granted")
    try { new Notification(`Review — ${cur().sub}`, { body: `${stepLabel(step)} ${GATE_WORD[status]}` }); } catch { /* the title still says it */ }
}
function gateForm(open) {
  $("changes-form").hidden = !open; $("ask-changes").setAttribute("aria-expanded", String(open));
}
// Posts the bodies in order and stops at the first refusal, so Add credits never resumes after a refused budget.
// The scope is the one captured when the gate was drawn; a reply that comes back after the video changed is ignored.
async function gatePost(...bodies) {
  const t = gateTarget;
  if (gatePending || !t) return false;
  const key = t.project + "/" + t.sub, same = () => currentScope() === key;
  if (!same() || data.statusScope !== key || gateStatusOf(stepState()[t.step]) !== t.status) {
    gateNotice = $("gate-error").textContent = "Video changed. Review again.";
    gateScope = ""; refresh(true);
    return false;
  }
  gatePending = true; $("gate-error").textContent = ""; gateControls();
  try {
    for (const b of bodies) {
      if (!same()) return false;
      await owner("/api/step", { project: t.project, sub: t.sub, step: t.step, ...b });
    }
    return same();
  } catch (e) { if (same()) $("gate-error").textContent = String(e.message || e); return false; }
  finally { gatePending = false; gateControls(); refresh(true); }
}
$("gate").addEventListener("click", (e) => {
  // Desktop notifications are asked for on the owner's first gate click, never on load.
  if (askedNotify || !e.target.closest("button") || window.Notification?.permission !== "default") return;
  askedNotify = true; Promise.resolve(Notification.requestPermission()).catch(() => {});
});
$("gate-more").onclick = () => { const open = $("gate-summary").classList.toggle("expanded"); $("gate-more").setAttribute("aria-expanded", String(open)); $("gate-more").textContent = open ? "Less" : "More"; };
$("start").onclick = () => gatePost({ action: "start" });
$("resume").onclick = () => gatePost({ action: "resume" });
$("approve").onclick = () => {
  if (gateTarget?.step !== "plan") return gatePost({ action: "approve" });
  const look = wholeNumber($("budget-look").value), assets = wholeNumber($("budget-assets").value);
  if (look === null || assets === null) { $("gate-error").textContent = "Enter both budgets"; return; }
  if (capped(look) === null || capped(assets) === null) { $("gate-error").textContent = `Up to ${MAX_BUDGET} credits`; return; }
  gatePost({ action: "approve", budgets: { look, assets } });
};
$("add-credits").onclick = () => {
  const credits = wholeNumber($("credits-budget").value);
  if (credits === null) { $("gate-error").textContent = "Enter a budget"; return; }
  if (capped(credits) === null) { $("gate-error").textContent = `Up to ${MAX_BUDGET} credits`; return; }
  gatePost({ action: "budget", credits }, { action: "resume" });
};
$("ask-changes").onclick = () => { const open = $("changes-form").hidden; gateForm(open); if (open) $("changes-text").focus(); };
$("changes-text").oninput = gateControls;
$("changes-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("changes-text").value.trim(), body = { action: "changes", text };
  if (!text || $("send-changes").disabled) return;
  if ($("pin-scene").checked && selection?.scene) body.scene = selection.scene;
  else if ($("pin-scene").checked) { const v = $("player").querySelector("video"); if (v) body.at = Math.round(v.currentTime * 10) / 10; }
  if (await gatePost(body)) { $("changes-text").value = ""; $("pin-scene").checked = false; gateForm(false); gateControls(); }
};
function render() {
  $("start-new-ad").disabled = !have() || !dataFresh;
  const pending = [...data.pending, ...data.other];
  $("activity-toggle").textContent = `Jobs (${pending.reduce((n, g) => n + g.jobs.length, 0)})`;
  renderDesk();
  if (!$("activity-panel").hidden) $("activity-panel").replaceChildren(...(pending.length ? pending.map(heldCard) : [h("p", {}, "No jobs waiting for credit approval.")]));
  updateContextLabel();
  renderDetails();
  if (!$("plan-reader").hidden) renderPlanReader();
}

// ======== drawers: Details, Chat, Alerts and the plan reader; one open at a time ========
const DRAWERS = ["details", "chat", "alerts-list", "plan-reader"];
const DRAWER_TOGGLE = { details: "details-toggle", chat: "chat-toggle", "alerts-list": "alerts" };
let drawerOpener = null;
const openDrawer = () => DRAWERS.find((id) => !$(id).hidden) || null;
function setDrawer(id, opener = null) {
  if (openDrawer() === "chat" && id !== "chat" && document.body.classList.contains("terminal-expanded")) $("expand-terminal").click();
  for (const d of DRAWERS) $(d).hidden = d !== id;
  for (const [d, t] of Object.entries(DRAWER_TOGGLE)) $(t).setAttribute("aria-expanded", String(d === id));
  for (const b of document.querySelectorAll('[aria-controls="plan-reader"]')) b.setAttribute("aria-expanded", String(id === "plan-reader"));
  drawerOpener = id ? opener : null;
  if (!id) return;
  if (id === "chat") { fit.fit(); return focusChat(); }
  if (id === "details") { renderDetails(); refresh(true); } // notes, references and the edit task load only while Details is open
  if (id === "plan-reader") renderPlanReader();
  $(id).querySelector(".drawer-close").focus();
}
const toggleDrawer = (id, opener) => setDrawer(openDrawer() === id ? null : id, opener);
function closeDrawer() {
  const back = drawerOpener;
  setDrawer(null);
  (back?.checkVisibility?.() ? back : $("details-toggle")).focus();
}
for (const b of document.querySelectorAll(".drawer-close")) b.onclick = closeDrawer;
$("details-toggle").onclick = () => toggleDrawer("details", $("details-toggle"));
$("chat-toggle").onclick = () => toggleDrawer("chat", $("chat-toggle"));
$("alerts").onclick = () => toggleDrawer("alerts-list", $("alerts"));
$("gate-plan").onclick = () => toggleDrawer("plan-reader", $("gate-plan"));
$("open-jobs").onclick = () => {
  setDrawer(null); toggle($("project-menu"), $("project-panel"), true);
  if ($("activity-panel").hidden) $("activity-toggle").click();
  $("activity-toggle").focus();
};
// Escape closes the open drawer, except inside the terminal, where it belongs to the CLI.
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !$("project-panel").hidden || !openDrawer() || e.target.closest?.("#term")) return;
  e.preventDefault(); closeDrawer();
});
// Optional explanations sit behind a "Why?" next to the control they explain; open ones stay open across redraws.
const openWhys = new Set();
// Any disclosure in the drawers keeps its open state across redraws by key (Details redraws whenever the data changes).
const keepOpen = (key) => ({ open: openWhys.has(key), ontoggle: (e) => { if (e.target.isConnected) { if (e.target.open) openWhys.add(key); else openWhys.delete(key); } } });
const why = (key, text) => h("details", { class: "why", ...keepOpen("why:" + key) }, h("summary", {}, "Why?"), h("p", {}, text));

// ---- plan reader: the production plan's markdown as plain text blocks (textContent only, never parsed as HTML) ----
let planShown = null;
function renderPlanReader() {
  const text = data.status?.production_plan?.text || "";
  if (text === planShown) return; // keep the reader's scroll position across polls
  planShown = text;
  const blocks = []; let list = null, para = [];
  const flush = () => { if (para.length) blocks.push(h("p", {}, para.join(" "))); para = []; };
  for (const line of text.split(/\r?\n/)) {
    const head = /^(#{1,6})\s+(.*)$/.exec(line), item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { flush(); if (!list) blocks.push(list = h("ul", {})); list.append(h("li", {}, item[1])); continue; }
    list = null;
    if (head) { flush(); blocks.push(h(head[1].length < 3 ? "h3" : "h4", {}, head[2])); }
    else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  $("plan-text").replaceChildren(...(blocks.length ? blocks : [h("p", { class: "dim" }, "No plan yet")]));
}

// ---- Details: the selected scene, then the video ----
function renderDetails() {
  if ($("details").hidden) return;
  const s = selection?.scene ? data.plan?.scenes?.find((x) => x.n === selection.scene) : null;
  $("details-scene").hidden = !s;
  if (s) renderSceneDetails($("details-scene"), s);
  renderVideoDetails($("details-video"));
}
const isCont = (s) => s.start && s.start.kind === "continue";
// stale holds the scene whose clip changed (it may sit further up the chain than start.from).
const staleNote = (s) => (s.stale && isCont(s) ? h("p", { class: "stale" }, `Scene ${typeof s.stale === "number" ? s.stale : s.start.from} changed - redo this scene`) : null);
const fact = (label, value) => value || value === 0 ? [h("dt", {}, label), h("dd", {}, value)] : [];
function renderSceneDetails(el, s) {
  const p = data.plan, c = cur();
  const x = data.status?.scenes?.find((q) => q.n === s.n) || { jobs: [] }, jobs = x.jobs || [];
  const flag = (stepState()[currentStep()]?.flags || []).find((f) => f.scene === s.n);
  // Approve and still: moved from the Storyboard view.
  const latestStoryboard = jobs.filter((job) => job.kind === "storyboard").at(-1);
  const active = jobs.some((j) => j.kind === "storyboard" && ["queued", "running", "held"].includes(j.status));
  const approve = btn(s.approved ? "Approved (undo)" : "Approve scene", () => owner("/api/scene", { ...c, n: s.n, approved: !s.approved }), true, s.approved ? "ok" : "");
  if (!s.approved && ((!isCont(s) && !s.storyboard) || active)) { approve.disabled = true; approve.title = "Generate and review the still first."; }
  const reroll = btn(s.storyboard ? "Reroll still (clears approval)" : "Make still", () => apiOk("studio_storyboard", { ...c, scenes: [s.n] }));
  if (active || data.workflow?.stages.storyboard.access !== "open") reroll.disabled = true;
  if (data.workflow?.stages.storyboard.access !== "open" && !s.approved) approve.disabled = true;
  // Keep, Cancel, Redo and takes: moved from the Generate view.
  const last = jobs.filter((j) => j.kind === "clip").slice(-1)[0];
  const redoDur = h("select", { "aria-label": `Scene ${s.n} redo duration` }, h("option", { value: "" }, "same as scene"), ...[4, 6, 8, 10].map((d) => h("option", { value: d }, d + " s")));
  const refs = s.references || [];
  el.replaceChildren(...[
    h("h2", {}, `Scene ${s.n}`, " ", h("span", { class: "tag" }, isStillScene(s) ? "still" : "clip")),
    flag ? h("p", { class: "flag" }, h("span", { "aria-hidden": "true" }, "⚑ "), h("span", { class: "sr-only" }, "Flag: "), flag.note) : null,
    staleNote(s),
    h("h3", {}, "Prompt"),
    isCont(s) ? h("p", { class: "dim" }, `Continues from scene ${s.start.from}`) : s.frame_prompt ? h("p", {}, h("span", { class: "dim" }, "Still: "), s.frame_prompt) : null,
    h("p", {}, h("span", { class: "dim" }, "Clip: "), s.prompt),
    h("h3", {}, "Settings"),
    h("dl", { class: "facts" }, fact("Duration", durationPick(s)), fact("Model", isVeo(s) ? s.model : `${s.model || "Omni 1.1 Flash"} · ${s.resolution || "720p"}`), fact("Camera", s.camera), fact("Caption", s.caption), fact("Voiceover", s.voiceover)),
    h("h3", {}, "References"),
    h("p", { class: "dim" }, "Video: ", (p.references || []).length ? p.references.map((r) => r.split(/[\\/]/).pop()).join(", ") : "none"),
    ...refs.map((path) => h("div", { class: "row" },
      h("span", {}, path.split(/[\\/]/).pop()),
      btn(`Remove scene ${s.n} reference ${path.split(/[\\/]/).pop()}`, () => savePlan((pl) => {
        pl.scenes.find((y) => y.n === s.n).references = (pl.scenes.find((y) => y.n === s.n).references || []).filter((r) => r !== path);
      }, c)))),
    picker("Add reference", async (f) => {
      const r = await apiOk("studio_add_reference", { ...c, path: await upload(f) });
      await savePlan((pl) => { const sc = pl.scenes.find((y) => y.n === s.n); sc.references = [...new Set([...(sc.references || []), r.path])]; }, c);
    }),
    h("h3", {}, "Status"),
    h("p", {}, h("span", { class: "tag" }, last ? last.status : s.clip ? "has clip" : s.approved ? "approved" : "not approved"), last && last.credits != null ? h("small", {}, ` ${last.credits} credits`) : null),
    active ? h("p", { role: "status" }, "Making still…") : null,
    latestStoryboard?.error ? h("p", { class: "err", role: "alert" }, latestStoryboard.error) : null,
    last && last.note ? h("p", { class: "dim" }, last.note) : null, last && last.error ? h("p", { class: "err" }, last.error) : null,
    h("div", { class: "row" }, isCont(s) ? null : reroll, approve,
      isCont(s) ? why("approve-cont", `A continuing scene starts on the last frame of scene ${s.start.from}, so it has no still; approving it approves its clip prompt.`)
        : approve.disabled && !s.approved ? why("approve-still", "Approve needs a still. Make the still and review it first.") : null),
    h("div", { class: "row" },
      s.clip ? btn(s.kept ? "Kept (undo)" : "Keep", () => owner("/api/scene", { ...c, n: s.n, kept: !s.kept }), true, s.kept ? "ok" : "") : null,
      last && (last.status === "held" || last.status === "queued") ? btn("Cancel", () => cancelJob(last.id), true) : null,
      redoDur,
      btn("Redo", async () => {
        const change = prompt(`Redo scene ${s.n}: what should change? (optional)`);
        if (change === null) return;
        const result = await apiOk("studio_redo", { ...c, scene: s.n, ...(change.trim() ? { prompt: change.trim() } : {}), ...(redoDur.value ? { duration: Number(redoDur.value) } : {}) });
        if (result.already_queued?.length) toast("This scene already has an active job. Finish or cancel it before changing the redo request.");
      })),
    x.takes?.length ? h("details", { class: "takes", ...keepOpen("takes:" + c.project + "/" + c.sub + "/" + s.n) }, h("summary", {}, `Takes (${x.takes.length})`),
      why("takes", "Using an earlier take clears Keep on this scene and marks scenes that continue from it stale; they need a redo."),
      ...x.takes.map((take, index) => {
        const use = btn(take.clip === s.clip ? "Current take" : "Use this take", async () => {
          await owner("/api/take", { ...c, scene: s.n, clip: take.clip });
          toast("Take restored. Review and Keep it again; continuing scenes may need a redo.");
        }, true);
        if (take.clip === s.clip || x.jobs.some((j) => ["held", "queued", "running"].includes(j.status))) use.disabled = true;
        return h("div", { class: "take" }, h("p", {}, `Take ${index + 1}${take.createdAt ? " - " + new Date(take.createdAt).toLocaleString() : ""}`),
          h("video", { src: media(take.clip), controls: true, preload: "none" }), h("div", { class: "row" }, btn(`Show take ${index + 1}`, () => selectContextItem({ kind: "take", scene: s.n, takeIndex: index + 1 })), use));
      })) : null].filter((k) => k != null));
}

// ---- Video section: steps (with the owner's Reopen), plan, notes, references, scenes, edit ----
// Reopen asks once inline; the confirm is bound to the video and step it was drawn for.
let reopenAsk = "", reopenPending = false, reopenError = "";
function stepList() {
  const scope = currentScope(), mine = data.statusScope === scope, off = !OWNER || !dataFresh || reopenPending;
  const button = (label, onclick, attrs = {}) => { const b = h("button", { type: "button", ...attrs }, label); b.onclick = onclick; return b; };
  const items = STEPS.map((n) => {
    const x = mine ? stepState()[n] : null, status = x?.status || "idle", asking = reopenAsk === scope + "/" + n;
    const actions = status !== "approved" ? [] : asking
      ? [h("span", { class: "ask" }, `Reopen ${stepLabel(n)}?`), button("Confirm", () => reopenStep(n, scope), { "data-write": "1", "data-confirm": n, disabled: off }), button("Cancel", () => { reopenAsk = ""; renderDetails(); $("details").querySelector(`[data-reopen="${n}"]`)?.focus(); })]
      : [button("Reopen", () => { reopenAsk = scope + "/" + n; reopenError = ""; renderDetails(); $("details").querySelector(`[data-confirm="${n}"]`)?.focus(); }, { "data-write": "1", "data-reopen": n, disabled: off })];
    // The run log (plain text from /api/step-log); a step that never left idle has none.
    const log = mine && status !== "idle" ? h("a", { href: `/api/step-log?token=${encodeURIComponent(TOKEN)}&project=${encodeURIComponent(cur().project)}&sub=${encodeURIComponent(cur().sub)}&step=${n}`, target: "_blank", rel: "noopener", class: "step-log" }, "Log", h("span", { class: "sr-only" }, ` for ${stepLabel(n)}`)) : null;
    return h("li", { "data-step": n, "data-status": status }, h("div", { class: "row" }, h("b", {}, stepLabel(n)), h("span", { class: "dim" }, STEP_WORD[status] || status), log, ...actions),
      status === "blocked" && x.blockedReason ? h("p", { class: "dim" }, x.blockedReason) : null,
      x?.summary ? h("p", { class: "dim step-summary" }, x.summary) : null);
  });
  return [h("ol", { class: "step-list" }, items), approvedAny() ? why("reopen", "Reopening a step cancels this video's waiting jobs and sends it and every later step back to not started. Nothing on disk is removed.") : null,
    reopenError ? h("p", { class: "err", role: "alert" }, reopenError) : null];
}
const approvedAny = () => STEPS.some((n) => stepState()[n]?.status === "approved");
async function reopenStep(step, scope) {
  if (reopenPending || reopenAsk !== scope + "/" + step) return;
  reopenAsk = "";
  if (currentScope() !== scope || data.statusScope !== scope || stepState()[step]?.status !== "approved") { reopenError = "Video changed. Review again."; renderDetails(); return; }
  const [project, sub] = [cur().project, cur().sub];
  reopenPending = true; reopenError = ""; renderDetails();
  try { await owner("/api/step", { project, sub, step, action: "reopen" }); }
  catch (e) { if (currentScope() === scope) reopenError = String(e.message || e); }
  finally { reopenPending = false; refresh(true); }
}
const lessonText = {};
async function setAdReference(path, selected, scope = cur()) {
  const target = { ...scope };
  const refs = await apiOk("studio_references", target);
  await savePlan(plan => {
    const active = plan.references ?? refs.active ?? [];
    plan.references = selected ? [...new Set([...active, path])] : active.filter(r => r !== path);
    if (!selected) for (const scene of plan.scenes) scene.references = (scene.references || []).filter(r => r !== path);
  }, target);
}
function referenceFigure(path, scope, selected) {
  const name = path.split(/[\\/]/).pop();
  const action = btn(selected ? `Remove ${name} from this video` : `Use ${name} for this video`, () => setAdReference(path, !selected, scope));
  return h("figure", {}, h("img", { src: media(path), alt: name }), h("figcaption", {}, name), action);
}
function renderVideoDetails(el) {
  const p = data.plan, c = cur();
  const read = h("button", { type: "button", "aria-controls": "plan-reader", "aria-expanded": "false" }, "Read plan");
  read.onclick = () => setDrawer("plan-reader", read);
  const kids = [h("h2", {}, "Video"), h("h3", {}, "Steps"), ...stepList(), h("div", { class: "row" }, read)];
  if (!have()) return el.replaceChildren(...kids.filter((k) => k != null));
  if (data.guide?.text) {
    const stage = view;
    kids.push(h("details", { class: "creative-guide", open: expandedGuides.has(stage), ontoggle: e => { if (!e.target.isConnected) return; if (e.target.open) expandedGuides.add(stage); else expandedGuides.delete(stage); } },
      h("summary", {}, "Creative basis: your Google Flow prompt guide"),
      h("p", { class: "dim" }, `${data.guide.source} · revision ${data.guide.revision}`),
      h("h3", {}, "How it applies in Studio"),
      h("ul", {}, data.guide.adaptations.map(text => h("li", {}, text))),
      h("h3", {}, "Your original guidance for this stage"),
      h("pre", { style: "white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.6" }, data.guide.text)));
  }
  if (p) {
    // Ideas: Claude writes the options, the owner picks one in chat; read-only here.
    const opts = p.options || [];
    if (opts.length) kids.push(h("details", { class: "ideas", ...keepOpen("ideas") }, h("summary", {}, `Ideas (${opts.length})`),
      why("ideas", p.chosen ? "Chosen in chat. To change it, tell the agent which option to go with." : "Tell the agent in chat which option to go with (e.g. \"go with option 2\")."),
      h("div", { class: "grid" }, opts.map((o, i) => h("div", { class: "card" + (o.id === p.chosen ? " chosen" : "") },
        h("b", {}, `${i + 1}. ${o.title}`), o.id === p.chosen ? h("span", { class: "tag" }, " chosen") : null,
        h("p", {}, h("i", {}, o.hook)), h("p", {}, o.story), h("small", { class: "dim" }, `${o.scenes} scene${o.scenes === 1 ? "" : "s"}`))))));
    // Plan settings, notes and video references: moved from the Plan view.
    const asp = h("select", { "aria-label": "Plan aspect" }, ...["9:16", "16:9"].map((v) => h("option", { value: v, selected: v === p.aspect }, v)));
    asp.onchange = () => savePlan((pl) => (pl.aspect = asp.value), c).then(() => refresh(true), (e) => toast(e.message));
    const sty = h("select", { "aria-label": "Style" }, ...[["", "none"], ["A", "A"], ["B", "B"]].map(([v, t]) => h("option", { value: v, selected: v === (p.style || "") }, "Style " + t)));
    sty.onchange = () => savePlan((pl) => { if (sty.value) pl.style = sty.value; else delete pl.style; }, c).then(() => refresh(true), (e) => toast(e.message));
    const [notesBox, lostBox] = notes.box(c, "6", "Notes for this sub-project (saved automatically)");
    kids.push(h("div", { class: "row" }, asp, sty),
      h("h3", {}, "Notes"), notesBox, lostBox,
      h("h3", {}, "References"),
      why("refs", "Video references apply to every scene. Removing one clears scene approval and keeps earlier media and library files."),
      picker("Add video reference", async (f) => { const r = await apiOk("studio_add_reference", { ...c, path: await upload(f) }); await setAdReference(r.path, true, c); }),
      (data.activeRefs || []).length ? h("div", { class: "refs" }, data.activeRefs.map(path => referenceFigure(path, c, true))) : h("p", { class: "dim" }, "None"),
      h("details", keepOpen("library"), h("summary", {}, `Reference library (${(data.libraryRefs || []).length} unused for this video)`),
        why("library", "Stored images are available to reuse. They are not automatically included in this video."),
        h("div", { class: "refs" }, (data.libraryRefs || []).map(path => referenceFigure(path, c, false)))));
    if (p.lessons && p.lessons.length) kids.push(h("details", keepOpen("lessons"), h("summary", {}, `Lessons (${p.lessons.length})`), h("ul", {}, p.lessons.map((l) => h("li", {}, `[${l.scope}] ${l.text}`)))));
    // Stills and clips for every scene: moved from the Storyboard and Generate views.
    const missing = p.scenes.filter((s) => !isCont(s) && !s.storyboard).map((s) => s.n);
    const make = btn("Make missing stills (free)", () => apiOk("studio_storyboard", { ...c, scenes: missing }));
    if (!missing.length || data.workflow?.stages.storyboard.access !== "open") make.disabled = true;
    const dur = h("select", { "aria-label": "Duration" }, h("option", { value: "" }, "Per scene"), ...[4, 6, 8, 10].map((d) => h("option", { value: d }, d + " s")));
    const res = h("select", { "aria-label": "Resolution" }, h("option", { value: "" }, "Per scene"), h("option", { value: "360p" }, "360p"), h("option", { value: "720p" }, "720p"));
    kids.push(h("h3", {}, "Scenes"), h("div", { class: "row" }, make), h("div", { class: "row" }, dur, res, btn("Queue approved scenes (held)", async () => {
      if (data.workflow?.stages.generate.access !== "open") throw new Error(data.workflow?.stages.generate.reason || "Review and approve scenes first.");
      const result = await apiOk("studio_generate", { ...c, ...(dur.value ? { duration: Number(dur.value) } : {}), ...(res.value ? { resolution: res.value } : {}) });
      toast(`${result.held} clip(s) queued for approval.` + (result.already_queued?.length ? ` Already queued: scenes ${result.already_queued.join(", ")}.` : ""));
    }), why("queue", "Queued clips are held: nothing is spent until you approve their credits under Jobs.")));
    // Approved batches still waiting their turn: one button stops what has not started (a running clip finishes).
    const queued = {};
    for (const x of data.status?.scenes || []) for (const j of x.jobs || []) if (j.status === "queued") (queued[j.batch || j.id] ||= []).push(j.id);
    for (const ids of Object.values(queued))
      kids.push(h("div", { class: "row" }, btn(`Stop remaining (${ids.length} queued)`, async () => { for (const id of ids) await cancelJob(id); }, true)));
  }
  kids.push(...editSection());
  el.replaceChildren(...kids.filter((k) => k != null));
}

// ---- Generate helpers (held jobs live under Jobs in the project menu) ----
const credits = (g) => (g.cost_unknown ? "credits unknown" : `up to ${g.max_credits} credits`);
const cancelJob = (id) => owner("/api/cancel-job", { id });
// One approval card: what will be made (scene, prompt, first frame) before the owner pays for it. Prompts are
// untrusted text, so they only ever go in as text nodes (h() appends strings as text).
// The job a continue clip waits for: held ones come from /api/pending, the rest from studio_status (with its status).
function sourceJob(id) {
  for (const g of [...data.pending, ...data.other]) for (const j of g.jobs) if (j.id === id) return { status: j.status, batch: j.batch };
  for (const x of (data.status && data.status.scenes) || []) for (const j of x.jobs) if (j.id === id) return j;
  return null;
}
function heldCard(g) {
  const n = g.jobs.length;
  const items = g.jobs.map((j) => {
    const st = j.params.studio;
    // A continue clip's first frame does not exist yet: it is cut from its source clip's end just before it runs.
    const chained = j.params.chain_from || j.params.chain_file;
    const src = st && st.from ? "scene " + st.from : "the previous scene";
    const from = j.params.chain_from && sourceJob(j.params.chain_from);
    const thumb = chained
      ? h("p", { class: "dim" }, j.params.chain_file || (from && from.status === "done") ? `First frame: last frame of ${src}'s finished clip.`
        : `First frame: last frame of ${src} (not visible until it finishes).` + (from && from.status === "held" && from.batch !== g.batch ? ` Waits for ${src}'s clip in another batch, which also needs approval.` : ""))
      : j.params.first_frame && !j.params.first_frame.startsWith("asset:") ? h("img", { src: media(j.params.first_frame), alt: "First frame" + (st ? ", scene " + st.scene : "") }) : null;
    return h("div", { class: "card" }, h("b", {}, st ? `Scene ${st.scene}` : j.params.file_stem || j.id), thumb,
      h("small", {}, [j.params.model || "Flow's current model", j.params.duration ? j.params.duration + " s" : "", j.params.resolution || ""].filter(Boolean).join(" · ")),
      h("small", { class: "dim" }, [st ? ` · ${st.project}/${st.sub}` : "", j.params.edit_asset || j.params.continue_from ? "" : ` · cap ${j.params.max_credits} credits`].join("")),
      h("p", {}, j.params.prompt || ""));
  });
  const where = [...new Set(g.jobs.map((j) => (j.params.studio ? j.params.studio.project + "/" + j.params.studio.sub : "not a studio job")))].join(", ");
  return h("div", { class: "held" },
    h("b", {}, "Project: " + where),
    btn(`Approve ${n} clip${n === 1 ? "" : "s"} · ${credits(g)}`, () => owner("/api/approve", g.batch ? { batch: g.batch } : { job_id: g.jobs[0].id }), true, "big"),
    " ", btn("Cancel", async () => { for (const j of g.jobs) await cancelJob(j.id); }, true),
    h("div", { class: "grid" }, items));
}

// ---- Edit: Claude edits the whole video in Remotion; this section collects the extras and lists the renders ----
const editFiles = new Map();
const taskActive = (task) => !!task && !["finished", "failed"].includes(task.phase);
let renderSel = null; // { count, v }: the owner's pick, forgotten when a new render arrives
function editSection() {
  const p = data.plan, c = cur(), renders = data.renders || [];
  const kept = (p ? p.scenes : []).filter((s) => s.kept && s.clip);
  const label = `${c.project}/${c.sub}`, task = data.editTask;
  const stale = kept.filter((s) => s.stale !== undefined);
  if (!editFiles.has(label)) editFiles.set(label, {});
  const files = editFiles.get(label);
  const [box, lostBox] = editNotes.box(c, "4", "What else do you want in the video, or what should change? (saved automatically)");
  const go = btn(renders.length ? "Revise" : "Edit video", async () => {
    const targetSession = agentSession;
    const frozenContext = getUiContext();
    if (inputMode !== "message" || !$("message-ready").checked) throw new Error("Choose Message mode and confirm the agent is ready before starting an edit.");
    await editNotes.flush(label);
    if (editNotes.conflict[label] !== undefined) throw new Error("Your edit notes did not save. Review the preserved draft before editing.");
    if (!termUp() || targetSession !== agentSession || cur().project + "/" + cur().sub !== label) throw new Error("Project or agent session changed. Review the selection and submit again.");
    const started = await owner("/api/edit-task/start", c);
    if (!termUp() || targetSession !== agentSession) {
      await owner("/api/edit-task/stop", { ...c, task_id: started.task.id });
      throw new Error("Agent session changed before instructions were sent. Submit again when ready.");
    }
    go.dataset.locked = "1"; data.editTask = started.task;
    const instruction = renders.length
      ? `Revise the video for ${label} using my latest edit notes (studio_edit_notes_read); render a new version to my-video/out/${c.project}/${c.sub}/ as the next free v<N>.mp4 and call studio_render_done with it.`
      : `Edit the full video for ${label}: run studio_to_remotion (music/voiceover if chosen), use the staticFile paths it returns, and build a NEW composition following the plan, my edit notes and style ${p?.style || "A or B (choose the fitting style)"}. Render to my-video/out/${c.project}/${c.sub}/v<N>.mp4 and call studio_render_done with it.`;
    try {
      await typeToAgent(instruction + (files.music ? ` Music file: "${files.music}".` : "") + (files.voiceover ? ` Voiceover file: "${files.voiceover}".` : "")
        + ` Editing task ID: ${started.task.id}. First call studio_edit_task_update with this task_id, project ${c.project}, sub ${c.sub}, phase accepted. Report editing and rendering when starting those phases; if blocked report failed with a useful message. Finish by calling studio_render_done with the same task_id and the actual render file. Never report finished without registering the render.`, frozenContext);
    } catch (e) {
      if (e.delivery !== "uncertain") { await owner("/api/edit-task/stop", { ...c, task_id: started.task.id }); go.dataset.locked = ""; }
      throw e;
    }

  }, true, "big");
  if (!termUp() || !kept.length || stale.length || taskActive(task) || data.workflow?.stages.edit.access !== undefined && data.workflow.stages.edit.access !== "open") { go.disabled = true; go.title = taskActive(task) ? "An edit task is already active" : data.workflow?.stages.edit.reason || (stale.length ? "Redo stale kept scenes before editing" : !termUp() ? "Start or reconnect the agent in Chat" : "Keep at least one clip first"); }
  const sel = renderSel && renderSel.key === label && renderSel.count === renders.length ? renderSel.v : renders.length ? renders[renders.length - 1].version : null;
  const shown = renders.find((r) => r.version === sel);
  if (view === "edit" && shown && (!selection || selection.kind === "render" && selection.version !== shown.version)) {
    selection = { kind: "render", version: shown.version }; publishContextSoon();
  }
  return [h("h3", {}, "Edit"),
    task ? h("section", { class: "edit-task", "aria-label": "Editing task status" }, h("b", {}, `Edit task: ${task.phase}`),
      h("p", { role: "status" }, task.message),
      task.phase === "sent" ? why("task-sent", "Waiting for the agent to acknowledge. Complete sign-in or trust prompts in the terminal if needed.") : null,
      taskActive(task) ? btn("Mark task stopped (does not stop agent)", () => owner("/api/edit-task/stop", { ...c, task_id: task.id }), true) : null) : null,
    stale.length ? h("p", { class: "err" }, `Redo stale kept scenes ${stale.map((s) => s.n).join(", ")} before editing.`) : null,
    h("h4", {}, "Edit notes"), box, lostBox,
    h("div", { class: "row" }, go, go.disabled && go.title ? why("edit-go", go.title) : null, renders.length ? btn("Start new video", startNewAd) : null),
    h("div", { class: "edit-audio" }, picker("Music", async (f) => (files.music = await upload(f)), "audio/*"), picker("Voiceover", async (f) => (files.voiceover = await upload(f)), "audio/*")),
    files.music ? h("p", { class: "dim" }, "Music: " + files.music.split(/[\\/]/).pop()) : null,
    files.voiceover ? h("p", { class: "dim" }, "Voiceover: " + files.voiceover.split(/[\\/]/).pop()) : null,
    h("h4", {}, "Renders"),
    renders.length ? h("div", { class: "row renders" }, renders.map((r) => btn(`v${r.version}`, () => { renderSel = { key: label, count: renders.length, v: r.version }; selectContextItem({ kind: "render", version: r.version }); }, false, r.version === sel ? "ok" : "")))
      : h("p", { class: "dim" }, "None"),
    h("details", { class: "edit-clips", ...keepOpen("kept-clips") }, h("summary", {}, `Kept clips (${kept.length})`),
      kept.length ? h("div", { class: "thumbs" }, kept.map((s) => h("figure", {}, h("video", { src: media(s.clip), muted: true, preload: "metadata" }), h("figcaption", {}, `Scene ${s.n}`))))
        : h("p", { class: "dim" }, "None"))];
}

refresh(true);
