// One-time move to single-copy storage: clips -> Remotion public/<P>/<sub>/clips, renders -> Remotion out/<P>/<sub>.
// Run from engine/ after `npm run build`, studio stopped:  node scripts/migrate-storage.mjs --dry   then without --dry.
// Never deletes a file unless an identical (sha256) twin remains. Never overwrites.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { clipsDir, remotionRoot, rendersDir } from "../dist/handoff.js";
import { projectsRoot } from "../dist/projects.js";

const DRY = process.argv.includes("--dry");
const QUEUE = process.env.STUDIO_QUEUE ?? String.raw`D:\flow-studio\data\queue.json`;
const BACKUP = join(QUEUE, "..", `migrate-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const sum = { moved: [], duplicates: [], kept: [], rewritten: [], notes: [] };
let bytesSaved = 0;

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const files = (d) => (existsSync(d) ? readdirSync(d).filter((f) => statSync(join(d, f)).isFile()) : []);
const dirs = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const backup = (f) => { if (DRY) return; mkdirSync(BACKUP, { recursive: true }); copyFileSync(f, join(BACKUP, basename(f) + "-" + createHash("sha1").update(f).digest("hex").slice(0, 6))); };
const writeJson = (f, data) => { backup(f); const tmp = f + ".tmp"; writeFileSync(tmp, JSON.stringify(data, null, 2)); renameSync(tmp, f); };

const pathMap = new Map(); // old absolute path (file or dir) -> new
const hashes = new Map(); // sha256 -> destination path, of every migrated clip

// Moves every file of src into dest. Same name there: identical -> drop ours; different -> ours gets -studio.
function moveAll(src, dest) {
  if (!existsSync(src)) return;
  pathMap.set(src, dest);
  if (!DRY) mkdirSync(dest, { recursive: true });
  for (const f of files(src)) {
    const from = join(src, f);
    const h = sha(from);
    let to = join(dest, f);
    if (existsSync(to)) {
      if (sha(to) === h) {
        const size = statSync(from).size;
        if (!DRY) unlinkSync(from);
        bytesSaved += size;
        sum.duplicates.push(`${from} (identical to ${to}, ${size} B)`);
        pathMap.set(from, to); hashes.set(h, to);
        continue;
      }
      const ext = extname(f);
      to = join(dest, `${basename(f, ext)}-studio${ext}`);
      for (let i = 2; existsSync(to); i++) to = join(dest, `${basename(f, ext)}-studio-${i}${ext}`);
      sum.kept.push(`${from} differs from the same-named file in ${dest}; moved as ${basename(to)}`);
    }
    if (!DRY) { linkSync(from, to); unlinkSync(from); } // link: fails rather than overwrite
    sum.moved.push(`${from} -> ${to} (${statSync(DRY ? from : to).size} B)`);
    pathMap.set(from, to); hashes.set(h, to);
  }
  if (!DRY) { try { rmdirSync(src); } catch { sum.notes.push(`left ${src} (not empty)`); } }
}

// Rewrites every string that is a moved path (file or folder) to its new path.
function rewrite(v, where) {
  if (typeof v === "string") { const n = pathMap.get(v); if (n) { sum.rewritten.push(`${where}: ${v} -> ${n}`); return n; } return v; }
  if (Array.isArray(v)) return v.map((x, i) => rewrite(x, `${where}[${i}]`));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, `${where}.${k}`)]));
  return v;
}

const subs = [];
for (const p of dirs(projectsRoot())) for (const s of dirs(join(projectsRoot(), p))) if (s.toLowerCase() !== "references") subs.push([p, s]);
for (const [p, s] of subs) {
  const d = join(projectsRoot(), p, s);
  moveAll(join(d, "clips"), clipsDir(p, s));
  moveAll(join(d, "renders"), rendersDir(p, s));
}

for (const [p, s] of subs) {
  const f = join(projectsRoot(), p, s, "plan.json");
  if (!existsSync(f)) continue;
  const before = sum.rewritten.length;
  const plan = rewrite(JSON.parse(readFileSync(f, "utf8")), `${p}/${s}/plan.json`);
  if (sum.rewritten.length > before && !DRY) writeJson(f, { ...plan, rev: (plan.rev ?? 0) + 1 });
}
if (existsSync(QUEUE)) {
  const before = sum.rewritten.length;
  const q = rewrite(JSON.parse(readFileSync(QUEUE, "utf8")), "queue.json");
  if (sum.rewritten.length > before && !DRY) writeJson(QUEUE, q);
}

// Copies the old handoff made into public/<P>/<letter>/: an mp4 identical to a migrated clip goes; the rest stays.
const pub = join(remotionRoot(), "public");
// Text of the owner's compositions: a copy that src/ still names (staticFile("P/a/a.mp4")) is in use and is kept.
const srcText = (function walk(d) {
  return existsSync(d) ? readdirSync(d, { withFileTypes: true }).map((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? readFileSync(join(d, e.name), "utf8") : "").join("\n") : "";
})(join(remotionRoot(), "src"));
for (const p of new Set(subs.map(([p]) => p))) {
  for (const letter of dirs(join(pub, p)).filter((x) => /^[a-z]$/.test(x))) {
    const d = join(pub, p, letter);
    for (const f of files(d)) {
      const file = join(d, f);
      const twin = /\.mp4$/i.test(f) ? hashes.get(sha(file)) : undefined;
      const used = srcText.includes(`${p}/${letter}/${f}`);
      if (twin && used) sum.kept.push(`${file} (identical to ${twin}, but src/ still uses "${p}/${letter}/${f}")`);
      else if (twin) {
        const size = statSync(file).size;
        if (!DRY) unlinkSync(file);
        bytesSaved += size;
        sum.duplicates.push(`${file} (identical to ${twin}, ${size} B)`);
      } else sum.kept.push(`${file} (${/\.mp4$/i.test(f) ? "no identical clip" : "not a clip"})`);
    }
  }
}

// Earlier renders Claude wrote straight into out/: left alone, reported (with any identical migrated render).
const out = join(remotionRoot(), "out");
for (const f of files(out).filter((x) => /\.(mp4|webm|mov)$/i.test(x))) {
  const twin = hashes.get(sha(join(out, f)));
  sum.kept.push(`${join(out, f)} (left in place${twin ? `; identical to ${twin}` : ""})`);
}
for (const d of dirs(pub)) if (!subs.some(([p]) => p === d)) sum.notes.push(`not touched: public/${d}`);
for (const d of dirs(out)) if (!subs.some(([p]) => p === d)) sum.notes.push(`not touched: out/${d}`);

const list = (t, a) => console.log(`\n${t} (${a.length})${a.length ? "\n  " + a.join("\n  ") : ""}`);
console.log(`${DRY ? "DRY RUN - nothing changed" : "MIGRATED"}  remotion=${remotionRoot()}  projects=${projectsRoot()}`);
list("moved", sum.moved);
list(`deleted as duplicate - ${(bytesSaved / 1048576).toFixed(1)} MB saved`, sum.duplicates);
list("kept", sum.kept);
list("rewritten paths", sum.rewritten);
list("notes", sum.notes);
if (!DRY && existsSync(BACKUP)) console.log(`\nbackups of rewritten json: ${BACKUP}`);
