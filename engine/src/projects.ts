import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "./persist.js";

// Read lazily so tests (and the launcher) can set STUDIO_PROJECTS after import.
export const projectsRoot = () => process.env.STUDIO_PROJECTS ?? "D:\\flow-studio\\projects";

export const SceneSchema = z.object({
  n: z.number().int().min(1),
  prompt: z.string(),
  caption: z.string().optional(),
  voiceover: z.string().optional(),
  camera: z.string().optional(),
  references: z.array(z.string()).optional(),
  storyboard: z.string().optional(),
  approved: z.boolean().optional(),
  clip: z.string().optional(),
  kept: z.boolean().optional(),
});
export const PlanSchema = z.object({
  project: z.string().min(1),
  sub: z.string().min(1),
  aspect: z.enum(["9:16", "16:9"]),
  style: z.enum(["A", "B"]).optional(),
  scenes: z.array(SceneSchema).refine((s) => new Set(s.map((x) => x.n)).size === s.length, "scene numbers (n) must be unique"),
});
export type Scene = z.infer<typeof SceneSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export function safeName(s: string): string {
  const out = s.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").replace(/^-+|-+$/g, "");
  if (!out) throw new Error(`Invalid name "${s}": use letters, digits, - and _.`);
  return out;
}

const projDir = (project: string) => join(projectsRoot(), safeName(project));
const subDir = (project: string, sub: string) => join(projDir(project), safeName(sub));

export function createSub(project: string, sub: string, aspect: "9:16" | "16:9" = "9:16"): string {
  const dir = subDir(project, sub);
  if (existsSync(dir)) throw new Error(`Sub-project ${safeName(project)}/${safeName(sub)} already exists.`);
  mkdirSync(join(projDir(project), "references"), { recursive: true });
  mkdirSync(join(dir, "storyboard"), { recursive: true });
  mkdirSync(join(dir, "clips"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "");
  writePlan({ project: safeName(project), sub: safeName(sub), aspect, scenes: [] });
  return dir;
}

export const readPlan = (project: string, sub: string): Plan => {
  const f = join(subDir(project, sub), "plan.json");
  if (!existsSync(f)) throw new Error(`No plan for ${project}/${sub}.`);
  return readJson<Plan>(f, undefined as never);
};

export const writePlan = (plan: Plan): void => writeJsonAtomic(join(subDir(plan.project, plan.sub), "plan.json"), plan);

export function listProjects(): { project: string; subs: string[] }[] {
  const dirs = (d: string) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  return dirs(projectsRoot()).map((project) => ({ project, subs: dirs(join(projectsRoot(), project)).filter((s) => s !== "references") }));
}

export const readNotes = (project: string, sub: string): string => {
  try { return readFileSync(join(subDir(project, sub), "notes.md"), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
};
export const writeNotes = (project: string, sub: string, text: string): void => {
  mkdirSync(subDir(project, sub), { recursive: true });
  writeFileSync(join(subDir(project, sub), "notes.md"), text);
};

export function addReference(project: string, sub: string | undefined, srcPath: string): string {
  const dir = join(sub ? subDir(project, sub) : projDir(project), "references");
  mkdirSync(dir, { recursive: true });
  const ext = extname(srcPath);
  const stem = basename(srcPath, ext);
  let dest = join(dir, stem + ext);
  for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stem}-${i}${ext}`);
  copyFileSync(srcPath, dest);
  return dest;
}
