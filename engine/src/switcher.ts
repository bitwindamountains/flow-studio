// Switches between the owner's signed-in Google accounts when Flow credits run short. Live map: docs/flow-account-map.md.
// Accounts are keyed by email; the /u/<n>/ index is a cache that is re-verified after every switch.
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { Page } from "playwright-core";
import { HOME_DIR, inEnglish } from "./chrome.js";
import { applySettings, ensureProjectGrid, readAccountPanel } from "./flow.js";
import { earliestRefresh, isBlocked, loadAccounts, markExhausted, mergeAccounts, parseRefreshTime, pickAccount, saveAccounts, type Account } from "./accounts.js";
import { readJson, writeJsonAtomic } from "./persist.js";
import { Requeue, type FlowLocation, type Job, type JobQueue } from "./queue.js";

export const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
export const FLOW_PROJECTS_FILE = join(HOME_DIR, "flow-projects.json");
// SWITCH_METHOD (Task 2): the path form /u/<n>/, not ?authuser= and not the in-page chooser.
const FLOW = "https://flow.google.com";
const MAX_ACCOUNTS = 10; // Google's limit on accounts signed in at once
// The cheapest paid clip (Omni 1.1 Flash, 4 s, 360p). Below it an account can pay for nothing until it refreshes.
export const MIN_VIDEO_COST = 4;
// Test-only: run the check for (free) image jobs too, trust the STORED balance and count the cost as at least 1, so a
// stored 0 forces a switch without spending anything.
const FORCE = () => process.env.FLOW_MCP_FORCE_SWITCH === "1";

// Errors can reach Claude (flow_status), so an email is only ever shown masked.
const mask = (email?: string) => (email ? `${email.slice(0, 2)}***` : "no account");
// `shown` is the email Flow showed instead (undefined: signed out, or a sign-in page).
export class SwitchError extends Error {
  constructor(expected: string, readonly shown?: string) {
    super(`Switched to the wrong account (expected ${expected}, Flow shows ${mask(shown)}). Nothing was generated.`);
  }
}

// Plans and job links name an account by this, so the email itself never lands in files Claude can read.
export const accountId = (email: string) => createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);

export type SwitchPlan =
  | { action: "use" }
  | { action: "switch"; to: Account; mark: boolean }
  | { action: "pause" }
  | { action: "fail" };

// Pure decision. An unreadable balance means "use": Flow itself still refuses to start a job it cannot pay for.
// Short for THIS job only (credits >= MIN_VIDEO_COST) is not exhaustion: the account stays usable for cheaper jobs.
// `skip` holds accounts found signed out during this run.
export function planSwitch(
  activeEmail: string | undefined, credits: number | undefined, cost: number, accounts: Account[], now: Date, skip: string[] = [],
): SwitchPlan {
  if (!activeEmail) throw new SwitchError("a signed-in account", undefined);
  if (credits === undefined || credits >= cost) return { action: "use" };
  const mark = credits < MIN_VIDEO_COST;
  const to = pickAccount(accounts.filter((a) => a.email !== activeEmail && !skip.includes(a.email)), cost, now);
  if (to) return { action: "switch", to, mark };
  const low = (a: Account) =>
    skip.includes(a.email) || isBlocked(a, now) || (a.email === activeEmail ? credits : (a.credits ?? Infinity)) < MIN_VIDEO_COST;
  return mark && accounts.every(low) ? { action: "pause" } : { action: "fail" };
}

export const projectKey = (email: string, studio?: { project: string; sub: string }) =>
  `${email}|${studio ? `${studio.project}/${studio.sub}` : "_default"}`;

const indexOf = (url: string) => Number(new URL(url).pathname.match(/^\/u\/(\d+)(\/|$)/)?.[1] ?? 0);
const projectPath = (url: string) => new URL(url).pathname.match(/\/project\/[0-9a-f-]{36}/)?.[0];

