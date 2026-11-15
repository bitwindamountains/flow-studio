import { join } from "node:path";
import { z } from "zod";
import { subDir } from "./projects.js";
import { readJson, writeJsonAtomic } from "./persist.js";
import { isStill } from "./projects.js";
import type { WorkflowFacts } from "./workflow.js";
import { existsSync } from "node:fs";

export const STEP_ORDER = ["idea", "plan", "look", "assets", "edit"] as const;
export type StepName = (typeof STEP_ORDER)[number];
const Flag = z.object({ scene: z.number().optional(), at: z.number().optional(), note: z.string() });
const Pick = z.object({ scene: z.number(), clip: z.string() });
const Step = z.object({
  status: z.enum(["idle", "working", "review", "changes", "blocked", "approved"]), paused: z.boolean().optional(),
  budget: z.number(), reservations: z.array(z.object({ job: z.string(), credits: z.number() })), spent: z.number(),
  summary: z.string().optional(), flags: z.array(Flag), picks: z.array(Pick).optional(),
  feedback: z.array(z.object({ text: z.string(), scene: z.number().optional(), at: z.number().optional(), createdAt: z.string() })),
  blockedReason: z.string().optional(), session: z.string().optional() });
const Sessions = z.object({ claude: z.string().optional(), codex: z.string().optional() });
const State = z.object({ owner: z.literal("flow-studio-steps-v1"), rev: z.number(), sessions: Sessions.optional(), steps: z.object(Object.fromEntries(STEP_ORDER.map(n => [n, Step])) as Record<StepName, typeof Step>) });
export type Flag = z.infer<typeof Flag>;
export type Step = z.infer<typeof Step>;
export type StepStatus = Step["status"];
export type StepState = { owner: "flow-studio-steps-v1"; rev: number; sessions?: z.infer<typeof Sessions>; steps: Record<StepName, Step> };
export class BudgetError extends Error { constructor(public short: number) { super(`Over budget by ${short} credits.`); } }

const file = (p: string, s: string) => join(subDir(p, s), "steps.json");
const blank = (): Step => ({ status: "idle", budget: 0, reservations: [], spent: 0, flags: [], feedback: [] });
const label = (n: StepName) => n[0].toUpperCase() + n.slice(1);
export const remaining = (st: Step) => st.budget - st.spent - st.reservations.reduce((a, r) => a + r.credits, 0);
const blankState = (): StepState => ({ owner: "flow-studio-steps-v1", rev: 0, steps: Object.fromEntries(STEP_ORDER.map(n => [n, blank()])) as Record<StepName, Step> });
export function readSteps(p: string, s: string): StepState {
  const data = readJson<unknown>(file(p, s), null);
  return data === null ? blankState() : State.parse(data);
}
// Maps a sub-project made before steps existed onto the steps. Pure and cumulative: it stops at the first unsatisfied step,
// so a later step is never approved while an earlier one is not. Budgets 0, nothing working or paused, nothing written.
export function deriveSteps(f: WorkflowFacts): StepState {
  const st = blankState(), scenes = f.plan.scenes, fact = (n: number) => f.scenes.find(x => x.n === n);
  const ok: Record<Exclude<StepName, "edit">, boolean> = {
    idea: !!f.plan.chosen,
    plan: !!scenes.length && f.scenes.length === scenes.length && f.scenes.every(x => x.validPlan && x.validSource),
    look: !!scenes.length && scenes.every(s => s.approved === true && (!!fact(s.n)?.storyboardExists || s.start?.kind === "continue")),
    assets: !!scenes.length && scenes.every(s => s.kept === true && (isStill(s) ? !!fact(s.n)?.storyboardExists : !!fact(s.n)?.clipExists && s.stale === undefined)),
  };
  for (const n of STEP_ORDER) {
    if (n === "edit") { if (f.renderVersions.length) st.steps.edit.status = "review"; break; }
    if (!ok[n]) break;
    st.steps[n].status = "approved";
  }
  return st;
}
// The first owner write for an old sub-project starts from its derived state instead of all-idle.
export function seedSteps(p: string, s: string, derived: StepState): void { if (!existsSync(file(p, s))) writeJsonAtomic(file(p, s), derived); }
function change(p: string, s: string, fn: (st: StepState) => void): StepState {
  const st = readSteps(p, s); fn(st); st.rev++; writeJsonAtomic(file(p, s), st); return st;
}
const need = (st: StepState, n: StepName, ok: StepStatus[], msg: string) => { if (!ok.includes(st.steps[n].status)) throw new Error(`${label(n)} ${msg}`); };

