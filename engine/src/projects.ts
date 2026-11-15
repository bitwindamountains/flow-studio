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
  // What the storyboard still shows. `prompt` is the CLIP prompt: motion, camera move and sound starting from that frame.
  frame_prompt: z.string().optional(),
  prompt: z.string(),
  // "continue": the clip starts on the last frame of scene `from` (an earlier scene) instead of its own still.
  start: z.union([z.object({ kind: z.literal("frame") }), z.object({ kind: z.literal("continue"), from: z.number().int().min(1) })]).optional(),
  caption: z.string().optional(),
  voiceover: z.string().optional(),
  camera: z.string().optional(),
  references: z.array(z.string()).optional(),
  storyboard: z.string().optional(),
  approved: z.boolean().optional(),
  // Per-scene video settings; unset falls back to VIDEO_DEFAULTS. Veo ignores duration/resolution (Flow fixes them).
  model: z.string().optional(),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional(),
  resolution: z.enum(["360p", "720p"]).optional(),
  clip: z.string().optional(),
  kept: z.boolean().optional(),
  // Engine-owned: where the storyboard still / clip sits in Flow (hashed account id + Flow project path).
  storyboard_flow: z.object({ account: z.string(), flowProject: z.string() }).optional(),
  clip_flow: z.object({ account: z.string(), flowProject: z.string() }).optional(),
  takes: z.array(z.object({ clip: z.string(), flow: z.object({ account: z.string(), flowProject: z.string() }).optional(), fromClip: z.string().optional(), createdAt: z.string().optional() })).optional(),
  // Engine-owned: the scene whose clip changed after this clip was made, so this clip no longer joins it.
  stale: z.number().int().optional(),
});
export const OptionSchema = z.object({ id: z.string().min(1), title: z.string(), hook: z.string(), story: z.string(), scenes: z.number().int().min(1) });
export const PlanSchema = z.object({
  project: z.string().min(1),
  sub: z.string().min(1),
  aspect: z.enum(["9:16", "16:9"]),
  style: z.enum(["A", "B"]).optional(),
  // Explicit ad-wide selection. Folder contents are never implicitly selected.
  references: z.array(z.string()).optional(),
  // Bumped by every writePlan; studio_plan_write must name the rev it read, so a stale copy cannot overwrite newer work.
  rev: z.number().int().min(0).optional(),
  // Ideas tab: scenario options Claude proposes, and the id of the one the owner picked in chat.
  options: z.array(OptionSchema).max(10).optional(),
  chosen: z.string().optional(),
  scenes: z.array(SceneSchema).refine((s) => new Set(s.map((x) => x.n)).size === s.length, "scene numbers (n) must be unique"),
});
export type Scene = z.infer<typeof SceneSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export const VIDEO_DEFAULTS = { model: "Omni 1.1 Flash", duration: 8 as 4 | 6 | 8 | 10, resolution: "720p" as "360p" | "720p" };
// Per-job credit cap by model when the caller gives none (spent only within it; nothing is spent if Flow quotes more).
export const MODEL_MAX_CREDITS: Record<string, number> = { "Omni 1.1 Flash": 20, "Veo 3.1 - Lite": 15, "Veo 3.1 - Fast": 25, "Veo 3.1 - Quality": 110 };
export const UNKNOWN_MODEL_MAX_CREDITS = 25;

type Overrides = { model?: string; duration?: 4 | 6 | 8 | 10; resolution?: "360p" | "720p" };
// overrides > scene fields > defaults. Veo: duration fixed at 8, resolution omitted.
export function sceneSettings(scene: Overrides, o: Overrides = {}) {
  const model = o.model ?? scene.model ?? VIDEO_DEFAULTS.model;
  const max_credits = MODEL_MAX_CREDITS[model] ?? UNKNOWN_MODEL_MAX_CREDITS;
  if (/^veo/i.test(model)) return { model, duration: 8 as const, resolution: undefined, max_credits };
  return { model, duration: o.duration ?? scene.duration ?? VIDEO_DEFAULTS.duration, resolution: o.resolution ?? scene.resolution ?? VIDEO_DEFAULTS.resolution, max_credits };
}

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
  // One letter collides with the old handoff folders (public/<P>/a, b, ...) next to Remotion's public/<P>/<sub>.
  if (/^[a-z]$/i.test(safeName(sub))) throw new Error(`Sub-project name "${sub}" is too short: use two or more characters.`);
  const dir = subDir(project, sub);
  if (existsSync(dir)) throw new Error(`Sub-project ${safeName(project)}/${safeName(sub)} already exists.`);
  mkdirSync(join(projDir(project), "references"), { recursive: true });
  mkdirSync(join(dir, "storyboard"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "");
  writePlanFile({ project: safeName(project), sub: safeName(sub), aspect, references: [], scenes: [] });
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

export const readNotes = (project: string, sub: string, file = "notes.md"): string => {
  const d = existingSub(project, sub);
  try { return readFileSync(join(d, file), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
};
// Content hash, not mtime: two writes inside one timestamp tick must still read as different.
export const notesRev = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
// With a base rev (from a read), refuses to overwrite notes someone else changed since.
export const writeNotes = (project: string, sub: string, text: string, base?: string, file = "notes.md"): string => {
  const d = existingSub(project, sub);
  if (base !== undefined && base !== notesRev(readNotes(project, sub, file))) throw new Error(file === "notes.md" ? "Notes changed since you read them — call studio_notes_read again." : "Edit notes changed since you read them — call studio_edit_notes_read again.");
  writeFileSync(join(d, file), text);
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
