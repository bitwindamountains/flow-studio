import test from "node:test";
import assert from "node:assert/strict";
import { MIN_VIDEO_COST, SwitchError, affordLoop, findSource, planSwitch, projectKey, type AffordIO } from "./switcher.js";
import { Requeue, type Job } from "./queue.js";
import type { Account } from "./accounts.js";

const now = new Date("2026-10-31T10:00:00");
const later = new Date("2026-11-01T04:59:00").toISOString();
const accts = (): Account[] => [
  { index: 0, email: "a@x.test", credits: 50 },
  { index: 1, email: "b@x.test", credits: 3 },
  { index: 2, email: "c@x.test", credits: 40 },
];

test("MIN_VIDEO_COST is the cheapest clip (Omni 1.1 Flash 4 s 360p)", () => assert.equal(MIN_VIDEO_COST, 4));
test("enough credits -> use", () => {
  assert.deepEqual(planSwitch("a@x.test", 50, 20, accts(), now), { action: "use" });
});
test("unreadable balance -> use (Flow itself still refuses a short account)", () => {
  assert.deepEqual(planSwitch("a@x.test", undefined, 20, accts(), now), { action: "use" });
});
test("short for this job only -> switch without marking", () => {
  const a = accts();
  assert.deepEqual(planSwitch("a@x.test", 10, 20, a, now), { action: "switch", to: a[2], mark: false });
});
test("below the cheapest clip -> switch and mark", () => {
  const a = accts();
  assert.deepEqual(planSwitch("a@x.test", 2, 20, a, now), { action: "switch", to: a[2], mark: true });
});
test("every account below the cheapest clip -> pause", () => {
  const a = accts().map((x) => ({ ...x, exhaustedUntil: x.index === 2 ? later : undefined }));
  assert.deepEqual(planSwitch("a@x.test", 2, 20, a, now), { action: "pause" });
});
test("too expensive for everyone but someone can still pay for cheaper jobs -> fail this job only", () => {
  assert.deepEqual(planSwitch("a@x.test", 10, 60, accts(), now), { action: "fail" });
  assert.deepEqual(planSwitch("a@x.test", 2, 60, accts(), now), { action: "fail" }); // c still has 40
});
test("skipped (signed-out) accounts are not picked", () => {
  const a = accts();
  assert.deepEqual(planSwitch("a@x.test", 2, 20, a, now, ["c@x.test"]), { action: "pause" });
});
test("active email undefined -> throws wrong-account error", () => {
  assert.throws(() => planSwitch(undefined, 50, 20, accts(), now), /Switched to the wrong account .*Nothing was generated\./);
});
test("projectKey: studio jobs per sub-project, others share _default", () => {
  assert.equal(projectKey("a@x.test", { project: "P", sub: "s" }), "a@x.test|P/s");
  assert.equal(projectKey("a@x.test"), "a@x.test|_default");
});

// A fake browser: `balances` is what each account's panel shows; moveTo can be told to fail for some emails.
function fakeIO(start: string, accounts: Account[], balances: Record<string, number>, opts: { cost?: number; signedOut?: string[] } = {}) {
  let at = start;
  const log = { moves: [] as string[], paused: [] as string[], saved: 0, restored: 0 };
  const io: AffordIO = {
    read: async () => ({ email: at, index: accounts.find((a) => a.email === at)!.index, credits: balances[at], refresh: "Credits refresh daily at 8:22 AM" }),
    discover: async () => accounts,
    reapply: async () => {},
    moveTo: async (a) => {
      log.moves.push(a.email);
      if (opts.signedOut?.includes(a.email)) throw new SwitchError(`acct ${a.index}`, undefined);
      at = a.email;
    },
    remember: () => {},
    restore: async () => { log.restored++; },
    cost: () => opts.cost ?? 20,
    save: () => { log.saved++; },
    pause: (r) => { log.paused.push(r); },
  };
  return { io, log };
}
const job = (extra: Partial<Job["params"]> = {}): Job => ({
  id: "j", status: "running", files: [], attempts: 1, createdAt: "", params: { prompt: "p", type: "video", max_credits: 100, output_dir: "o", file_stem: "s", ...extra },
});

