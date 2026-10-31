// Switches between the owner's signed-in Google accounts when Flow credits run short. Live map: docs/flow-account-map.md.
// Accounts are keyed by email; the /u/<n>/ index is a cache that is re-verified after every switch.
import { join } from "node:path";
import type { Page } from "playwright-core";
import { HOME_DIR, inEnglish } from "./chrome.js";
import { applySettings, ensureProjectGrid, readAccountPanel, readCredits } from "./flow.js";
import { earliestRefresh, loadAccounts, markExhausted, mergeAccounts, parseRefreshTime, pickAccount, saveAccounts, type Account } from "./accounts.js";
import { readJson, writeJsonAtomic } from "./persist.js";
import { Requeue, type Job, type JobQueue } from "./queue.js";

export const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
export const FLOW_PROJECTS_FILE = join(HOME_DIR, "flow-projects.json");
// SWITCH_METHOD (Task 2): the path form /u/<n>/, not ?authuser= and not the in-page chooser.
const FLOW = "https://flow.google.com";
const MAX_ACCOUNTS = 10; // Google's limit on accounts signed in at once
// Test-only: run the check for (free) image jobs too, trust the STORED balance and count the cost as at least 1, so a
// stored 0 forces a switch without spending anything.
const FORCE = () => process.env.FLOW_MCP_FORCE_SWITCH === "1";

// Errors can reach Claude (flow_status), so an email is only ever shown masked.
const mask = (email?: string) => (email ? `${email.slice(0, 2)}***` : "no account");
const wrongAccount = (expected: string, shown?: string) =>
  new Error(`Switched to the wrong account (expected ${expected}, Flow shows ${mask(shown)}). Nothing was generated.`);
const isWrongAccount = (e: unknown) => e instanceof Error && e.message.startsWith("Switched to the wrong account");

export type SwitchPlan = { action: "use" } | { action: "switch"; to: Account } | { action: "pause" };

// Pure decision. An unreadable balance means "use": Flow itself still refuses to start a job it cannot pay for.
export function planSwitch(activeEmail: string | undefined, credits: number | undefined, cost: number, accounts: Account[], now: Date): SwitchPlan {
  if (!activeEmail) throw wrongAccount("a signed-in account", undefined);
  if (credits === undefined || credits >= cost) return { action: "use" };
  const to = pickAccount(accounts.filter((a) => a.email !== activeEmail), cost, now);
  return to ? { action: "switch", to } : { action: "pause" };
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
  if (indexOf(page.url()) !== a.index || shown !== a.email) throw wrongAccount(`acct ${a.index} (${mask(a.email)})`, shown);
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
  if (indexOf(page.url()) !== a.index) throw wrongAccount(`acct ${a.index} (${mask(a.email)})`, await activeAccount(page));
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

// Called after the cost is quoted and before Start generation. Switches account (and project) until one can pay;
// with none left it pauses the queue and hands the job back as "queued".
export async function ensureAffordable(page: Page, job: Job, file: string, queue: JobQueue): Promise<Account | undefined> {
  if (job.params.type === "image" && !FORCE()) return undefined;
  let accounts = loadAccounts(file);
  for (let hop = 0; hop <= MAX_ACCOUNTS; hop++) {
    const email = await activeAccount(page);
    let active = accounts.find((a) => a.email === email);
    if (email && (!active || active.index !== indexOf(page.url()))) {
      accounts = await discoverAccounts(page, file); // returns to this project page
      await reapply(page, job);
      active = accounts.find((a) => a.email === email);
    }
    const now = new Date();
    const cost = FORCE() ? Math.max(job.credits ?? 0, 1) : (job.credits ?? 0);
    const credits = FORCE() ? active?.credits : await readCredits(page).catch(() => undefined);
    if (active && credits !== undefined) Object.assign(active, { credits, checkedAt: now.toISOString() });
    const plan = planSwitch(email, credits, cost, accounts, now);
    if (plan.action === "use") {
      saveAccounts(file, accounts);
      return active;
    }
    if (active) markExhausted(active, now);
    saveAccounts(file, accounts);
    if (plan.action === "pause") {
      const t = earliestRefresh(accounts, now);
      const reason = `All accounts are out of credits. Earliest refresh: ${t ? when(t) : "unknown"}.`;
      queue.pause(reason);
      throw new Requeue(reason);
    }
    rememberProject(page, email!, job);
    let to = plan.to;
    try {
      await openProjectFor(page, to, job);
    } catch (e) {
      if (!isWrongAccount(e)) throw e;
      // The account list moved (an account added or removed): find the email's new slot once.
      accounts = await discoverAccounts(page, file);
      const moved = accounts.find((a) => a.email === to.email);
      if (!moved) throw e;
      to = moved;
      await openProjectFor(page, to, job);
    }
    await reapply(page, job);
    job.note = [job.note, `acct ${active?.index ?? "?"} out of credits → acct ${to.index}`].filter(Boolean).join(" · ");
  }
  throw new Error("Account switching went round in circles; nothing was generated.");
}
