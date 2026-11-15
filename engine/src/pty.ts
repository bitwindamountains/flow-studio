import { spawn, type IPty } from "@lydell/node-pty";
import type { WebSocket } from "ws";
import { UiContextSchema, formatMessageContext, type UiContext } from "./ui-context.js";

// Remotion root, so the owner's style skills in remotion/.claude/skills load.
const CWD = "D:/flow-studio/remotion";
const STUDIO = "D:/flow-studio";
export type StudioAgent = "claude" | "codex";
export const CODEX_ARGS = [
  "--cd", CWD,
  "--add-dir", `${STUDIO}/projects`,
  "--sandbox", "workspace-write",
  "--ask-for-approval", "on-request",
  "--no-alt-screen",
  "--no-daemon",
];

// Flags verified against `claude --help` (2026-10-31): --add-dir, --mcp-config, --settings, --append-system-prompt-file.
export const CLAUDE_ARGS = [
  // Only the projects folder: ui/, engine/, claude/, data/ and the launcher stay outside Claude's workspace.
  "--add-dir", `${STUDIO}/projects`,
  "--mcp-config", `${STUDIO}/claude/mcp.json`,
  "--settings", `${STUDIO}/claude/settings.json`,
  "--append-system-prompt-file", `${STUDIO}/claude/studio-prompt.md`,
];

export function startAgent(agent: StudioAgent = "claude", launch: typeof spawn = spawn): IPty {
  // cmd /c so a claude.cmd shim resolves on PATH the way it does in a normal shell.
  const options = agent === "codex" ? CODEX_ARGS : CLAUDE_ARGS;
  const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", agent, ...options]] : [agent, options];
  return launch(file, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: CWD,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } });
}
export const startClaude = () => startAgent("claude");

const SCROLLBACK = 200_000;

// One selected agent process per studio session. Only owner-authorized sockets reach this hub.
export class PtyHub {
  private pty?: IPty;
  private buf = "";
  private sockets = new Set<WebSocket>();
  private agent: StudioAgent = "claude";
  private status: "starting" | "running" | "exited" | "failed" = "starting";
  private attempted = false;
  private session = 0;
  private exitCode?: number;
  private size: [number, number] = [100, 30];
  private modes = new Map<WebSocket, "message" | "terminal">();
  private requests = new Set<string>();
  private submission?: { ws: WebSocket; requestId: string; session: number };
  constructor(private spawner: (agent: StudioAgent) => IPty = startAgent, private onEnd: (message: string) => void = () => {},
    private validateContext: (raw: unknown) => UiContext = () => { throw new Error("Screen context validation unavailable."); }) {}

