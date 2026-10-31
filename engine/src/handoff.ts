import { existsSync, linkSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { safeName, within, type Plan } from "./projects.js";

// Read lazily so tests can point STUDIO_REMOTION at a temp dir.
export const remotionRoot = () => process.env.STUDIO_REMOTION ?? String.raw`D:\flow-studio\remotion\my-video`;

// One copy of every media file: clips live in Remotion's public/, finished videos in its out/.
export const subPublicDir = (project: string, sub: string) => join(remotionRoot(), "public", safeName(project), safeName(sub));
export const clipsDir = (project: string, sub: string) => join(subPublicDir(project, sub), "clips");
export const rendersDir = (project: string, sub: string) => join(remotionRoot(), "out", safeName(project), safeName(sub));

// Moves without copying and never overwrites: link fails with EEXIST if dest exists, then the source name goes.
export function moveExcl(src: string, dest: string): void {
  linkSync(src, dest);
  unlinkSync(src);
}

// Path for Remotion's staticFile(): relative to public/, forward slashes.
const staticPath = (file: string) => relative(join(remotionRoot(), "public"), file).split("\\").join("/");

export function handoff(plan: Plan, opts: { music?: string; voiceover?: string }): { dir: string; clips: string[]; captions: string; music?: string; voiceover?: string } {
  const kept = plan.scenes.filter((s) => s.kept === true);
  if (!kept.length) throw new Error("no kept scenes to hand off");
  for (const s of kept) {
    if (!s.clip) throw new Error(`scene ${s.n} is kept but has no clip`);
    if (!existsSync(s.clip)) throw new Error(`scene ${s.n} clip file is missing: ${s.clip}`);
  }
  const dir = subPublicDir(plan.project, plan.sub);
  const audio = ([["music", opts.music, "bg"], ["voiceover", opts.voiceover, "vo"]] as const).flatMap(([what, p, name]) => {
    if (!p) return [];
    if (!existsSync(p)) throw new Error(`${what} file not found: ${p}`);
    const dest = join(dir, name + extname(p).toLowerCase());
    if (existsSync(dest)) throw new Error(`${what}: ${dest} already exists; it is never overwritten.`);
    return [{ what, p, dest }];
  });
  mkdirSync(dir, { recursive: true });
  const moved: Record<string, string> = {};
  for (const a of audio) { moveExcl(a.p, a.dest); moved[a.what] = staticPath(a.dest); }
  const captions = join(dir, "captions.json");
  writeFileSync(captions, JSON.stringify(plan.scenes.map((s) => ({ scene: s.n, caption: s.caption, voiceover: s.voiceover })), null, 2));
  return { dir, clips: kept.map((s) => staticPath(s.clip!)), captions: staticPath(captions), ...moved };
}

const RENDER = /^v(\d+)\.(mp4|webm|mov)$/;
export function listRenders(project: string, sub: string): { version: number; path: string }[] {
  const dir = rendersDir(project, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => { const m = RENDER.exec(f); return m ? [{ version: Number(m[1]), path: join(dir, f) }] : []; }).sort((a, b) => a.version - b.version);
}

// Registers a finished Remotion render: already a vN in rendersDir -> returned as is; else moved there as the next
// free vN (no copy, never overwrites).
export function renderDone(project: string, sub: string, file: string): { version: number; path: string } {
  const out = join(remotionRoot(), "out");
  // Containment first (never reveal whether an outside path exists), then resolve once and move that exact file.
  if (!within(file, [out])) throw new Error(`Render must be inside ${out}.`);
  if (!existsSync(file)) throw new Error(`Render file not found: ${file}`);
  const real = realpathSync(file);
  if (!within(real, [out]) || !statSync(real).isFile()) throw new Error(`Render must be a file inside ${out}.`);
  const ext = extname(real).toLowerCase();
  if (![".mp4", ".webm", ".mov"].includes(ext)) throw new Error("Render must be an mp4, webm or mov file.");
  const dir = rendersDir(project, sub);
  mkdirSync(dir, { recursive: true });
  const m = RENDER.exec(basename(real));
  if (m && dirname(real) === realpathSync(dir)) return { version: Number(m[1]), path: real };
  for (let v = Math.max(0, ...listRenders(project, sub).map((r) => r.version)) + 1; ; v++) {
    const path = join(dir, `v${v}${ext}`);
    try { moveExcl(real, path); return { version: v, path }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}
