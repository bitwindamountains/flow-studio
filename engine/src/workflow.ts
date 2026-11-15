import type { Plan } from "./projects.js";

export type Stage = "ideas" | "plan" | "storyboard" | "generate" | "edit";
export type NextAction = { kind: "navigate"; stage: Stage } | { kind: "compose"; instruction: string } | { kind: "review_jobs" };
export type StageState = { access: "open" | "review" | "locked"; status: "ready" | "complete" | "needs_attention" | "locked"; reason: string; nextAction?: NextAction };
export type WorkflowState = { project: string; sub: string; planRev: number; stages: Record<Stage, StageState>; recommendedStage: Stage };
export type WorkflowFacts = {
  plan: Plan;
  scenes: { n: number; validPlan: boolean; validSource: boolean; storyboardExists: boolean; clipExists: boolean; hasTakes: boolean; hasActiveJob: boolean }[];
  renderVersions: number[];
  editTaskPhase: string | null;
};

export function deriveWorkflow(f: WorkflowFacts): WorkflowState {
  const p = f.plan, scenes = p.scenes;
  const facts = new Map(f.scenes.map(s => [s.n, s]));
  const chosen = !!p.chosen && !!p.options?.some(o => o.id === p.chosen);
  const valid = (n: number) => { const s = facts.get(n); return !!s?.validPlan && s.validSource; };
  const validAny = scenes.some(s => valid(s.n));
  const validAll = scenes.length > 0 && scenes.every(s => valid(s.n));
  const approved = scenes.filter(s => s.approved && valid(s.n) && (s.start?.kind === "continue" || facts.get(s.n)?.storyboardExists));
  const kept = scenes.filter(s => s.kept);
  const staleKept = kept.some(s => s.stale !== undefined);
  const editable = kept.length > 0 && kept.every(s => s.stale === undefined && facts.get(s.n)?.clipExists);
  const monitoring = f.scenes.some(s => s.clipExists || s.hasTakes || s.hasActiveJob);
  const stills = f.scenes.some(s => s.storyboardExists) || scenes.some(s => s.approved);
  const state = (open: boolean, review: boolean, complete: boolean, reason: string): StageState => ({
    access: open ? "open" : review ? "review" : "locked",
    status: complete ? "complete" : open ? "ready" : review ? "needs_attention" : "locked", reason,
  });
  const stages: Record<Stage, StageState> = {
    ideas: state(true, false, chosen, chosen ? "Scenario selected. You can revisit the idea." : "Choose a scenario in chat to unlock Plan."),
    plan: state(chosen || scenes.length > 0, false, validAll, validAll ? "Scene plan ready for review." : chosen || scenes.length ? "Write or revise the scene prompts." : "Choose a scenario in Ideas first."),
    storyboard: state(validAny, stills, validAll && approved.length === scenes.length, validAny ? "Review each scene and approve its still or continuation prompt." : "Add a valid scene plan first."),
    generate: state(approved.length > 0, monitoring, scenes.length > 0 && scenes.every(s => facts.get(s.n)?.clipExists && s.stale === undefined), approved.length ? "Generate approved scenes, then Keep your chosen takes." : monitoring ? "Review existing takes and active jobs. Approve scenes before generating." : "Approve at least one storyboard scene first."),
    edit: state(editable, f.renderVersions.length > 0 || f.editTaskPhase !== null, editable && f.renderVersions.length > 0, editable ? "Your kept clips are ready. Edit or review the finished video." : staleKept ? "Redo stale kept clips before editing. Earlier renders remain available." : "Keep at least one usable clip; all kept clips must exist and be current."),
  };
  let recommendedStage: Stage = "ideas";
  if (staleKept || kept.some(s => !facts.get(s.n)?.clipExists)) recommendedStage = "generate";
  else if (editable || f.renderVersions.length) recommendedStage = "edit";
  else if (!chosen && !scenes.length) recommendedStage = "ideas";
  else if (!validAll) recommendedStage = "plan";
  else if (f.scenes.some(s => s.hasActiveJob)) recommendedStage = "generate";
  else if (approved.length !== scenes.length) recommendedStage = "storyboard";
  else recommendedStage = "generate";
  if (stages[recommendedStage].access === "locked") recommendedStage = stages.plan.access === "open" ? "plan" : "ideas";
  for (const stage of Object.keys(stages) as Stage[]) stages[stage].nextAction = { kind: "navigate", stage: recommendedStage };
  return { project: p.project, sub: p.sub, planRev: p.rev ?? 0, stages, recommendedStage };
}
