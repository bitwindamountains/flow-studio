// Startup health check: is Flow signed in and does its UI still match what the engine expects?
import type { Page } from "playwright-core";
import { peekFlowPage } from "./chrome.js";
import { readCredits } from "./flow.js";
import { activeAccount } from "./switcher.js";

export interface Check { name: string; ok: boolean; hint?: string }
export interface Health { ok: boolean; checks: Check[] }

const REMAP = "Ask Claude to re-map it (docs/flow-account-map.md).";
const TIMEOUT = 5000;

export const formatHealth = (checks: Check[]): string =>
  checks.filter((c) => !c.ok).map((c) => (c.hint ? `${c.name}: ${c.hint}` : c.name)).join("; ");

const within = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT))]);

async function run(name: string, hint: string, fn: () => Promise<boolean>): Promise<Check> {
  const ok = await within(fn()).catch(() => false);
  return ok ? { name, ok } : { name, ok, hint };
}

let inflight: Promise<Health> | undefined;

// Concurrent callers share one run. Never navigates; the only UI it touches is the account panel (opened, then closed with Escape).
// `whileIdle` runs the panel-opening credits read only when no job is running (and holds job starts meanwhile); it
// resolves undefined when it declined. Without a queue to ask, the step is skipped.
export type WhileIdle = (fn: () => Promise<boolean>) => Promise<boolean | undefined>;
export function checkFlow(page: Page, whileIdle?: WhileIdle, read: (p: Page) => Promise<number | undefined> = readCredits): Promise<Health> {
  return (inflight ??= (async () => {
    const checks: Check[] = [];
    checks.push(await run("signed in", "Flow isn't signed in. Sign in to Google in the Flow window.", async () => !!(await activeAccount(page))));
    checks.push(await run("account switcher", `Flow's account menu wasn't found - Flow may have changed. ${REMAP}`,
      () => page.getByRole("button", { name: "Account details" }).first().isVisible()));
    if (page.url().includes("/project/")) {
      checks.push(await run("composer", `Flow's prompt box wasn't found - Flow may have changed. ${REMAP}`,
        async () => (await page.locator(".ProseMirror").count()) > 0));
      checks.push(await run("settings", `Flow's settings button wasn't found - Flow may have changed. ${REMAP}`,
        () => page.getByRole("button", { name: "Settings trigger" }).first().isVisible()));
    } else {
      for (const name of ["composer", "settings"]) checks.push({ name, ok: true, hint: "not checked (no project open)" });
    }
    // Awaited without within(): readAccountPanel has its own timeouts, and a second panel read must never overlap it.
    // It may click overlay backdrops (dismissOverlays) but never clicks inside the account panel (Sign out lives there).
    const credits = await (whileIdle?.(async () => (await read(page)) !== undefined).catch(() => false) ?? Promise.resolve(undefined));
    checks.push(credits === undefined
      ? { name: "credits readable", ok: true, hint: "not checked (job running)" }
      : credits ? { name: "credits readable", ok: true }
      : { name: "credits readable", ok: false, hint: `Flow's credit balance couldn't be read - Flow may have changed. ${REMAP}` });
    return { ok: checks.every((c) => c.ok), checks };
  })().finally(() => { inflight = undefined; }));
}

// Never launches the browser: before the first job there is nothing to check.
export async function flowHealth(whileIdle?: WhileIdle): Promise<Health> {
  const page = await peekFlowPage();
  if (!page) return { ok: false, checks: [{ name: "flow", ok: false, hint: "Flow isn't open yet - it opens with the first job." }] };
  return checkFlow(page, whileIdle);
}
