import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { safeName, subDir, within, type Plan } from "./projects.js";

// Read lazily so tests can point STUDIO_REMOTION at a temp dir.
export const remotionRoot = () => process.env.STUDIO_REMOTION ?? String.raw`D:\1ecbrzy\AFF\REMOTION\my-video`;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export function nextLetter(dir: string): string {
  const l = [...LETTERS].find((c) => !existsSync(join(dir, c)));
  if (!l) throw new Error(`all 26 handoff folders (a-z) are used in ${dir}`);
  return l;
}

export function handoff(plan: Plan, opts: { music?: string; voiceover?: string; folder?: string }): { dir: string; files: string[] } {
  const kept = plan.scenes.filter((s) => s.kept === true);
  if (!kept.length) throw new Error("no kept scenes to hand off");
  if (kept.length > 26) throw new Error("more than 26 kept clips; cannot name them a-z");
  for (const s of kept) {
    if (!s.clip) throw new Error(`scene ${s.n} is kept but has no clip`);
    if (!existsSync(s.clip)) throw new Error(`scene ${s.n} clip file is missing: ${s.clip}`);
  }
  for (const [what, p] of [["music", opts.music], ["voiceover", opts.voiceover]] as const)
    if (p && !existsSync(p)) throw new Error(`${what} file not found: ${p}`);

  const parent = join(remotionRoot(), "public", opts.folder ? safeName(opts.folder) : safeName(plan.project));
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, nextLetter(parent));
  mkdirSync(dir); // non-recursive: fails if it already exists

  const files: string[] = [];
  const put = (src: string, name: string) => {
    copyFileSync(src, join(dir, name), constants.COPYFILE_EXCL);
    files.push(name);
  };
  kept.forEach((s, i) => put(s.clip!, `${LETTERS[i]}.mp4`));
  if (opts.music) put(opts.music, "bg.mp3");
  if (opts.voiceover) put(opts.voiceover, "vo.mp3");
  writeFileSync(join(dir, "captions.json"), JSON.stringify(plan.scenes.map((s) => ({ scene: s.n, caption: s.caption, voiceover: s.voiceover })), null, 2), { flag: "wx" });
  files.push("captions.json");
  return { dir, files };
}

const RENDER = /^v(\d+)\.(mp4|webm|mov)$/;
export function listRenders(project: string, sub: string): { version: number; path: string }[] {
  const dir = join(subDir(project, sub), "renders");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => { const m = RENDER.exec(f); return m ? [{ version: Number(m[1]), path: join(dir, f) }] : []; }).sort((a, b) => a.version - b.version);
}

// Copies a finished Remotion render into the sub-project as the next free vN; never overwrites.
export function renderDone(project: string, sub: string, file: string): { version: number; path: string } {
  const ext = extname(file).toLowerCase();
  if (![".mp4", ".webm", ".mov"].includes(ext)) throw new Error("Render must be an mp4, webm or mov file.");
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Render file not found: ${file}`);
  if (!within(file, [join(remotionRoot(), "out")])) throw new Error(`Render must be inside ${join(remotionRoot(), "out")}.`);
  const dir = join(subDir(project, sub), "renders");
  mkdirSync(dir, { recursive: true });
  for (let v = Math.max(0, ...listRenders(project, sub).map((r) => r.version)) + 1; ; v++) {
    const path = join(dir, `v${v}${ext}`);
    try { copyFileSync(file, path, constants.COPYFILE_EXCL); return { version: v, path }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}
