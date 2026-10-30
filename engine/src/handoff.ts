import { constants, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeName, type Plan } from "./projects.js";

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
