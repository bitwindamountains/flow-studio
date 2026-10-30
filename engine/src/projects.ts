import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { HOME_DIR } from "./chrome.js";
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

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|references)$/i;
// Windows device names (and our own references folder) cannot be folder names.
function checked(s: string): string {
  const n = safeName(s);
  if (RESERVED.test(n)) throw new Error(`"${n}" is a reserved name; pick another.`);
  return n;
}
const projDir = (project: string) => join(projectsRoot(), checked(project));
const subDir = (project: string, sub: string) => join(projDir(project), checked(sub));

export function createSub(project: string, sub: string, aspect: "9:16" | "16:9" = "9:16"): string {
  const dir = subDir(project, sub);
  if (existsSync(dir)) throw new Error(`Sub-project ${safeName(project)}/${safeName(sub)} already exists.`);
  mkdirSync(join(projDir(project), "references"), { recursive: true });
  mkdirSync(join(dir, "storyboard"), { recursive: true });
  mkdirSync(join(dir, "clips"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "");
  writePlanFile({ project: safeName(project), sub: safeName(sub), aspect, scenes: [] });
  return dir;
}

export const readPlan = (project: string, sub: string): Plan => {
  const f = join(subDir(project, sub), "plan.json");
  if (!existsSync(f)) throw new Error(`No plan for ${project}/${sub}.`);
  return readJson<Plan>(f, undefined as never);
};

const writePlanFile = (plan: Plan): void => writeJsonAtomic(join(subDir(plan.project, plan.sub), "plan.json"), plan);

function existingSub(project: string, sub: string): string {
  const d = subDir(project, sub);
  if (!existsSync(d)) throw new Error(`No sub-project ${project}/${sub}.`);
  return d;
}

export const writePlan = (plan: Plan): void => {
  existingSub(plan.project, plan.sub);
  writePlanFile(plan);
};

export function listProjects(): { project: string; subs: string[] }[] {
  const dirs = (d: string) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  return dirs(projectsRoot()).map((project) => ({ project, subs: dirs(join(projectsRoot(), project)).filter((s) => s.toLowerCase() !== "references") }));
}

export const readNotes = (project: string, sub: string): string => {
  const d = existingSub(project, sub);
  try { return readFileSync(join(d, "notes.md"), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
};
export const writeNotes = (project: string, sub: string, text: string): void => {
  writeFileSync(join(existingSub(project, sub), "notes.md"), text);
};

export function addReference(project: string, sub: string | undefined, srcPath: string, allowedRoots: string[] = [join(HOME_DIR, "uploads")]): string {
  const src = resolve(srcPath);
  const ok = allowedRoots.some((r) => { const rel = relative(resolve(r), src); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); });
  if (!ok) throw new Error(`Reference source must be inside ${allowedRoots.join(" or ")}.`);
  const dir = join(sub ? subDir(project, sub) : projDir(project), "references");
  mkdirSync(dir, { recursive: true });
  const ext = extname(srcPath);
  const stem = basename(srcPath, ext);
  let dest = join(dir, stem + ext);
  for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stem}-${i}${ext}`);
  copyFileSync(srcPath, dest);
  return dest;
}
