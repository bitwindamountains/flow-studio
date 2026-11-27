import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.STUDIO_PROJECTS = mkdtempSync(join(tmpdir(), "studio-runner-"));
const logDir = mkdtempSync(join(tmpdir(), "studio-runner-logs-"));
const { createSub } = await import("./projects.js");
const S = await import("./steps.js");
const { StepRunner, stepPrompt } = await import("./step-runner.js");
const { CWD, STUDIO } = await import("./pty.js");

type Fake = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { text: string; end(s: string): void }; killed: number; kill(): void };
function harness(agent: "claude" | "codex" = "claude") {
  const calls: { file: string; args: string[]; opts: { cwd?: string } }[] = [], kids: Fake[] = [];
  const launch = ((file: string, args: string[], opts: { cwd?: string }) => {
    const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0,
      stdin: { text: "", end(s: string) { this.text += s; } }, kill() { this.killed++; } }) as Fake;
    calls.push({ file, args, opts }); kids.push(c); return c;
  }) as never;
  let who = agent;
  const runner = new StepRunner({ agent: () => who, launch, logDir });
  return { runner, calls, kids, set: (a: "claude" | "codex") => { who = a; } };
}
let n = 0;
// A sub whose Idea step is already working, as LocalCore.gate leaves it before calling start.
const working = () => { const v = `r${n++}`; createSub("P", v); S.startStep("P", v, "idea"); return v; };
const status = (v: string) => S.readSteps("P", v).steps.idea;

test("start spawns once with the step prompt and writes output to the log file", () => {
  const { runner, calls, kids } = harness(), v = working();
  runner.start("P", v, "idea");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, CWD);
  assert.ok(calls[0].args.includes("-p") && calls[0].args.includes(`${STUDIO}/claude/settings.headless.json`));
  assert.equal(kids[0].stdin.text, stepPrompt("idea", "P", v));
  assert.equal(stepPrompt("idea", "P", v), `Run the "Idea" step for P/${v}. Follow the "Idea step" section of your instructions. Call studio_step_read first; finish with studio_step_submit or studio_step_blocked.`);
  assert.equal(runner.running("P", v), "idea");
  kids[0].stdout.emit("data", Buffer.from("hello from the agent"));
  assert.match(readFileSync(runner.logPath("P", v, "idea"), "utf8"), /hello from the agent/);
  kids[0].emit("close", 1);
});
test("a second start for the same sub while one is running is ignored", () => {
  const { runner, calls, kids } = harness(), v = working();
  runner.start("P", v, "idea"); runner.start("P", v, "idea");
  assert.equal(calls.length, 1);
  kids[0].emit("close", 1);
});
test("exit 0 without a submit or blocked report blocks the step with 'The agent stopped without finishing'", () => {
  const { runner, kids } = harness(), v = working();
  runner.start("P", v, "idea"); kids[0].emit("close", 0);
  assert.equal(status(v).status, "blocked");
  assert.match(status(v).blockedReason ?? "", /The agent stopped without finishing/);
  assert.equal(runner.running("P", v), null);
});
test("non-zero exit blocks the step and includes the last 300 characters of output", () => {
  const { runner, kids } = harness(), v = working();
  runner.start("P", v, "idea");
  kids[0].stdout.emit("data", "x".repeat(500)); kids[0].stderr.emit("data", "boom at the end");
  kids[0].emit("close", 2);
  const reason = status(v).blockedReason ?? "";
  assert.equal(status(v).status, "blocked");
  assert.ok(reason.endsWith(("x".repeat(500) + "boom at the end").slice(-300)), reason);
  assert.ok(!reason.includes("x".repeat(300)));
});
test("exit after studio_step_submit leaves status review", () => {
  const { runner, kids } = harness(), v = working();
  runner.start("P", v, "idea");
  S.submitStep("P", v, "idea", { summary: "3 options", flags: [] });
  kids[0].emit("close", 0);
  assert.equal(status(v).status, "review");
});
test("stop kills the child and does not block the step", () => {
  const { runner, kids } = harness(), v = working();
  runner.start("P", v, "idea"); runner.stop("P", v);
  assert.equal(kids[0].killed, 1);
  kids[0].emit("close", 1);
  assert.equal(status(v).status, "working");
  assert.equal(runner.running("P", v), null);
});
test("the session id from the first run is stored per agent and passed as resume on the next step", () => {
  const { runner, calls, kids } = harness(), v = working();
  runner.start("P", v, "idea");
  assert.ok(!calls[0].args.includes("--resume"));
  kids[0].stdout.emit("data", JSON.stringify({ type: "result", session_id: "11111111-2222-3333-4444-555555555555" }));
  S.submitStep("P", v, "idea", { summary: "s", flags: [] }); kids[0].emit("close", 0);
  assert.equal(S.readSession("P", v, "claude"), "11111111-2222-3333-4444-555555555555");
  S.approveStep("P", v, "idea"); S.startStep("P", v, "plan");
  runner.start("P", v, "plan");
  const args = calls[1].args;
  assert.equal(args[args.indexOf("--resume") + 1], "11111111-2222-3333-4444-555555555555");
  // A failed resume (non-zero, no new session) blocks with the output and is not retried; the stale id is dropped.
  kids[1].stderr.emit("data", "No conversation found"); kids[1].emit("close", 1);
  assert.equal(calls.length, 2);
  assert.equal(S.readSteps("P", v).steps.plan.status, "blocked");
  assert.match(S.readSteps("P", v).steps.plan.blockedReason ?? "", /No conversation found/);
  assert.equal(S.readSession("P", v, "claude"), undefined);
});
test("a paused step is not started", () => {
  const { runner, calls } = harness(), v = working();
  S.pauseWorking("P", v);
  runner.start("P", v, "idea");
  assert.equal(calls.length, 0);
  assert.equal(runner.running("P", v), null);
});
test("a headless run with Codex does not spawn and blocks the step", () => {
  const { runner, calls } = harness("codex"), v = working();
  runner.start("P", v, "idea");
  assert.equal(calls.length, 0);
  assert.equal(status(v).status, "blocked");
  assert.equal(status(v).blockedReason, "Headless steps run with Claude Code for now. Switch the agent to Claude and press Resume.");
});
test("a start dropped while the previous child was still exiting runs once that child closes", () => {
  const { runner, calls, kids } = harness(), v = working();
  runner.start("P", v, "idea");
  S.submitStep("P", v, "idea", { summary: "s", flags: [] }); S.approveStep("P", v, "idea"); S.startStep("P", v, "plan");
  runner.start("P", v, "plan"); // the Idea child is still finishing its last turn
  assert.equal(calls.length, 1);
  kids[0].emit("close", 0);
  assert.equal(calls.length, 2);
  assert.equal(runner.running("P", v), "plan");
  assert.equal(S.readSteps("P", v).steps.idea.status, "approved");
  // The same after a reopen: stop, then Start of that step before the killed child has closed.
  S.reopenStep("P", v, "plan"); runner.stop("P", v); S.startStep("P", v, "plan"); runner.start("P", v, "plan");
  assert.equal(calls.length, 2);
  kids[1].emit("close", 1);
  assert.equal(calls.length, 3);
  // A step the exiting child left working is blocked, never restarted.
  kids[2].emit("close", 0);
  assert.equal(calls.length, 3);
  assert.equal(S.readSteps("P", v).steps.plan.status, "blocked");
});