  private delivery(ws: WebSocket, requestId: string, state: string, reason?: string): void {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: "message-delivery", requestId, state, reason }));
  }
  private submit(ws: WebSocket, m: Record<string, unknown>): void {
    const id = typeof m.requestId === "string" ? m.requestId : "";
    try {
      if (!id || id.length > 100) throw new Error("Invalid message request ID.");
      if (this.requests.has(id)) throw new Error("This message was already submitted. Review the terminal before retrying.");
      if (m.session !== this.session || this.status !== "running" || !this.pty) throw new Error("Agent session changed or is not running.");
      if (this.submission) throw new Error("Another window is sending a message. Wait for delivery.");
      if (this.modes.get(ws) !== "message" || m.ready !== true) throw new Error("Choose Message mode and confirm the agent is at its input prompt.");
      if (typeof m.text !== "string" || !m.text.trim() || m.text.length > 16000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(m.text)) throw new Error("Message must contain 1–16000 characters without terminal control codes.");
      const context = UiContextSchema.parse(this.validateContext(m.context));
      this.requests.add(id);
      if (this.requests.size > 512) this.requests.delete(this.requests.values().next().value!);
      const pending = { ws, requestId: id, session: this.session }, pty = this.pty;
      this.submission = pending;
      try {
        pty.write(`\x1b[200~${formatMessageContext(context)}${m.text}\x1b[201~`);
      } catch { this.submission = undefined; this.delivery(ws, id, "uncertain", "Writing to the terminal failed. Review it before retrying."); return; }
      setTimeout(() => {
        if (this.submission !== pending) return;
        this.submission = undefined;
        if (this.pty !== pty || this.session !== pending.session || ws.readyState !== 1) {
          this.delivery(ws, id, "uncertain", "Connection or session changed after message text was forwarded. Review the terminal before retrying."); return;
        }
        try { pty.write("\r"); this.delivery(ws, id, "forwarded"); }
        catch { this.delivery(ws, id, "uncertain", "Enter could not be confirmed. Review the terminal before retrying."); }
      }, 250);
    } catch (e) { this.delivery(ws, id, "rejected", (e as Error).message); }
  }

  private state(ws: WebSocket): void { ws.send(JSON.stringify({ t: "agent", agent: this.agent, status: this.status, session: this.session, exitCode: this.exitCode })); }
  private broadcastState(): void { for (const s of this.sockets) if (s.readyState === 1) this.state(s); }
  private ended(message: string): void {
    try { this.onEnd(message); } catch (error) { console.error("Studio could not record interrupted edit:", (error as Error).message); }
  }
  private output(data: string): void {
    this.buf = (this.buf + data).slice(-SCROLLBACK);
    for (const s of this.sockets) if (s.readyState === 1) s.send(JSON.stringify({ t: "output", data }));
  }

  private ensure(): IPty | undefined {
    if (this.pty) return this.pty;
    this.attempted = true;
    this.session++;
    this.exitCode = undefined;
    this.status = "starting";
    this.buf = "";
    this.broadcastState();
    let p: IPty;
    try { p = this.spawner(this.agent); } catch (e) {
      this.status = "failed";
      this.broadcastState();
      this.output(`\r\n[Could not start ${this.agent}: ${e instanceof Error ? e.message : String(e)}. Check that the CLI is installed on PATH, then press Restart.]\r\n`);
      return undefined;
    }
    this.pty = p;
    p.resize(...this.size);
    p.onData((d) => {
      if (this.pty !== p) return; // late output from a killed pty
      this.output(d);
    });
    p.onExit((event) => {
      if (this.pty !== p) return;
      const { exitCode } = event;
      this.pty = undefined;
      this.status = "exited";
      this.ended("The agent exited during this edit. Review the terminal and existing renders before retrying.");
      this.exitCode = exitCode;
      this.broadcastState();
      this.output(`\r\n[${this.agent} exited (code ${exitCode}). Press Restart to start a new session.]\r\n`);
    });
    this.status = "running";
    this.broadcastState();
    return p;
  }

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("error", () => ws.terminate());
    ws.on("close", () => { this.sockets.delete(ws); this.modes.delete(ws); });
    this.modes.set(ws, "terminal");
    if (!this.attempted) this.ensure();
    else {
      this.state(ws);
      if (this.buf) ws.send(JSON.stringify({ t: "output", data: this.buf }));
    }
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as Record<string, any> | null;
        if (!m || typeof m !== "object") return;
        if (m.t === "submit-message") this.submit(ws, m);
        else if (m.t === "input-mode" && m.session === this.session && (m.mode === "message" || m.mode === "terminal")) {
          if (this.submission) return;
          this.modes.set(ws, m.mode);
          ws.send(JSON.stringify({ t: "input-mode", mode: m.mode, session: this.session }));
        }
        else if (m.t === "i" && !this.submission && this.modes.get(ws) !== "message" && typeof m.d === "string" && (m.session === undefined || m.session === this.session)) this.pty?.write(m.d);
        else if (m.t === "r" && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols! > 0 && m.rows! > 0 && m.cols! <= 1000 && m.rows! <= 1000) {
          this.size = [m.cols!, m.rows!]; this.pty?.resize(...this.size);
        }
        else if (m.t === "restart" || (m.t === "agent" && (m.agent === "claude" || m.agent === "codex"))) {
          if (m.t === "agent" && m.agent === this.agent) return;
          this.kill();
          if (m.t === "agent") this.agent = m.agent as StudioAgent;
          this.ensure();
        }
      } catch { /* bad frame or dead pty: ignore, never crash the queue owner */ }
    });
  }

  kill(): void {
    if (this.submission) this.delivery(this.submission.ws, this.submission.requestId, "uncertain", "Agent was restarted after text was forwarded. Review before retrying.");
    this.submission = undefined;
    this.modes.clear(); this.requests.clear();
    const p = this.pty;
    this.pty = undefined;
    this.buf = "";
    if (p) this.ended("The agent session was restarted or switched. Review existing work before retrying the edit.");
    try { p?.kill(); } catch { /* already gone */ }
  }
}
