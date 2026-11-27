// One-time move to single-copy storage: clips -> Remotion public/<P>/<sub>/clips, renders -> Remotion out/<P>/<sub>.
// Run from engine/ after `npm run build`, studio stopped. Default is a dry run; `--apply` changes files.
// Never deletes a file unless an identical (sha256) twin remains. Never overwrites. Safe to re-run after an interruption.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { clipsDir, remotionRoot, rendersDir } from "../dist/handoff.js";
import { projectsRoot } from "../dist/projects.js";

const args = process.argv.slice(2);
const bad = args.filter((a) => a !== "--apply" && a !== "--dry");
if (bad.length || (args.includes("--apply") && args.includes("--dry"))) {
  console.error(`Unknown or conflicting arguments: ${args.join(" ")}\nUsage: node scripts/migrate-storage.mjs [--apply]   (default: dry run)`);
  process.exit(2);
}
const DRY = !args.includes("--apply");

// A running studio would rewrite queue.json and plans under us.
const health = `http://127.0.0.1:${process.env.FLOW_MCP_PORT ?? 8797}/api/health`;
const up = await fetch(health, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
if (up) { console.error(`The studio is running (${health} answered). Stop it first.`); process.exit(1); }

const QUEUE = process.env.STUDIO_QUEUE ?? fileURLToPath(new URL("../../data/queue.json", import.meta.url)); // data/ in the studio folder
const JOURNAL = join(QUEUE, "..", "migrate-storage.journal"); // old\tnew per finished move: a re-run maps renamed files right
const BACKUP = join(QUEUE, "..", `migrate-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const sum = { moved: [], duplicates: [], kept: [], rewritten: [], notes: [] };
let bytesSaved = 0;

const key = (p) => p.toLowerCase(); // Windows paths compare case-insensitively
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const files = (d) => (existsSync(d) ? readdirSync(d).filter((f) => statSync(join(d, f)).isFile()) : []);
const dirs = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const backup = (f) => { if (DRY) return; mkdirSync(BACKUP, { recursive: true }); copyFileSync(f, join(BACKUP, basename(f) + "-" + createHash("sha1").update(f).digest("hex").slice(0, 6))); };
const writeJson = (f, data) => { backup(f); const tmp = f + ".tmp"; writeFileSync(tmp, JSON.stringify(data, null, 2)); renameSync(tmp, f); };

const pathMap = new Map(); // key(old file) -> new path: this run's moves (planned ones in a dry run) + the journal
if (existsSync(JOURNAL)) for (const line of readFileSync(JOURNAL, "utf8").split("\n")) { const [o, n] = line.split("\t"); if (o && n) pathMap.set(key(o), n.trim()); }
const record = (from, to) => { pathMap.set(key(from), to); if (!DRY) appendFileSync(JOURNAL, `${from}\t${to}\n`); };
const hashes = new Map(); // sha256 -> path, of every migrated clip (and any already in place)

// Moves every file of src into dest. Same name there: identical -> drop ours; different -> ours gets -studio.
function moveAll(src, dest) {
  for (const f of files(dest)) hashes.set(sha(join(dest, f)), join(dest, f)); // earlier (interrupted) runs
  if (!existsSync(src)) return;
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
        record(from, to); hashes.set(h, to);
        continue;
      }
      const ext = extname(f);
      to = join(dest, `${basename(f, ext)}-studio${ext}`);
      for (let i = 2; existsSync(to); i++) to = join(dest, `${basename(f, ext)}-studio-${i}${ext}`);
      sum.kept.push(`${from} differs from the same-named file in ${dest}; moved as ${basename(to)}`);
    }
    const size = statSync(from).size;
    if (!DRY) { linkSync(from, to); try { unlinkSync(from); } catch (e) { unlinkSync(to); throw e; } } // link: never overwrites
    sum.moved.push(`${from} -> ${to} (${size} B)`);
    record(from, to); hashes.set(h, to);
  }
  if (!DRY) { try { rmdirSync(src); } catch { sum.notes.push(`left ${src} (not empty)`); } }
}

const subs = [];
for (const p of dirs(projectsRoot())) for (const s of dirs(join(projectsRoot(), p))) if (s.toLowerCase() !== "references") subs.push([p, s]);
// Old folder -> new folder, for every sub, whether or not anything is left to move.
const folders = subs.flatMap(([p, s]) => [[join(projectsRoot(), p, s, "clips"), clipsDir(p, s)], [join(projectsRoot(), p, s, "renders"), rendersDir(p, s)]]);
for (const [from, to] of folders) moveAll(from, to);

// Where a stored path now lives. Independent of what this run moved: the old folder itself maps to the new one, and a
// file maps to a recorded move, else to the same name in the new folder when that exists and the old file does not.
function newPath(v) {
  for (const [from, to] of folders) {
    if (key(v) === key(from)) return to;
    const rel = relative(from, v);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const mapped = pathMap.get(key(v));
    if (mapped) return mapped;
    const target = join(to, rel);
    if (existsSync(target) && !existsSync(v)) return target;
    if (existsSync(v)) sum.notes.push(`not moved yet, left as is: ${v}`);
    else sum.notes.push(`missing everywhere, left as is: ${v}`);
    return v;
  }
  return v;
}
function rewrite(v, where) {
  if (typeof v === "string") { const n = newPath(v); if (n !== v) sum.rewritten.push(`${where}: ${v} -> ${n}`); return n; }
  if (Array.isArray(v)) return v.map((x, i) => rewrite(x, `${where}[${i}]`));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, `${where}.${k}`)]));
  return v;
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

// Copies the old handoff made into public/<P>/<letter>/: an mp4 identical to a migrated clip goes, unless the owner's
// code names that letter folder anywhere (then the whole folder stays). Everything else stays.
const pub = join(remotionRoot(), "public");
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|json|mdx)$/i;
const srcText = (function walk(d) {
  return existsSync(d) ? readdirSync(d, { withFileTypes: true }).map((e) => e.isDirectory() ? walk(join(d, e.name)) : CODE.test(e.name) ? readFileSync(join(d, e.name), "utf8") : "").join("\n") : "";
})(join(remotionRoot(), "src")).toLowerCase().split("\\").join("/");
for (const p of new Set(subs.map(([p]) => p))) {
  for (const letter of dirs(join(pub, p)).filter((x) => /^[a-z]$/i.test(x))) {
    const d = join(pub, p, letter);
    const used = srcText.includes(`${p}/${letter}/`.toLowerCase());
    for (const f of files(d)) {
      const file = join(d, f);
      const twin = /\.mp4$/i.test(f) ? hashes.get(sha(file)) : undefined;
      if (twin && !used) {
        const size = statSync(file).size;
        if (!DRY) unlinkSync(file);
        bytesSaved += size;
        sum.duplicates.push(`${file} (identical to ${twin}, ${size} B)`);
      } else sum.kept.push(`${file} (${used ? `src/ uses "${p}/${letter}/"` : /\.mp4$/i.test(f) ? "no identical clip" : "not a clip"}${twin ? `; identical to ${twin}` : ""})`);
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
console.log(`${DRY ? "DRY RUN - nothing changed (add --apply to migrate)" : "MIGRATED"}  remotion=${remotionRoot()}  projects=${projectsRoot()}`);
list("moved", sum.moved);
list(`deleted as duplicate - ${(bytesSaved / 1048576).toFixed(1)} MB saved`, sum.duplicates);
list("kept", sum.kept);
list("rewritten paths", sum.rewritten);
list("notes", [...new Set(sum.notes)]);
if (!DRY && existsSync(BACKUP)) console.log(`\nbackups of rewritten json: ${BACKUP}`);
