// Plain JS, no build step. The server writes the tokens into data attributes on <body> (no inline script, for the CSP).
const TOKEN = document.body.dataset.token;
// The one-shot UI token is only given on the first load. Keep it in this tab's sessionStorage so F5 does not lock the owner out.
let UI_TOKEN = document.body.dataset.ui || "";
try { if (UI_TOKEN) sessionStorage.setItem("flowUi", UI_TOKEN); else UI_TOKEN = sessionStorage.getItem("flowUi") || ""; } catch { /* no storage: reload shows the banner */ }
addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });
const $ = (id) => document.getElementById(id);
const api = (method, body = {}) =>
  fetch("/api/" + method, { method: "POST", headers: { "x-flow-token": TOKEN }, body: JSON.stringify(body) }).then((r) => r.json());

// ---- terminal ----
const term = new Terminal({ fontSize: 14, cursorBlink: true, theme: { background: "#000000" } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("term"));
let ws;
const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
let retry = 0;
function connect() {
  if (!UI_TOKEN || (ws && ws.readyState <= 1)) return;
  ws = new WebSocket(`ws://${location.host}/pty?ui=${encodeURIComponent(UI_TOKEN)}`);
  ws.onopen = () => { retry = 0; term.reset(); /* the server replays its scrollback */ fit.fit(); send({ t: "r", cols: term.cols, rows: term.rows }); };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => {
    if (retry >= 6) return void term.write("\r\n[disconnected - press Restart to retry]\r\n");
    term.write("\r\n[disconnected - reconnecting]\r\n");
    setTimeout(connect, [1000, 2000, 5000, 10000][Math.min(retry++, 3)]);
  };
}
term.onData((d) => send({ t: "i", d }));
term.onResize(({ cols, rows }) => send({ t: "r", cols, rows }));
$("restart").onclick = () => {
  retry = 0;
  term.reset();
  if (ws && ws.readyState === 1) send({ t: "restart" });
  else connect(); // a fresh connection spawns claude if none is running
};
addEventListener("resize", () => fit.fit());
fit.fit();
if (UI_TOKEN) connect();
else term.write("This window has no session token. Close it and reopen Flow Studio.\r\n");

// ---- resizable split ----
$("split").onpointerdown = (e) => {
  $("split").setPointerCapture(e.pointerId);
  $("split").onpointermove = (m) => { $("term-wrap").style.width = Math.max(260, m.clientX) + "px"; fit.fit(); };
  $("split").onpointerup = () => { $("split").onpointermove = null; };
};

// ---- tabs ----
for (const b of document.querySelectorAll("#tabs button")) {
  b.onclick = () => {
    for (const o of document.querySelectorAll("#tabs button")) o.setAttribute("aria-selected", String(o === b));
    for (const s of document.querySelectorAll("#views section")) s.hidden = s.id !== "view-" + b.dataset.view;
    view = b.dataset.view;
    refresh(true);
  };
}

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
$("project").onchange = () => { fillSubs(); refresh(true); };
$("sub").onchange = () => refresh(true);
loadProjects();

// ---- health banner: /api/health/flow lists the Flow checks that failed (textContent only) ----
fetch("/api/health/flow", { headers: { "x-flow-token": TOKEN } }).then((r) => (r.ok ? r.json() : null)).then((h) => {
  if (h && h.ok === false && h.message) { $("health").textContent = "Flow check: " + h.message; $("health").hidden = false; }
}).catch(() => {});

// ======== step views ========
// Plan text is written by Claude: every string goes in through textContent, never innerHTML.
const OWNER = !!UI_TOKEN;
if (!OWNER) $("reloaded").hidden = false;
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
  const b = h("button", { type: "button", class: cls }, label);
  b.onclick = async () => {
    b.disabled = true;
    try { await onclick(); } catch (e) { toast(String(e.message || e)); }
    b.disabled = owner && !OWNER;
    refresh(true);
  };
  if (owner && !OWNER) { b.disabled = true; b.title = "This window was reloaded and cannot approve credits."; }
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
  const r = await (await fetch(path, { method: "POST", headers: { "x-ui-token": UI_TOKEN, "x-flow-token": TOKEN }, body: JSON.stringify(body) })).json();
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
  if (isVeo(s)) return h("span", {}, "8 s · fixed"); // Flow fixes Veo clips at 8 s
  const sel = h("select", { "aria-label": `Scene ${s.n} duration` }, ...[4, 6, 8, 10].map((d) => h("option", { value: d, selected: d === (s.duration || 8) }, d + " s")));
  sel.onchange = () => savePlan((pl) => { pl.scenes.find((x) => x.n === s.n).duration = Number(sel.value); }).then(() => refresh(true), (e) => { toast(e.message); refresh(true); });
  return sel;
}
async function savePlan(mut) {
  const { lessons, note, ...plan } = await apiOk("studio_plan_read", cur());
  mut(plan);
  // rev: refused if the plan changed between this read and the write. approved/kept/storyboard/clip are ignored here.
  await apiOk("studio_plan_write", { ...cur(), rev: plan.rev ?? 0, plan });
}
const slug = (s) => s.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");

