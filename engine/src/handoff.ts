import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { safeName, within, type Plan } from "./projects.js";

// Read lazily so tests can point STUDIO_REMOTION at a temp dir.
export const remotionRoot = () => process.env.STUDIO_REMOTION ?? String.raw`D:\flow-studio\remotion\my-video`;

// One copy of every media file: clips live in Remotion's public/, finished videos in its out/.
export const subPublicDir = (project: string, sub: string) => join(remotionRoot(), "public", safeName(project), safeName(sub));
export const clipsDir = (project: string, sub: string) => join(subPublicDir(project, sub), "clips");
export const rendersDir = (project: string, sub: string) => join(remotionRoot(), "out", safeName(project), safeName(sub));

// Windows paths compare case-insensitively.
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Moves without copying and never overwrites: link fails with EEXIST if dest exists, then the source name goes.
export function moveExcl(src: string, dest: string): void {
  linkSync(src, dest);
  try { unlinkSync(src); } catch (e) { unlinkSync(dest); throw e; } // never leave two names for one move
}

// Path for Remotion's staticFile(): relative to public/, forward slashes.
const staticPath = (file: string) => relative(join(remotionRoot(), "public"), file).split("\\").join("/");

const AUDIO = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];
// The studio's own captions.json: an array of { scene: number, ... }. Anything else in that place is not ours.
const ours = (f: string) => { try { const c = JSON.parse(readFileSync(f, "utf8")); return Array.isArray(c) && c.every((x) => typeof x?.scene === "number"); } catch { return false; } };

export function handoff(plan: Plan, opts: { music?: string; voiceover?: string }): { dir: string; clips: string[]; captions: string; music?: string; voiceover?: string } {
  const kept = plan.scenes.filter((s) => s.kept === true);
  if (!kept.length) throw new Error("no kept scenes to hand off");
  for (const s of kept) {
    if (!s.clip) throw new Error(`scene ${s.n} is kept but has no clip`);
    if (!existsSync(s.clip)) throw new Error(`scene ${s.n} clip file is missing: ${s.clip}`);
  }
  if (opts.music && opts.voiceover && existsSync(opts.music) && existsSync(opts.voiceover) && samePath(realpathSync(opts.music), realpathSync(opts.voiceover)))
    throw new Error("music and voiceover are the same file.");
  const dir = subPublicDir(plan.project, plan.sub);
  const audio = ([["music", opts.music, "bg"], ["voiceover", opts.voiceover, "vo"]] as const).flatMap(([what, p, name]) => {
    if (!p) return [];
    if (!existsSync(p)) throw new Error(`${what} file not found: ${p}`);
    const ext = extname(p).toLowerCase();
    if (!AUDIO.includes(ext)) throw new Error(`${what} must be an audio file (${AUDIO.join(", ")}).`);
    const dest = join(dir, name + ext);
    if (existsSync(dest)) throw new Error(`${what}: ${dest} already exists; it is never overwritten.`);
    return [{ what, p, dest }];
  });
  const captions = join(dir, "captions.json");
  if (existsSync(captions) && !ours(captions)) throw new Error(`${captions} was not written by the studio; it is never overwritten.`);
  mkdirSync(dir, { recursive: true });
  // Both audio moves or neither: a failed second move puts the first one back.
  const done: { p: string; dest: string }[] = [];
  try { for (const a of audio) { moveExcl(a.p, a.dest); done.push(a); } } catch (e) {
    for (const a of done) moveExcl(a.dest, a.p);
    throw e;
  }
  writeFileSync(captions, JSON.stringify(plan.scenes.map((s) => ({ scene: s.n, caption: s.caption, voiceover: s.voiceover })), null, 2));
  return { dir, clips: kept.map((s) => staticPath(s.clip!)), captions: staticPath(captions), ...Object.fromEntries(audio.map((a) => [a.what, staticPath(a.dest)])) };
}

const RENDER = /^v(\d+)\.(mp4|webm|mov)$/i;
export function listRenders(project: string, sub: string): { version: number; path: string }[] {
  const dir = rendersDir(project, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => { const m = RENDER.exec(f); return m ? [{ version: Number(m[1]), path: join(dir, f) }] : []; }).sort((a, b) => a.version - b.version);
}

// Registers a finished Remotion render. Only two places count: the top level of out/ (moved in as the next free vN)
// or this sub's own rendersDir (a vN there is registered as is; anything else is renamed to the next vN). Every other
// out/<X>/ folder belongs to the owner or another project and is refused, so the owner's renders are never moved.
export function renderDone(project: string, sub: string, file: string): { version: number; path: string } {
  const out = join(remotionRoot(), "out");
  const dir = rendersDir(project, sub);
  // Containment first (never reveal whether an outside path exists), then resolve once and move that exact file.
  if (!within(file, [out])) throw new Error(`Render must be inside ${out}.`);
  if (!existsSync(file)) throw new Error(`Render file not found: ${file}`);
  const real = realpathSync(file);
  if (!within(real, [out]) || !statSync(real).isFile()) throw new Error(`Render must be a file inside ${out}.`);
  const atTop = samePath(dirname(real), realpathSync(out));
  if (!atTop && !within(real, [dir])) throw new Error(`Render must be at the top of ${out} or inside ${dir}; other out/ folders are never touched.`);
  const ext = extname(real).toLowerCase();
  if (![".mp4", ".webm", ".mov"].includes(ext)) throw new Error("Render must be an mp4, webm or mov file.");
  mkdirSync(dir, { recursive: true });
  const m = RENDER.exec(basename(real));
  if (m && samePath(dirname(real), realpathSync(dir))) return { version: Number(m[1]), path: real };
  for (let v = Math.max(0, ...listRenders(project, sub).map((r) => r.version)) + 1; ; v++) {
    const path = join(dir, `v${v}${ext}`);
    try { moveExcl(real, path); return { version: v, path }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}
