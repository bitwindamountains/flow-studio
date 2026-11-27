import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOME_DIR } from "./chrome.js";
import type { StepStarter } from "./core.js";
import { subDir } from "./projects.js";
import { CWD, STUDIO, STUDIO_PROMPT_ARGS, type StudioAgent } from "./pty.js";
import { blockStep, readSession, readSteps, setSession, type StepName } from "./steps.js";

export const STEP_LOG_DIR = join(HOME_DIR, "step-logs");
// Built from the checked folder names, so a name like ".." can never leave the log folder; the server reads the same path.
export const stepLogPath = (p: string, s: string, step: StepName, logDir = STEP_LOG_DIR) => {
  const dir = subDir(p, s);
  return join(logDir, basename(dirname(dir)), basename(dir), `${step}.log`);
};
const label = (n: StepName) => n[0].toUpperCase() + n.slice(1);
export const stepPrompt = (step: StepName, project: string, sub: string) =>
  `Run the "${label(step)}" step for ${project}/${sub}. Follow the "${label(step)} step" section of your instructions. Call studio_step_read first; finish with studio_step_submit or studio_step_blocked.`;

// Flags verified against the installed CLI on 2026-11-15 (help output only, no agent run):
// `claude --help` (2.1.325): -p/--print, --output-format json, --strict-mcp-config, --mcp-config, --settings,
//   --setting-sources, --permission-mode dontAsk, -r/--resume <id>; --append-system-prompt-file is named in --bare's help
//   and already used by pty.ts (verified 2026-10-31). With -p and no prompt argument the prompt is read from stdin.
// The prompt always goes through stdin, so project/sub names never reach the command line (cmd.exe quoting).
// Codex has no permission file equivalent to settings.headless.json yet, so headless steps refuse it (see start).
const CLAUDE_HEADLESS = ["-p", "--output-format", "json", "--strict-mcp-config",
  "--mcp-config", `${STUDIO}/claude/mcp.json`,
  "--settings", `${STUDIO}/claude/settings.headless.json`,
  "--setting-sources", "project", // user/local allow rules (e.g. .claude/settings.local.json "Bash(python *)") must not widen these
  "--permission-mode", "dontAsk", // anything not allowed is denied, never prompted (nobody is there to answer)
  ...STUDIO_PROMPT_ARGS];
export const CODEX_REFUSED = "Headless steps run with Claude Code for now. Switch the agent to Claude and press Resume.";
// Claude's json result carries session_id.
const sessionIn = (out: string) => {
  for (const line of [out.trim(), ...out.split(/\r?\n/)]) { // whole output first, in case the result JSON spans lines
    try { const id = JSON.parse(line)?.session_id; if (typeof id === "string" && /^[\w-]{1,100}$/.test(id)) return id; } catch { /* not a JSON line */ }
  }
  return undefined;
};

type Run = { step: StepName; child: ChildProcess; stopped: boolean };

// Runs one step's agent without a terminal. It never starts, approves, budgets or resumes a step: LocalCore.gate puts the
// step in `working` first; this only reports a run that ended without submitting or blocking itself.
export class StepRunner implements StepStarter {
  private runs = new Map<string, Run>();
  private pending = new Map<string, StepName>(); // a start that arrived while the sub's previous child was still exiting
  private agent: () => StudioAgent;
  private launch: typeof spawn;
  private logDir: string;
  constructor(opts: { agent: () => StudioAgent; launch?: typeof spawn; logDir: string }) {
    this.agent = opts.agent; this.launch = opts.launch ?? spawn; this.logDir = opts.logDir;
  }

  logPath(p: string, s: string, step: StepName): string { return stepLogPath(p, s, step, this.logDir); }
  running(p: string, s: string): StepName | null { return this.runs.get(`${p}/${s}`)?.step ?? null; }

  start(p: string, s: string, step: StepName): void {
    const key = `${p}/${s}`, x = readSteps(p, s).steps[step];
    if (this.runs.has(key)) { this.pending.set(key, step); return; } // run once this child closes
    if (x.status !== "working" || x.paused) return;
    if (this.agent() !== "claude") { blockStep(p, s, step, CODEX_REFUSED); return; }
    const agent = "claude", session = readSession(p, s, agent), log = this.logPath(p, s, step);
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `\n===== ${new Date().toISOString()} ${agent} ${label(step)}${session ? " (resumed)" : ""} =====\n`);
    let out = "", done = false;
    const finish = (code: number | null, error?: string) => {
      if (done) return; done = true;
      const run = this.runs.get(key), next = this.pending.get(key); this.runs.delete(key); this.pending.delete(key);
      const found = sessionIn(out);
      try {
        if (found) setSession(p, s, agent, found);
        else if (session && code !== 0) setSession(p, s, agent, undefined); // the next owner-started run begins a fresh session
        const steps = readSteps(p, s).steps;
        if (!run?.stopped && next !== step && steps[step].status === "working") blockStep(p, s, step, error ? `Could not start ${agent}: ${error}`
          : code === 0 ? "The agent stopped without finishing. Check the step log, then resume."
          : `The agent exited with code ${code}${session && !found ? " while resuming its earlier session" : ""}. Last output: ${out.slice(-300)}`);
        // A start dropped while this child was exiting runs now; start() re-checks it is still working and not paused.
        if (next) this.start(p, s, next);
      } catch (e) { console.error(`flow-mcp: step run of ${key} ended: ${(e as Error).message}`); }
    };
    let child: ChildProcess;
    try {
      // cmd /c so the CLI shims resolve on PATH the way they do in a normal shell (as pty.ts does). Same env as the embedded agent.
      const a = [...CLAUDE_HEADLESS, ...(session ? ["--resume", session] : [])];
      const [file, argv] = process.platform === "win32" ? ["cmd.exe", ["/c", agent, ...a]] : [agent, a];
      child = this.launch(file, argv, { cwd: CWD, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) { return finish(null, (e as Error).message); }
    this.runs.set(key, { step, child, stopped: false });
    const take = (d: Buffer | string) => { const t = d.toString(); out = (out + t).slice(-200_000); appendFileSync(log, t); };
    child.stdout?.on("data", take); child.stderr?.on("data", take);
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
    child.stdin?.end(stepPrompt(step, p, s));
  }

  stop(p: string, s: string): void {
    const run = this.runs.get(`${p}/${s}`);
    if (!run) return;
    run.stopped = true;
    kill(run.child);
  }
  stopAll(): void { for (const r of this.runs.values()) { r.stopped = true; kill(r.child); } }
}

// On Windows the agent runs under cmd.exe, so only a tree kill reaches it. Synchronous: also used from the exit hook.
function kill(c: ChildProcess): void {
  try {
    if (process.platform === "win32" && c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
    else c.kill();
  } catch { /* already gone */ }
}
