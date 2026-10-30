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

  private ensure(): IPty {
    if (this.pty) return this.pty;
    const p = this.pty = this.spawner();
    this.buf = "";
    p.onData((d) => {
      this.buf = (this.buf + d).slice(-SCROLLBACK);
      for (const s of this.sockets) if (s.readyState === 1) s.send(d);
    });
    p.onExit(() => {
      if (this.pty === p) this.pty = undefined;
      for (const s of this.sockets) if (s.readyState === 1) s.send("\r\n[claude exited - press Restart]\r\n");
    });
    return p;
  }

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    const p = this.ensure();
    if (this.buf) ws.send(this.buf);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (raw) => {
      let m: { t?: string; d?: string; cols?: number; rows?: number };
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === "i" && typeof m.d === "string") this.pty?.write(m.d);
      else if (m.t === "r" && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols! > 0 && m.rows! > 0) this.pty?.resize(m.cols!, m.rows!);
      else if (m.t === "restart") { this.kill(); const n = this.ensure(); void n; }
    });
    void p;
  }

  kill(): void {
    const p = this.pty;
    this.pty = undefined;
    try { p?.kill(); } catch { /* already gone */ }
  }
}
