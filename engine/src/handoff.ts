import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { isStill, safeName, within, type Plan } from "./projects.js";
import { readJson, writeJsonAtomic } from "./persist.js";
import { z } from "zod";

// Read lazily so tests can point STUDIO_REMOTION at a temp dir.
export const remotionRoot = () => process.env.STUDIO_REMOTION ?? String.raw`D:\flow-studio\remotion\my-video`;

// One copy of every media file: clips live in Remotion's public/, finished videos in its out/.
export const subPublicDir = (project: string, sub: string) => join(remotionRoot(), "public", safeName(project), safeName(sub));
export const clipsDir = (project: string, sub: string) => join(subPublicDir(project, sub), "clips");
export const stillsDir = (project: string, sub: string) => join(subPublicDir(project, sub), "stills");
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
const AudioManifest = z.object({ owner: z.literal("flow-studio-audio-v1"),
  imports: z.array(z.object({ kind: z.enum(["music", "voiceover"]), source: z.string(), file: z.string().regex(/^(bg|vo)(-v\d+)?\.(mp3|wav|m4a|aac|ogg|flac)$/) })),
  current: z.object({ music: z.string().optional(), voiceover: z.string().optional() }),
});
// The studio's own captions.json: an array of { scene: number, ... }. Anything else in that place is not ours.
const ours = (f: string) => { try { const c = JSON.parse(readFileSync(f, "utf8")); return Array.isArray(c) && c.every((x) => typeof x?.scene === "number"); } catch { return false; } };

export function handoff(plan: Plan, opts: { music?: string; voiceover?: string }): { dir: string; clips: string[]; scenes: { n: number; kind: "still" | "clip"; file: string }[]; captions: string; music?: string; voiceover?: string } {
  const kept = plan.scenes.filter((s) => s.kept === true);
  if (!kept.length) throw new Error("no kept scenes to hand off");
  for (const s of kept) {
    if (s.stale !== undefined) throw new Error(`Scene ${s.n} is stale after scene ${s.stale} changed - redo it before editing.`);
    if (isStill(s)) { if (!s.storyboard || !existsSync(s.storyboard)) throw new Error(`Scene ${s.n} is a kept still but its image file is missing: ${s.storyboard ?? "none"}`); continue; }
    if (!s.clip) throw new Error(`scene ${s.n} is kept but has no clip`);
    if (!existsSync(s.clip)) throw new Error(`scene ${s.n} clip file is missing: ${s.clip}`);
  }
  if (opts.music && opts.voiceover && existsSync(opts.music) && existsSync(opts.voiceover) && samePath(realpathSync(opts.music), realpathSync(opts.voiceover)))
    throw new Error("music and voiceover are the same file.");
  const dir = subPublicDir(plan.project, plan.sub);
  const manifestFile = join(dir, "audio-manifest.json");
  const manifest = AudioManifest.parse(readJson(manifestFile, { owner: "flow-studio-audio-v1", imports: [], current: {} }));
  const selected = { ...manifest.current };
  const audio = ([["music", opts.music, "bg"], ["voiceover", opts.voiceover, "vo"]] as const).flatMap(([what, p, name]) => {
    if (!p) return [];
    const imported = manifest.imports.find((a) => a.kind === what && samePath(a.source, p));
    if (imported) {
      const file = join(dir, imported.file);
      if (!within(file, [dir]) || !existsSync(file)) throw new Error(`${what}: imported audio is missing; upload it again.`);
      selected[what] = imported.file;
      return [];
    }
    if (!existsSync(p)) throw new Error(`${what} file not found: ${p}`);
    const ext = extname(p).toLowerCase();
    if (!AUDIO.includes(ext)) throw new Error(`${what} must be an audio file (${AUDIO.join(", ")}).`);
    let file = name + ext;
    for (let v = 2; existsSync(join(dir, file)); v++) file = `${name}-v${v}${ext}`;
    const dest = join(dir, file);
    selected[what] = file;
    return [{ what, p, dest }];
  });
  const captions = join(dir, "captions.json");
  if (existsSync(captions) && !ours(captions)) throw new Error(`${captions} was not written by the studio; it is never overwritten.`);
  // Validate reused audio before moving any replacement upload, so failure leaves every new source intact.
  for (const file of Object.values(selected)) {
    const incoming = audio.some((a) => basename(a.dest) === file);
    if (!incoming && (!manifest.imports.some((a) => a.file === file) || !within(join(dir, file), [dir]) || !existsSync(join(dir, file))))
      throw new Error("Registered audio is missing or invalid; upload the audio again.");
  }
  mkdirSync(dir, { recursive: true });
  // Stills are copied (never moved) into public/ so Remotion can serve them: identical bytes reuse the file, different bytes get the next free -vK.
  const placed = new Map<number, string>();
  for (const s of kept.filter(isStill)) {
    const ext = extname(s.storyboard!).toLowerCase(), src = readFileSync(s.storyboard!), folder = stillsDir(plan.project, plan.sub);
    mkdirSync(folder, { recursive: true });
    const stem = `scene-${String(s.n).padStart(3, "0")}`;
    for (let v = 1; ; v++) {
      const dest = join(folder, v === 1 ? stem + ext : `${stem}-v${v}${ext}`);
      if (existsSync(dest) && readFileSync(dest).equals(src)) { placed.set(s.n, dest); break; }
      if (existsSync(dest)) continue;
      try { copyFileSync(s.storyboard!, dest, constants.COPYFILE_EXCL); placed.set(s.n, dest); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; v--; }
    }
  }
  // Both audio moves or neither: a failed second move puts the first one back.
  const done: { p: string; dest: string }[] = [];
  try { for (const a of audio) { moveExcl(a.p, a.dest); done.push(a); } } catch (e) {
    for (const a of done) moveExcl(a.dest, a.p);
    throw e;
  }
  for (const a of audio) manifest.imports.push({ kind: a.what, source: a.p, file: basename(a.dest) });
  try { if (manifest.imports.length) writeJsonAtomic(manifestFile, { ...manifest, current: selected }); }
  catch (error) { for (const a of done) moveExcl(a.dest, a.p); throw error; }
  writeFileSync(captions, JSON.stringify(plan.scenes.map((s) => ({ scene: s.n, caption: s.caption, voiceover: s.voiceover })), null, 2));
  return { dir, clips: kept.filter((s) => !isStill(s)).map((s) => staticPath(s.clip!)), scenes: kept.map((s) => ({ n: s.n, kind: isStill(s) ? "still" as const : "clip" as const, file: staticPath(isStill(s) ? placed.get(s.n)! : s.clip!) })), captions: staticPath(captions), ...Object.fromEntries(Object.entries(selected).map(([what, file]) => [what, staticPath(join(dir, file))])) };
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
