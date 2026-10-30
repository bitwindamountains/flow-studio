// Plain JS, no build step. TOKEN / UI_TOKEN come from the inline script in index.html.
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
function connect() {
  ws = new WebSocket(`ws://${location.host}/pty?ui=${encodeURIComponent(UI_TOKEN)}`);
  ws.onopen = () => { fit.fit(); send({ t: "r", cols: term.cols, rows: term.rows }); };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => term.write("\r\n[disconnected]\r\n");
}
term.onData((d) => send({ t: "i", d }));
term.onResize(({ cols, rows }) => send({ t: "r", cols, rows }));
$("restart").onclick = () => { term.reset(); send({ t: "restart" }); };
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
  } catch { /* picker stays empty */ }
}
$("project").onchange = fillSubs;
loadProjects();

// ---- health banner: stays hidden unless /api/health (Task 10) reports a problem; a 404 changes nothing ----
fetch("/api/health").then((r) => (r.ok ? r.json() : null)).then((h) => {
  if (h && h.ok === false && h.message) { $("health").textContent = h.message; $("health").hidden = false; }
}).catch(() => {});