export async function activeAccount(page: Page): Promise<string | undefined> {
  if (!/^https:\/\/flow\.google\.com\//.test(page.url()) || /\/about/.test(page.url())) return undefined;
  const label = await page.getByRole("button", { name: /Google Account:/ }).first().getAttribute("aria-label", { timeout: 8000 }).catch(() => null);
  return label?.match(/\(([^()\s]+@[^()\s]+)\)/)?.[1];
}

async function open(page: Page, n: number, path = "/"): Promise<void> {
  await page.goto(inEnglish(`${FLOW}/u/${n}${path}`), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Account details" }).waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

export async function switchTo(page: Page, a: Account, path = "/"): Promise<void> {
  await open(page, a.index, path);
  const shown = await activeAccount(page);
  // An index past the last signed-in account silently lands on /u/0/.
  if (indexOf(page.url()) !== a.index || shown !== a.email) throw new SwitchError(`acct ${a.index} (${mask(a.email)})`, shown);
}

// Walks /u/0/, /u/1/ ... until Flow redirects back to /u/0/, reading each account's email, balance and refresh time.
// Read-only: the account panel is only opened and closed (it also holds "Sign out of all accounts").
export async function discoverAccounts(page: Page, file = ACCOUNTS_FILE): Promise<Account[]> {
  const back = page.url();
  const found: Account[] = [];
  try {
    for (let n = 0; n < MAX_ACCOUNTS; n++) {
      await open(page, n);
      if (indexOf(page.url()) !== n) break;
      const email = await activeAccount(page);
      if (!email) break;
      const { credits, refresh } = await readAccountPanel(page).catch(() => ({ credits: undefined, refresh: undefined }));
      found.push({ index: n, email, credits, refreshTime: refresh && parseRefreshTime(refresh), checkedAt: new Date().toISOString() });
    }
  } finally {
    if (/^https:\/\/flow\.google\.com\//.test(back)) await page.goto(inEnglish(back), { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  const merged = mergeAccounts(loadAccounts(file), found);
  saveAccounts(file, merged);
  return merged;
}

// Flow projects belong to one account (another /u/<n>/ gets a 404), so each account keeps its own project per
// studio sub-project, stored as "/project/<id>" under "<email>|<project>/<sub>" (or "<email>|_default").
function rememberProject(page: Page, email: string, job: Job): void {
  const path = projectPath(page.url());
  const map = readJson<Record<string, string>>(FLOW_PROJECTS_FILE, {});
  const key = projectKey(email, job.params.studio);
  if (path && map[key] !== path) writeJsonAtomic(FLOW_PROJECTS_FILE, { ...map, [key]: path });
}

async function openProjectFor(page: Page, a: Account, job: Job): Promise<void> {
  const known = readJson<Record<string, string>>(FLOW_PROJECTS_FILE, {})[projectKey(a.email, job.params.studio)];
  if (known) {
    await switchTo(page, a, known);
    if (projectPath(page.url()) === known) return;
  }
  await switchTo(page, a); // the account's Flow home
  await page.getByRole("button", { name: "New project" }).click({ timeout: 10_000 });
  await page.waitForURL((u) => /\/project\/[0-9a-f-]{36}/.test(u.pathname), { timeout: 30_000 });
  if (indexOf(page.url()) !== a.index) throw new SwitchError(`acct ${a.index} (${mask(a.email)})`, await activeAccount(page));
  rememberProject(page, a.email, job);
}

// Back on a (possibly new) project page: same settings, fresh quote.
async function reapply(page: Page, job: Job): Promise<void> {
  await ensureProjectGrid(page);
  job.credits = await applySettings(page, job);
  if (job.credits > job.params.max_credits) {
    throw new Error(`Flow quotes ${job.credits} credits for this scene, above max_credits=${job.params.max_credits}. Nothing was generated.`);
  }
}

const when = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

// Characters and other "asset:" media live in one Flow project, so such a scene cannot move to another account.
const usesFlowAssets = (p: Job["params"]) =>
  [p.first_frame, p.last_frame, ...(p.reference_images ?? []), ...(p.attach ?? [])].some((r) => r?.startsWith("asset:"));

// Everything the hop loop needs from the browser, so the loop itself can be tested with a fake.
export interface AffordIO {
  read(): Promise<{ email?: string; index: number; credits?: number; refresh?: string }>;
  discover(): Promise<Account[]>; // re-walks the accounts and comes back to the current page
  reapply(): Promise<void>; // re-applies the job's settings on the current page (fresh quote)
  moveTo(a: Account): Promise<void>; // that account's Flow project for this job, settings re-applied; throws SwitchError
  remember(email: string): void; // records the current page as `email`'s project for this job
  restore(): Promise<void>; // back to the page the job started on
  cost(): number;
  save(a: Account[]): void;
  pause(reason: string): void;
}

// Reads the active account, decides, and switches until one can pay. An account is marked exhausted only when it is
// below MIN_VIDEO_COST. With every account that low the queue pauses and the job goes back to "queued"; when this
// job is simply too expensive for every account, only this job fails.
export async function affordLoop(io: AffordIO, job: Job, accounts: Account[], now = () => new Date()): Promise<Account | undefined> {
  const skip: string[] = [];
  let rediscovered = false;
  let moved = false;
  const giveUp = async (plan: SwitchPlan, cost: number, t: Date): Promise<never> => {
    if (moved) await io.restore();
    if (plan.action === "pause") {
      const r = earliestRefresh(accounts, t);
      const reason = `All accounts are out of credits. Earliest refresh: ${r ? when(r) : "unknown"}.`;
      io.pause(reason);
      throw new Requeue(reason);
    }
    throw new Error(`No signed-in account has ${cost} credits for this scene. Nothing was generated.`);
  };
  for (let hop = 0; hop <= MAX_ACCOUNTS; hop++) {
    const st = await io.read();
    let active = accounts.find((a) => a.email === st.email);
    if (st.email && (!active || active.index !== st.index) && !rediscovered) {
      accounts = await io.discover();
      await io.reapply();
      rediscovered = true;
      active = accounts.find((a) => a.email === st.email);
    }
    const t = now();
    if (active) {
      if (st.credits !== undefined) Object.assign(active, { credits: st.credits, checkedAt: t.toISOString() });
      const rt = st.refresh && parseRefreshTime(st.refresh);
      if (rt) active.refreshTime = rt;
    }
    const cost = io.cost();
    let plan = planSwitch(st.email, st.credits, cost, accounts, t, skip);
    if (plan.action === "use") {
      io.save(accounts);
      return active;
    }
    if (plan.action === "switch" && usesFlowAssets(job.params)) {
      io.save(accounts);
      throw new Error(`This scene uses Flow characters from acct ${active?.index ?? st.index}; it can't move to another account. Nothing was generated.`);
    }
    if (active && st.credits !== undefined && st.credits < MIN_VIDEO_COST) markExhausted(active, t);
    io.save(accounts);
    if (plan.action !== "switch") return giveUp(plan, cost, t);
    const why = plan.mark ? "out of credits" : `short of ${cost} credits`;
    io.remember(st.email!);
    while (plan.action === "switch") {
      const to: Account = plan.to;
      moved = true;
      try {
        await io.moveTo(to);
        job.note = [job.note, `acct ${active?.index ?? st.index} ${why} → acct ${to.index}`].filter(Boolean).join(" · ");
        break;
      } catch (e) {
        if (!(e instanceof SwitchError)) throw e;
        // Another account showed up: the list moved (an account added or removed), so find the email's new slot once.
        if (e.shown && !rediscovered) {
          rediscovered = true;
          accounts = await io.discover();
          const again = accounts.find((a) => a.email === to.email);
          if (again) { plan = { action: "switch", to: again, mark: false }; continue; }
        }
        skip.push(to.email); // signed out or gone: re-plan to the next eligible account
        plan = planSwitch(st.email, st.credits, cost, accounts, t, skip);
      }
    }
    if (plan.action !== "switch") return giveUp(plan, cost, t);
  }
  throw new Error("Account switching went round in circles; nothing was generated.");
}

// Called after the cost is quoted and before Start generation (see runGeneration's `afford`).
export async function ensureAffordable(page: Page, job: Job, file: string, queue: JobQueue): Promise<Account | undefined> {
  if (job.params.type === "image" && !FORCE()) return undefined;
  const origin = page.url();
  const io: AffordIO = {
    read: async () => {
      const email = await activeAccount(page);
      const panel = FORCE()
        ? { credits: loadAccounts(file).find((a) => a.email === email)?.credits, refresh: undefined }
        : await readAccountPanel(page).catch(() => ({ credits: undefined, refresh: undefined }));
      return { email, index: indexOf(page.url()), ...panel };
    },
    discover: () => discoverAccounts(page, file),
    reapply: () => reapply(page, job),
    moveTo: async (a) => {
      await openProjectFor(page, a, job);
      await reapply(page, job);
    },
    remember: (email) => rememberProject(page, email, job),
    restore: async () => { await page.goto(inEnglish(origin), { waitUntil: "domcontentloaded" }).catch(() => {}); },
    cost: () => (FORCE() ? Math.max(job.credits ?? 0, 1) : (job.credits ?? 0)),
    save: (a) => saveAccounts(file, a),
    pause: (r) => queue.pause(r),
  };
  return affordLoop(io, job, loadAccounts(file));
}

// Where the page is now, recorded on every finished job.
export async function currentLocation(page: Page): Promise<FlowLocation | undefined> {
  const email = await activeAccount(page);
  const flowProject = projectPath(page.url());
  return email && flowProject ? { account: accountId(email), flowProject } : undefined;
}

// The finished job that made `asset` (runGeneration renames tiles to "<folder>-<file stem>"), and where it sits.
// Unknown or ambiguous sources are refused: an edit must never land on a same-named clip in another account.
export function findSource(jobs: Job[], asset: string): FlowLocation {
  const a = asset.toLowerCase();
  const hits = jobs.filter((j) => {
    if (j.status !== "done" || !j.flow) return false;
    const t = `${basename(j.params.output_dir)}-${j.params.file_stem}`.toLowerCase();
    return a === t || a.startsWith(`${t}-v`) || t.startsWith(a);
  });
  const places = new Set(hits.map((j) => `${j.flow!.account}|${j.flow!.flowProject}`));
  if (!places.size) {
    throw new Error(
      `Flow Studio does not know which Google account holds "${asset}" (it only tracks media it generated itself), so it will not touch it: ` +
        `the same title could exist in another account and the credits would be spent there. Nothing was generated.`,
    );
  }
  if (places.size > 1) throw new Error(`"${asset}" matches media in more than one Flow account or project; give its full title. Nothing was generated.`);
  return hits[0].flow!;
}

const SOURCE_GONE =
  "The Google account that holds this clip is not signed in to Flow any more. Sign it in again in the studio's browser window, then retry. Nothing was generated.";

// Opens the account and project that hold an edit's or continue's source clip, before anything is spent.
export async function goToSource(page: Page, loc: FlowLocation, file = ACCOUNTS_FILE): Promise<void> {
  const find = (list: Account[]) => list.find((x) => accountId(x.email) === loc.account);
  let a = find(loadAccounts(file)) ?? find(await discoverAccounts(page, file));
  if (!a) throw new Error(SOURCE_GONE);
  try {
    await switchTo(page, a, loc.flowProject);
  } catch (e) {
    if (!(e instanceof SwitchError)) throw e;
    a = find(await discoverAccounts(page, file)); // its slot may have moved
    if (!a) throw new Error(SOURCE_GONE);
    await switchTo(page, a, loc.flowProject).catch((err) => { throw err instanceof SwitchError ? new Error(SOURCE_GONE) : err; });
  }
  if (projectPath(page.url()) !== loc.flowProject) throw new Error(`The Flow project that holds this clip did not open in acct ${a.index}. Nothing was generated.`);
}
