import { spawn, type IPty } from "@lydell/node-pty";
import type { WebSocket } from "ws";

const CWD = "D:/1ecbrzy/AFF/REMOTION";
const STUDIO = "D:/flow-studio";

// Flags verified against `claude --help` (2026-10-31): --add-dir, --mcp-config, --settings, --append-system-prompt-file.
export const CLAUDE_ARGS = [
  "--add-dir", STUDIO,
  "--mcp-config", `${STUDIO}/claude/mcp.json`,
  "--settings", `${STUDIO}/claude/settings.json`,
  "--append-system-prompt-file", `${STUDIO}/claude/studio-prompt.md`,
];

export function startClaude(): IPty {
  // cmd /c so a claude.cmd shim resolves on PATH the way it does in a normal shell.
  const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "claude", ...CLAUDE_ARGS]] : ["claude", CLAUDE_ARGS];
  return spawn(file, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: CWD, env: process.env });
}

const SCROLLBACK = 200_000;

// One claude process per studio session. Every authorized socket attaches to it; nothing spawns until the first one.
export class PtyHub {
  private pty?: IPty;
  private buf = "";
  private sockets = new Set<WebSocket>();
  constructor(private spawner: () => IPty = startClaude) {}

  private ensure(ws?: WebSocket): IPty | undefined {
    if (this.pty) return this.pty;
    let p: IPty;
    try { p = this.spawner(); } catch (e) {
      ws?.send(`\r\n[could not start claude: ${e instanceof Error ? e.message : String(e)}]\r\n`);
      return undefined;
    }
    this.pty = p;
    this.buf = "";
    p.onData((d) => {
      if (this.pty !== p) return; // late output from a killed pty
      this.buf = (this.buf + d).slice(-SCROLLBACK);
      for (const s of this.sockets) if (s.readyState === 1) s.send(d);
    });
    p.onExit(() => {
      if (this.pty !== p) return;
      this.pty = undefined;
      for (const s of this.sockets) if (s.readyState === 1) s.send("\r\n[claude exited - press Restart]\r\n");
    });
    return p;
  }

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("error", () => ws.terminate());
    ws.on("close", () => this.sockets.delete(ws));
    this.ensure(ws);
    if (this.buf) ws.send(this.buf);
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as { t?: string; d?: string; cols?: number; rows?: number } | null;
        if (!m || typeof m !== "object") return;
        if (m.t === "i" && typeof m.d === "string") this.pty?.write(m.d);
        else if (m.t === "r" && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols! > 0 && m.rows! > 0) this.pty?.resize(m.cols!, m.rows!);
        else if (m.t === "restart") { this.kill(); this.ensure(ws); }
      } catch { /* bad frame or dead pty: ignore, never crash the queue owner */ }
    });
  }

  kill(): void {
    const p = this.pty;
    this.pty = undefined;
    try { p?.kill(); } catch { /* already gone */ }
  }
}
