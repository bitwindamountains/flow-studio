import type { Page } from "playwright-core";

// Identity must come from account UI, never a URL index, credit balance or cached account.
export function accountEmail(label: string | null | undefined): string | undefined {
  const clean = label?.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const emails = [...new Set(clean?.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi)?.map(email => email.toLowerCase()))];
  return emails.length === 1 ? emails[0] : undefined;
}

export async function readAccountBadge(page: Page, timeout = 2000): Promise<string | undefined> {
  const label = await page.getByRole("button", { name: /Google\s+Account\b/i }).first()
    .getAttribute("aria-label", { timeout }).catch(() => null);
  return accountEmail(label);
}

// Only inspect the open account panel. Reading the page text could mistake an email in a
// prompt or another account's project title for the current identity.
export async function readPanelIdentity(page: Page): Promise<string | undefined> {
  const text = await page.getByRole("link", { name: /Google Flow credits/ }).first().evaluate(link => {
    let panel = link.parentElement;
    while (panel && panel !== document.body && !panel.querySelector('[aria-label="Close account panel"]')) panel = panel.parentElement;
    if (!panel || panel === document.body || panel === document.documentElement || panel.matches("main,app-root,flow-app") ||
      panel.querySelector('.ProseMirror,flow-grid-tile-container,.page-container,main')) return null;
    return panel.innerText;
  }).catch(() => null);
  return accountEmail(text);
}
