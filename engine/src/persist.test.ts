import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, writeJsonAtomic } from "./persist.js";

const dir = () => mkdtempSync(join(tmpdir(), "fm-persist-"));

test("readJson: missing file gives fallback, corrupt file throws naming it", () => {
  const d = dir();
  assert.deepEqual(readJson(join(d, "none.json"), [1]), [1]);
  const bad = join(d, "bad.json");
  writeFileSync(bad, "{oops");
  assert.throws(() => readJson(bad, []), /bad\.json/);
});

test("writeJsonAtomic creates a missing directory", () => {
  const f = join(dir(), "a", "b", "x.json");
  writeJsonAtomic(f, { ok: 1 });
  assert.deepEqual(readJson(f, null), { ok: 1 });
});
