import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/migrate-storage.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fm-mig-"));
  const old = join(root, "projects", "P", "ad", "clips");
  const oldR = join(root, "projects", "P", "ad", "renders");
  mkdirSync(old, { recursive: true });
  mkdirSync(oldR, { recursive: true });
  writeFileSync(join(old, "scene-01.mp4"), "one");
  writeFileSync(join(old, "scene-02.mp4"), "two");
  writeFileSync(join(oldR, "v1.mp4"), "render");
  writeFileSync(join(root, "projects", "P", "ad", "plan.json"), JSON.stringify({ project: "P", sub: "ad", rev: 3, scenes: [{ n: 1, clip: join(old, "scene-01.mp4") }, { n: 2, clip: join(old, "scene-02.mp4") }] }));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "queue.json"), JSON.stringify([{ params: { output_dir: old, chain_file: join(old, "scene-01.mp4") }, files: [join(old, "scene-02.mp4")] }]));
  // An old handoff copy no code uses, and one the owner's composition uses.
  mkdirSync(join(root, "rm", "public", "P", "a"), { recursive: true });
  writeFileSync(join(root, "rm", "public", "P", "a", "a.mp4"), "one");
  mkdirSync(join(root, "rm", "public", "P", "b"), { recursive: true });
  writeFileSync(join(root, "rm", "public", "P", "b", "a.mp4"), "two");
  mkdirSync(join(root, "rm", "src"), { recursive: true });
  writeFileSync(join(root, "rm", "src", "Root.tsx"), 'staticFile("p/B/a.mp4")');
  const clips = join(root, "rm", "public", "P", "ad", "clips");
  const renders = join(root, "rm", "out", "P", "ad");
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, STUDIO_PROJECTS: join(root, "projects"), STUDIO_REMOTION: join(root, "rm"), STUDIO_QUEUE: join(root, "data", "queue.json"), FLOW_MCP_PORT: "1" },
  });
  const refs = () => {
    const plan = JSON.parse(readFileSync(join(root, "projects", "P", "ad", "plan.json"), "utf8"));
    const q = JSON.parse(readFileSync(join(root, "data", "queue.json"), "utf8"))[0];
    return { plan, refs: [...plan.scenes.map((s: { clip: string }) => s.clip), q.params.output_dir, q.params.chain_file, ...q.files] };
  };
  return { root, old, oldR, clips, renders, run, refs };
}

test("migration: dry by default, unknown arguments refused, --apply moves and rewrites, src-used letter folders stay", () => {
  const f = fixture();
  assert.equal(f.run("--yes").status, 2);
  const dry = f.run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  assert.ok(existsSync(join(f.old, "scene-01.mp4")) && !existsSync(f.clips));
  const r = f.run("--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.refs().refs, [join(f.clips, "scene-01.mp4"), join(f.clips, "scene-02.mp4"), f.clips, join(f.clips, "scene-01.mp4"), join(f.clips, "scene-02.mp4")]);
  assert.equal(f.refs().plan.rev, 4);
  assert.equal(readFileSync(join(f.renders, "v1.mp4"), "utf8"), "render");
  assert.ok(!existsSync(f.old) && !existsSync(f.oldR));
  assert.ok(!existsSync(join(f.root, "rm", "public", "P", "a", "a.mp4")), "unused identical copy deleted");
  assert.ok(existsSync(join(f.root, "rm", "public", "P", "b", "a.mp4")), "copy named in src/ kept (case-insensitive)");
});

test("migration: a re-run after an interruption between the moves and the JSON fixes every reference", () => {
  const f = fixture();
  // Interrupted run: the files reached their new home, the JSON was never rewritten, no journal.
  mkdirSync(f.clips, { recursive: true });
  mkdirSync(f.renders, { recursive: true });
  for (const n of ["scene-01.mp4", "scene-02.mp4"]) renameSync(join(f.old, n), join(f.clips, n));
  renameSync(join(f.oldR, "v1.mp4"), join(f.renders, "v1.mp4"));
  const r = f.run("--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.refs().refs, [join(f.clips, "scene-01.mp4"), join(f.clips, "scene-02.mp4"), f.clips, join(f.clips, "scene-01.mp4"), join(f.clips, "scene-02.mp4")]);
  // And once more: nothing left to change.
  const again = f.run("--apply");
  assert.match(again.stdout, /rewritten paths \(0\)/);
});