let view = "plan";
let data = { plan: null, pending: [], other: [], status: null, lessons: [], notes: null };
let sig = "";
// Notes: the page re-reads them on every poll unless the box has focus or a save is pending (then local text wins).
const notesText = {}, notesRev = {}, notesConflict = {};
let notesTimer = null, notesSaving = false;
const notesKey = () => cur().project + "/" + cur().sub;
let reported = "";
async function fetchData() {
  // Tell the engine (and so Claude) which project/sub the owner has selected.
  if (have() && reported !== notesKey()) { reported = notesKey(); api("studio_select", cur()).catch(() => { reported = ""; }); }
  const get = (p) => fetch(p, { headers: { "x-flow-token": TOKEN } }).then((r) => r.json());
  const pendingAll = await get("/api/pending");
  const groups = Array.isArray(pendingAll) ? pendingAll : [];
  if (!have()) { data = { plan: null, pending: [], other: groups, status: null, lessons: [], notes: null }; return; }
  const plan = await api("studio_plan_read", cur());
  data.plan = plan.error ? null : plan;
  const mine = (g) => g.jobs.some((j) => j.params.studio && j.params.studio.project === plan.project && j.params.studio.sub === plan.sub);
  data.pending = groups.filter(mine);
  data.other = groups.filter((g) => !mine(g)); // non-studio jobs and other sub-projects: still approvable/cancellable here
  if (view === "plan" && data.plan) {
    const key = notesKey();
    if (!notesTimer && !notesSaving && document.activeElement?.id !== "notes") {
      const r = await api("studio_notes_read", cur());
      if (r && typeof r.text === "string") { notesText[key] = r.text; notesRev[key] = r.rev; }
    }
    data.notes = notesText[key] ?? null;
    const refs = await api("studio_references", cur());
    data.refs = refs && !refs.error ? [...refs.project, ...refs.sub] : [];
  }
  if (view === "generate") {
    const [st, ls] = await Promise.all([api("studio_status", cur()), get("/api/lessons")]);
    data.status = st.error ? null : st;
    data.lessons = ls.pending || [];
  }
}
const editing = () => { const a = document.activeElement; return !!a && $("views").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== "file"; };
let busy = false, again = false;
async function refresh(force) {
  if (busy) { if (force) again = true; return; }
  if (!force && (document.visibilityState !== "visible" || editing())) return;
  busy = true;
  try {
    await fetchData();
    const s = view + JSON.stringify(data);
    if (force || s !== sig) { sig = s; render(); }
  } catch { /* server hiccup: keep what is shown */ }
  busy = false;
  if (again) { again = false; refresh(true); }
}
// Cheap local polling, only while the window is visible.
setInterval(() => { if (document.visibilityState === "visible") { refresh(false); accounts(); } }, 4000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh(true));

function render() {
  const el = $("view-" + view);
  if (view === "edit") return renderEdit(el);
  if (!have() && view !== "plan" && view !== "generate") return el.replaceChildren(h("p", {}, "Pick or create a project first (Plan tab)."));
  ({ plan: renderPlan, storyboard: renderBoard, generate: renderGen })[view](el);
}

