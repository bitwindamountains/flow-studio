import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHealth } from "./health.js";

test("formatHealth lists only failed checks with their hints", () => {
  const s = formatHealth([
    { name: "signed in", ok: true },
    { name: "composer", ok: false, hint: "no composer" },
    { name: "settings", ok: false },
    { name: "credits readable", ok: true, hint: "not checked" },
  ]);
  assert.equal(s, "composer: no composer; settings");
  assert.equal(formatHealth([{ name: "a", ok: true }]), "");
});
