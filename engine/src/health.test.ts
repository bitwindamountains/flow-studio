import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow, formatHealth } from "./health.js";

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

test("busy queue: the credits step never reads the panel", async () => {
  let reads = 0;
  const page = {
    url: () => "https://flow.google.com/u/0/",
    getByRole: () => ({ first: () => ({ getAttribute: async () => "Google Account: A (a@b.co)", isVisible: async () => true }) }),
  } as never;
  const h = await checkFlow(page, async () => undefined, async () => { reads++; return 5; });
  assert.equal(reads, 0);
  assert.equal(h.ok, true);
  assert.equal(h.checks.at(-1)?.hint, "not checked (job running)");
  const h2 = await checkFlow(page, (fn) => fn(), async () => { reads++; return 5; });
  assert.equal(reads, 1);
  assert.equal(h2.checks.at(-1)?.hint, undefined);
});