// ---- Plan ----
const lessonText = {};
async function saveNotes(key, c) {
  notesTimer = null;
  notesSaving = true;
  const text = notesText[key];
  try {
    const r = await apiOk("studio_notes_write", { ...c, text, rev: notesRev[key] });
    notesRev[key] = r.rev;
  } catch (e) {
    // Someone (Claude) changed the notes since this page read them: keep the typed text visible, reload theirs.
    notesConflict[key] = text;
    delete notesText[key];
    toast(String(e.message || e) + " Your unsaved text is shown under Notes.");
  } finally {
    notesSaving = false;
    refresh(true);
  }
}
function renderPlan(el) {
  const p = data.plan, c = cur();
  const np = h("input", { placeholder: "Project", "aria-label": "New project" }), ns = h("input", { placeholder: "Sub-project", "aria-label": "New sub-project" });
  const na = h("select", { "aria-label": "Aspect" }, h("option", { value: "9:16" }, "9:16"), h("option", { value: "16:9" }, "16:9"));
  const kids = [h("h3", {}, "New project / sub-project"), h("div", { class: "row" }, np, ns, na, btn("New", async () => {
    await apiOk("studio_new", { project: np.value, sub: ns.value, aspect: na.value });
    await loadProjects();
    $("project").value = slug(np.value);
    fillSubs();
    $("sub").value = slug(ns.value);
  }))];
  if (p) {
    const asp = h("select", { "aria-label": "Plan aspect" }, ...["9:16", "16:9"].map((v) => h("option", { value: v, selected: v === p.aspect }, v)));
    asp.onchange = () => savePlan((pl) => (pl.aspect = asp.value)).then(() => refresh(true), (e) => toast(e.message));
    const sty = h("select", { "aria-label": "Style" }, ...[["", "none"], ["A", "A"], ["B", "B"]].map(([v, t]) => h("option", { value: v, selected: v === (p.style || "") }, "Style " + t)));
    sty.onchange = () => savePlan((pl) => { if (sty.value) pl.style = sty.value; else delete pl.style; }).then(() => refresh(true), (e) => toast(e.message));
    const rows = p.scenes.map((s) => h("tr", {},
      h("td", {}, String(s.n)), h("td", {}, s.prompt), h("td", {}, s.camera || ""), h("td", {}, durationPick(s)), h("td", {}, isVeo(s) ? s.model : `${s.model || "Omni 1.1 Flash"} · ${s.resolution || "720p"}`), h("td", {}, s.caption || ""), h("td", {}, s.voiceover || ""),
      h("td", {}, picker("+ ref", async (f) => {
        const r = await apiOk("studio_add_reference", { ...c, path: await upload(f) });
        await savePlan((pl) => { const sc = pl.scenes.find((x) => x.n === s.n); sc.references = [...(sc.references || []), r.path]; });
      }), h("small", {}, (s.references || []).length ? ` ${s.references.length} ref` : ""))));
    const notes = h("textarea", { id: "notes", rows: "6", "aria-label": "Notes", placeholder: "Notes for this sub-project (saved automatically)" });
    const key = notesKey();
    notes.value = notesText[key] ?? "";
    notes.disabled = !(key in notesText); // never autosave before the saved notes have loaded (the next poll loads them)
    notes.oninput = () => {
      if (!(key in notesText)) return;
      notesText[key] = notes.value;
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => saveNotes(key, c), 800);
    };
    const lost = notesConflict[key];
    const lostBox = lost === undefined ? null : h("div", { class: "lesson" },
      h("b", {}, "Your unsaved notes (copy what you need, then dismiss):"),
      (() => { const t = h("textarea", { rows: "4", readonly: true, "aria-label": "Unsaved notes" }); t.value = lost; return t; })(),
      btn("Dismiss", () => { delete notesConflict[key]; }));
    kids.push(h("h3", {}, `${p.project} / ${p.sub}`), h("div", { class: "row" }, asp, sty),
      p.scenes.length ? h("table", {}, h("thead", {}, h("tr", {}, ...["#", "Prompt", "Camera", "Duration", "Model · res", "Caption", "Voiceover", "References"].map((t) => h("th", {}, t)))), h("tbody", {}, rows)) : h("p", {}, "No scenes yet. Ask Claude to write the plan."),
      h("h3", {}, "Notes"), notes, lostBox,
      h("h3", {}, "Reference images"), picker("Add project reference", async (f) => { await apiOk("studio_add_reference", { project: c.project, path: await upload(f) }); }),
      h("div", { class: "refs" }, (data.refs || []).map((r) => { const name = r.split(/[\\/]/).pop(); return h("figure", {}, h("img", { src: media(r), alt: name }), h("figcaption", {}, name)); })));
    if (p.lessons && p.lessons.length) kids.push(h("details", {}, h("summary", {}, `Lessons (${p.lessons.length})`), h("ul", {}, p.lessons.map((l) => h("li", {}, `[${l.scope}] ${l.text}`)))));
  }
  el.replaceChildren(...kids);
}

