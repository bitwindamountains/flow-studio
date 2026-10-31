import { readJson, writeJsonAtomic } from "./persist.js";

// Keyed by email; `index` is only a cache of the /u/<n>/ slot (it shifts when accounts are added or removed).
// `refreshTime` is Flow's own "Credits refresh daily at <h:mm AM/PM>", different per account.
export type Account = { index: number; email: string; credits?: number; checkedAt?: string; exhaustedUntil?: string; refreshTime?: string };

export const loadAccounts = (file: string): Account[] => readJson<Account[]>(file, []);
export const saveAccounts = (file: string, a: Account[]): void => writeJsonAtomic(file, a);

const blocked = (a: Account, now: Date) => !!a.exhaustedUntil && new Date(a.exhaustedUntil) > now;

export function pickAccount(accounts: Account[], cost: number, now: Date): Account | undefined {
  return [...accounts].sort((x, y) => x.index - y.index)
    .find((a) => !blocked(a, now) && (a.credits === undefined || a.credits >= cost));
}

// "Credits refresh daily at 4:59 AM" -> "4:59 AM". Flow may use a narrow no-break space before AM/PM.
export function parseRefreshTime(text: string): string | undefined {
  const m = text.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  return m ? `${Number(m[1])}:${m[2]} ${m[3].toUpperCase()}` : undefined;
}

// The next local moment the clock reads `time` ("h:mm AM/PM"), strictly after `now`.
export function nextRefresh(time: string, now: Date): Date | undefined {
  const m = time.match(/^(\d{1,2}):(\d{2}) ([AP]M)$/);
  if (!m) return undefined;
  const h = (Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, Number(m[2]));
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

// Blocks the account until its own refresh time; without one, until local midnight.
export function markExhausted(a: Account, now: Date): void {
  const at = a.refreshTime && nextRefresh(a.refreshTime, now);
  a.exhaustedUntil = (at || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)).toISOString();
}

export function earliestRefresh(accounts: Account[], now: Date): Date | undefined {
  const t = accounts.filter((a) => blocked(a, now)).map((a) => new Date(a.exhaustedUntil!).getTime());
  return t.length ? new Date(Math.min(...t)) : undefined;
}

// Discovery result wins for what Flow shows now; exhaustedUntil is ours and survives. Accounts no longer signed in are dropped.
export function mergeAccounts(old: Account[], found: Account[]): Account[] {
  return found
    .map((f) => {
      const was = old.find((o) => o.email === f.email);
      return was?.exhaustedUntil ? { ...f, exhaustedUntil: was.exhaustedUntil } : { ...f };
    })
    .sort((x, y) => x.index - y.index);
}
