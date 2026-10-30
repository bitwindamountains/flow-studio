import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickAccount, earliestRefresh, markExhausted, loadAccounts, saveAccounts, type Account } from "./accounts.js";
import { readJson, writeJsonAtomic } from "./persist.js";

const now = new Date("2026-10-31T10:00:00");
const future = new Date("2026-11-01T00:00:00").toISOString();
const past = new Date("2026-10-30T00:00:00").toISOString();

test("pickAccount skips exhausted and too-poor accounts", () => {
  const a: Account[] = [{ index: 0, email: "a", credits: 5 }, { index: 1, email: "b", exhaustedUntil: future }, { index: 2, email: "c", credits: 20 }];
  assert.equal(pickAccount(a, 12, now)?.index, 2);
});
test("pickAccount returns undefined when all exhausted", () => {
  assert.equal(pickAccount([{ index: 0, email: "a", exhaustedUntil: future }], 1, now), undefined);
});
test("past exhaustedUntil is eligible; unknown credits is eligible", () => {
  assert.equal(pickAccount([{ index: 0, email: "a", exhaustedUntil: past }], 99, now)?.index, 0);
});
test("earliestRefresh returns the soonest exhaustedUntil", () => {
  const soon = new Date("2026-10-31T12:00:00").toISOString();
  const a: Account[] = [{ index: 0, email: "a", exhaustedUntil: future }, { index: 1, email: "b", exhaustedUntil: soon }, { index: 2, email: "c" }];
  assert.equal(earliestRefresh(a, now)?.toISOString(), soon);
  assert.equal(earliestRefresh([{ index: 0, email: "a" }], now), undefined);
});
test("markExhausted sets next local midnight", () => {
  const a: Account = { index: 0, email: "a" };
  markExhausted(a, now);
  assert.equal(a.exhaustedUntil, new Date("2026-11-01T00:00:00").toISOString());
});
test("writeJsonAtomic then readJson round-trips; missing file returns fallback", () => {
  const d = mkdtempSync(join(tmpdir(), "acc-"));
  try {
    const f = join(d, "x.json");
    assert.deepEqual(readJson(f, { n: 0 }), { n: 0 });
    writeJsonAtomic(f, { n: 5 });
    assert.deepEqual(readJson(f, { n: 0 }), { n: 5 });
    saveAccounts(f, [{ index: 0, email: "a" }]);
    assert.equal(loadAccounts(f)[0].email, "a");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