// ---- Storyboard ----
function renderBoard(el) {
  const p = data.plan, c = cur();
  if (!p) return el.replaceChildren(h("p", {}, "No plan yet."));
  const cards = p.scenes.map((s) => h("div", { class: "card" },
    h("b", {}, `Scene ${s.n}`),
    s.storyboard ? h("img", { src: media(s.storyboard), alt: "Storyboard still, scene " + s.n }) : h("div", { class: "empty" }, "no still yet"),
    h("p", {}, s.prompt),
    h("div", { class: "row" },
      btn("Reroll (free)", () => apiOk("studio_storyboard", { ...c, scenes: [s.n] })),
      btn(s.approved ? "Approved (undo)" : "Approve scene", () => owner("/api/scene", { ...c, n: s.n, approved: !s.approved }), true, s.approved ? "ok" : ""))));
  el.replaceChildren(h("div", { class: "row" }, btn("Make all stills (free)", () => apiOk("studio_storyboard", c))), h("div", { class: "grid" }, cards));
}

// ---- Generate ----
const credits = (g) => (g.cost_unknown ? "credits unknown" : `up to ${g.max_credits} credits`);
const cancelJob = (id) => owner("/api/cancel-job", { id });
// One approval card: what will be made (scene, prompt, first frame) before the owner pays for it. Prompts are
// untrusted text, so they only ever go in as text nodes (h() appends strings as text).
function heldCard(g) {
  const n = g.jobs.length;
  const items = g.jobs.map((j) => {
    const st = j.params.studio;
    const thumb = j.params.first_frame && !j.params.first_frame.startsWith("asset:") ? h("img", { src: media(j.params.first_frame), alt: "First frame" + (st ? ", scene " + st.scene : "") }) : null;
    return h("div", { class: "card" }, h("b", {}, st ? `Scene ${st.scene}` : j.params.file_stem || j.id), thumb, h("small", {}, [j.params.model || "Flow's current model", j.params.duration ? j.params.duration + " s" : "", j.params.resolution || ""].filter(Boolean).join(" · ")), h("p", {}, j.params.prompt || ""));
  });
  return h("div", { class: "held" },
    btn(`Approve ${n} clip${n === 1 ? "" : "s"} · ${credits(g)}`, () => owner("/api/approve", g.batch ? { batch: g.batch } : { job_id: g.jobs[0].id }), true, "big"),
    " ", btn("Cancel", async () => { for (const j of g.jobs) await cancelJob(j.id); }, true),
    h("div", { class: "grid" }, items));
}
function renderGen(el) {
  const p = data.plan, c = cur();
  const other = data.other.length ? [h("h3", {}, "Other held jobs"), ...data.other.map(heldCard)] : [];
  if (!p) return el.replaceChildren(h("p", {}, "No plan yet."), ...other);
  const dur = h("select", { "aria-label": "Duration" }, h("option", { value: "" }, "Per scene"), ...[4, 6, 8, 10].map((d) => h("option", { value: d }, d + " s")));
  const res = h("select", { "aria-label": "Resolution" }, h("option", { value: "" }, "Per scene"), h("option", { value: "360p" }, "360p"), h("option", { value: "720p" }, "720p"));
  const kids = [h("div", { class: "row" }, dur, res, btn("Queue approved scenes (held)", () => apiOk("studio_generate", { ...c, ...(dur.value ? { duration: Number(dur.value) } : {}), ...(res.value ? { resolution: res.value } : {}) })))];
  for (const l of data.lessons) {
    const txt = h("input", { value: lessonText[l.id] ?? l.text, "aria-label": "Lesson text" });
    txt.oninput = () => (lessonText[l.id] = txt.value);
    kids.push(h("div", { class: "lesson" }, h("b", {}, "Learned: "), txt, h("small", {}, ` [${l.scope}] `),
      btn("Save", () => owner("/api/lessons/resolve", { id: l.id, action: "save", editedText: txt.value }), true),
      btn("Discard", () => owner("/api/lessons/resolve", { id: l.id, action: "discard" }), true)));
  }
  for (const g of data.pending) kids.push(heldCard(g));
  const st = data.status ? data.status.scenes : [];
  // Approved batches still waiting their turn: one button stops what has not started (a running clip finishes).
  const queued = {};
  for (const x of st) for (const j of x.jobs) if (j.status === "queued") (queued[j.batch || j.id] ||= []).push(j.id);
  for (const ids of Object.values(queued))
    kids.push(h("div", { class: "row" }, btn(`Stop remaining (${ids.length} queued)`, async () => { for (const id of ids) await cancelJob(id); }, true)));
  kids.push(...other);
  kids.push(h("div", { class: "grid" }, p.scenes.map((s) => {
    const x = st.find((q) => q.n === s.n) || { jobs: [] };
    const last = x.jobs.filter((j) => j.kind === "clip").slice(-1)[0];
    const redoDur = h("select", { "aria-label": `Scene ${s.n} redo duration` }, h("option", { value: "" }, "same as scene"), ...[4, 6, 8, 10].map((d) => h("option", { value: d }, d + " s")));
    return h("div", { class: "card" },
      h("b", {}, `Scene ${s.n}`), " ", h("span", { class: "tag" }, last ? last.status : s.clip ? "has clip" : s.approved ? "approved" : "not approved"),
      last && last.credits != null ? h("small", {}, ` ${last.credits} credits`) : null,
      last && last.note ? h("p", { class: "dim" }, last.note) : null, last && last.error ? h("p", { class: "err" }, last.error) : null,
      s.clip ? h("video", { src: media(s.clip), controls: true, preload: "metadata" }) : null,
      h("div", { class: "row" },
        s.clip ? btn(s.kept ? "Kept (undo)" : "Keep", () => owner("/api/scene", { ...c, n: s.n, kept: !s.kept }), true, s.kept ? "ok" : "") : null,
        last && (last.status === "held" || last.status === "queued") ? btn("Cancel", () => cancelJob(last.id), true) : null,
        redoDur,
        btn("Redo", async () => {
          const change = prompt(`Redo scene ${s.n}: what should change? (optional)`);
          if (change === null) return;
          await apiOk("studio_redo", { ...c, scene: s.n, ...(change.trim() ? { prompt: change.trim() } : {}), ...(redoDur.value ? { duration: Number(redoDur.value) } : {}) });
        })));
  })));
  el.replaceChildren(...kids);
}

// ---- Edit ----
function renderEdit(el) {
  if (el.dataset.built) return; // keep the iframe and chosen files alive across polls
  el.dataset.built = "1";
  const files = {};
  const out = h("pre", { class: "dim" });
  const frame = h("iframe", { src: "http://localhost:3000", title: "Remotion Studio", class: "frame", sandbox: "allow-scripts allow-same-origin allow-forms allow-downloads" });
  el.replaceChildren(
    h("div", { class: "row" }, picker("Music", async (f) => (files.music = await upload(f)), "audio/*"), picker("Voiceover", async (f) => (files.voiceover = await upload(f)), "audio/*")),
    h("div", { class: "row" },
      btn("Send kept clips to Remotion", async () => { out.textContent = JSON.stringify(await apiOk("studio_to_remotion", { ...cur(), ...files }), null, 2); }),
      btn("Start Remotion Studio", async () => {
        const r = await owner("/api/remotion/dev", {});
        toast(r.started ? "Starting Remotion Studio..." : "Remotion Studio already running");
        setTimeout(() => (frame.src = "http://localhost:3000"), 6000);
      }, true)),
    out, frame);
}

refresh(true);