export function submitStep(p: string, s: string, name: StepName, packet: { summary: string; flags: Flag[]; picks?: { scene: number; clip: string }[] }): StepState {
  if (packet.summary.split("\n").length > 3 || packet.summary.length > 400) throw new Error("Summary must be 3 lines or fewer and 400 characters or fewer.");
  if (packet.flags.some(f => f.note.length > 200)) throw new Error("Flag notes are limited to 200 characters.");
  return change(p, s, st => { need(st, name, ["working"], "is not working."); Object.assign(st.steps[name], { status: "review", summary: packet.summary, flags: packet.flags, picks: packet.picks, paused: undefined }); });
}
export const blockStep = (p: string, s: string, name: StepName, reason: string) =>
  change(p, s, st => { need(st, name, ["working"], "is not working."); Object.assign(st.steps[name], { status: "blocked", blockedReason: reason, paused: undefined }); });
export const approveStep = (p: string, s: string, name: StepName) =>
  change(p, s, st => { need(st, name, ["review"], "is not ready for review."); st.steps[name].status = "approved"; });
export function requestChanges(p: string, s: string, name: StepName, fb: { text: string; scene?: number; at?: number }): StepState {
  if (!fb.text.trim()) throw new Error("Say what to change.");
  return change(p, s, st => { need(st, name, ["review"], "is not ready for review."); st.steps[name].status = "changes"; st.steps[name].feedback.push({ ...fb, createdAt: new Date().toISOString() }); });
}
export const reopenStep = (p: string, s: string, name: StepName) => change(p, s, st => {
  for (const n of STEP_ORDER.slice(STEP_ORDER.indexOf(name))) Object.assign(st.steps[n], { status: "idle", summary: undefined, flags: [], picks: undefined, blockedReason: undefined, paused: undefined, session: undefined });
});
export function setBudget(p: string, s: string, name: StepName, credits: number): StepState {
  if (!Number.isInteger(credits) || credits < 0) throw new Error("Budget must be a whole number of credits, 0 or more.");
  return change(p, s, st => {
    const x = st.steps[name], used = x.budget - remaining(x);
    if (credits < used) throw new Error(`Budget cannot be below ${used} credits already spent or reserved.`);
    x.budget = credits;
  });
}
export const startStep = (p: string, s: string, name: StepName, session?: string) => change(p, s, st => {
  const first = STEP_ORDER.slice(0, STEP_ORDER.indexOf(name)).find(n => st.steps[n].status !== "approved");
  if (first) throw new Error(`${label(first)} is not approved.`);
  const x = st.steps[name];
  if (x.status === "working") throw new Error(`${label(name)} is already working.`);
  if (x.status === "review" || x.status === "approved") throw new Error(`${label(name)} cannot start from ${x.status}.`);
  Object.assign(x, { status: "working", paused: undefined, blockedReason: undefined, session });
});
export const pauseWorking = (p: string, s: string) => change(p, s, st => { for (const n of STEP_ORDER) if (st.steps[n].status === "working") st.steps[n].paused = true; });
export const resumeStep = (p: string, s: string, name: StepName) => change(p, s, st => { st.steps[name].paused = undefined; });
export const reserve = (p: string, s: string, name: StepName, job: string, credits: number) => change(p, s, st => {
  if (!Number.isInteger(credits) || credits < 0) throw new Error("Credits must be a whole number, 0 or more.");
  if (STEP_ORDER.some(n => st.steps[n].reservations.some(r => r.job === job))) throw new Error(`Job ${job} already has a reservation.`);
  const short = credits - remaining(st.steps[name]);
  if (short > 0) throw new BudgetError(short);
  st.steps[name].reservations.push({ job, credits });
});
export const settle = (p: string, s: string, job: string, spent: number | undefined) => {
  if (spent !== undefined && !(Number.isFinite(spent) && spent >= 0)) throw new Error("Spent must be a number, 0 or more.");
  return change(p, s, st => {
    for (const n of STEP_ORDER) { const x = st.steps[n], i = x.reservations.findIndex(r => r.job === job); if (i >= 0) { x.spent += spent ?? x.reservations[i].credits; x.reservations.splice(i, 1); return; } }
  });
};
// One agent session per agent kind for the whole sub-project, so a later step's headless run resumes it (step-runner.ts).
export const readSession = (p: string, s: string, agent: "claude" | "codex") => readSteps(p, s).sessions?.[agent];
export const setSession = (p: string, s: string, agent: "claude" | "codex", id: string | undefined) => change(p, s, st => { st.sessions = { ...st.sessions, [agent]: id }; });
