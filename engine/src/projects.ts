import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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
  // Bumped by every writePlan; studio_plan_write must name the rev it read, so a stale copy cannot overwrite newer work.
  rev: z.number().int().min(0).optional(),
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
export const projDir = (project: string) => join(projectsRoot(), checked(project));
export const subDir = (project: string, sub: string) => join(projDir(project), checked(sub));

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

export const planRev = (project: string, sub: string): number => {
  try { return readPlan(project, sub).rev ?? 0; } catch { return 0; }
};

export const writePlan = (plan: Plan): void => {
  existingSub(plan.project, plan.sub);
  writePlanFile({ ...plan, rev: planRev(plan.project, plan.sub) + 1 });
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
// Content hash, not mtime: two writes inside one timestamp tick must still read as different.
export const notesRev = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
// With a base rev (from a read), refuses to overwrite notes someone else changed since.
export const writeNotes = (project: string, sub: string, text: string, base?: string): string => {
  const d = existingSub(project, sub);
  if (base !== undefined && base !== notesRev(readNotes(project, sub))) throw new Error("Notes changed since you read them — call studio_notes_read again.");
  writeFileSync(join(d, "notes.md"), text);
  return notesRev(text);
};

export const uploadsDir = () => join(HOME_DIR, "uploads");
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
// Realpath containment, so a symlink or junction inside an allowed folder cannot point outside it.
export function within(file: string, roots: string[]): boolean {
  const f = real(file);
  return roots.some((r) => { const rel = relative(real(r), f); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); });
}

export function addReference(project: string, sub: string | undefined, srcPath: string, allowedRoots: string[] = [uploadsDir()]): string {
  if (!within(srcPath, allowedRoots)) throw new Error(`Reference source must be inside ${allowedRoots.join(" or ")}.`);
  const dir = join(sub ? subDir(project, sub) : projDir(project), "references");
  mkdirSync(dir, { recursive: true });
  const ext = extname(srcPath);
  const stem = basename(srcPath, ext);
  let dest = join(dir, stem + ext);
  for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stem}-${i}${ext}`);
  copyFileSync(srcPath, dest);
  return dest;
}