test("affordLoop: short for this job hops to the next account and leaves the first unmarked", async () => {
  const a = accts();
  const { io, log } = fakeIO("a@x.test", a, { "a@x.test": 10, "c@x.test": 40 });
  const j = job();
  const used = await affordLoop(io, j, a, () => now);
  assert.equal(used?.email, "c@x.test");
  assert.deepEqual(log.moves, ["c@x.test"]);
  assert.equal(a[0].exhaustedUntil, undefined);
  assert.equal(a[0].credits, 10);
  assert.equal(a[0].refreshTime, "8:22 AM");
  assert.match(j.note!, /acct 0 short of 20 credits → acct 2/);
});
test("affordLoop: an account below the cheapest clip is marked until its refresh time", async () => {
  const a = accts();
  const { io } = fakeIO("a@x.test", a, { "a@x.test": 0, "c@x.test": 40 });
  const j = job();
  await affordLoop(io, j, a, () => now);
  assert.equal(a[0].exhaustedUntil, new Date("2026-11-01T08:22:00").toISOString());
  assert.match(j.note!, /acct 0 out of credits → acct 2/);
});
test("affordLoop: every account low -> pause and Requeue, nothing moved", async () => {
  const a = accts().map((x) => ({ ...x, credits: 1 }));
  const { io, log } = fakeIO("a@x.test", a, { "a@x.test": 1 });
  await assert.rejects(affordLoop(io, job(), a, () => now), (e) => e instanceof Requeue && /All accounts are out of credits\. Earliest refresh: /.test(e.message));
  assert.equal(log.paused.length, 1);
  assert.deepEqual(log.moves, []);
});
test("affordLoop: too expensive for everyone -> this job fails, queue not paused, nobody marked", async () => {
  const a = accts();
  const { io, log } = fakeIO("a@x.test", a, { "a@x.test": 10 }, { cost: 60 });
  await assert.rejects(affordLoop(io, job(), a, () => now), (e) => !(e instanceof Requeue) && /No signed-in account has 60 credits for this scene\. Nothing was generated\./.test((e as Error).message));
  assert.deepEqual(log.paused, []);
  assert.ok(a.every((x) => !x.exhaustedUntil));
});
test("affordLoop: a scene with Flow characters refuses to move and marks nobody", async () => {
  const a = accts();
  const { io, log } = fakeIO("a@x.test", a, { "a@x.test": 0 });
  await assert.rejects(affordLoop(io, job({ reference_images: ["asset:Pip"] }), a, () => now), /uses Flow characters from acct 0; it can't move to another account/);
  assert.deepEqual(log.moves, []);
  assert.equal(a[0].exhaustedUntil, undefined);
});
test("affordLoop: a target that is signed out is skipped for the next eligible account", async () => {
  const a: Account[] = [...accts(), { index: 3, email: "d@x.test", credits: 30 }];
  const { io, log } = fakeIO("a@x.test", a, { "a@x.test": 10, "d@x.test": 30 }, { signedOut: ["c@x.test"] });
  const used = await affordLoop(io, job(), a, () => now);
  assert.deepEqual(log.moves, ["c@x.test", "d@x.test"]);
  assert.equal(used?.email, "d@x.test");
});

const done = (dir: string, stem: string, account: string, flowProject: string): Job => ({
  ...job({ output_dir: dir, file_stem: stem }), status: "done", flow: { account, flowProject },
});
test("findSource: finds the job that made the clip, refuses unknown and ambiguous sources", () => {
  const jobs = [done("C:/out/Ascent", "scene-01", "aaa", "/project/1"), done("C:/out/Ascent", "scene-02", "bbb", "/project/2")];
  assert.deepEqual(findSource(jobs, "Ascent-scene-01"), { account: "aaa", flowProject: "/project/1" });
  assert.deepEqual(findSource(jobs, "Ascent-scene-02-v2"), { account: "bbb", flowProject: "/project/2" });
  assert.throws(() => findSource(jobs, "Someone else's clip"), /does not know which Google account holds .*Nothing was generated\./);
  assert.throws(() => findSource(jobs, "Ascent-scene"), /more than one Flow account/);
});
