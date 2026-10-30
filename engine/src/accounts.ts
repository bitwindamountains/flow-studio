import { readJson, writeJsonAtomic } from "./persist.js";

export type Account = { index: number; email: string; credits?: number; checkedAt?: string; exhaustedUntil?: string };

export const loadAccounts = (file: string): Account[] => readJson<Account[]>(file, []);
export const saveAccounts = (file: string, a: Account[]): void => writeJsonAtomic(file, a);

const blocked = (a: Account, now: Date) => !!a.exhaustedUntil && new Date(a.exhaustedUntil) > now;

export function pickAccount(accounts: Account[], cost: number, now: Date): Account | undefined {
  return [...accounts].sort((x, y) => x.index - y.index)
    .find((a) => !blocked(a, now) && (a.credits === undefined || a.credits >= cost));
}

// ponytail: assumes the daily reset is at local midnight; correct from Flow's account panel if Task 2 found the real reset time.
export function markExhausted(a: Account, now: Date): void {
  a.exhaustedUntil = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}

export function earliestRefresh(accounts: Account[], now: Date): Date | undefined {
  const t = accounts.filter((a) => blocked(a, now)).map((a) => new Date(a.exhaustedUntil!).getTime());
  return t.length ? new Date(Math.min(...t)) : undefined;
}
