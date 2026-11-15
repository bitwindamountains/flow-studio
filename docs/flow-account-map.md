# Flow account switching — live map (2026-10-31)

Mapped live in the studio Brave profile (`data/chrome-profile`, CDP 9333) with several accounts signed in. Probe: `engine/scripts/probe-accounts.mjs`. 0 credits spent.

## Browser
Brave works: Google sign-in and Flow both accept it. Launcher sets `FLOW_MCP_CHROME` to Brave.

## Account identity recovery (2026-11-02)

The original badge mapping below is historical. The detector now accepts case differences, line breaks, directional marks and emails outside parentheses. When a generation preflight cannot read the badge, it opens Account details, reads a unique email from the bounded account panel and closes the panel. It never infers identity from credits, an account index or a stored account. Ambiguous/missing identity still blocks generation.

Passive health checks do not open that panel while jobs are busy. Detailed Flow status now reports `account_verified` separately from `signedIn`, and identity failures on an open Flow page report verification failure rather than always asking the owner to sign in. Existing wrong-account and cached-reference/project guards remain in force.

Verification: `cd engine; npm.cmd run test:accounts` uses isolated Chromium fixtures with no CDP connection, production profile, network or generation. Live verification requires restarting Studio to load the compiled engine; no failed job is automatically retried by this fix.

## Active account
- Flow's URL carries the Google session index as a path segment: `https://flow.google.com/u/<n>/...`.
- Email: `getByRole("button", { name: /Google Account:/ })` → aria-label `Google Account: <name> (<email>)[, …]`; email is the text in parentheses.

## Switching
- Navigate to `https://flow.google.com/u/<n>/?hl=en`. No clicks needed.
- An index past the last signed-in account silently redirects to `/u/0/` → detect by comparing the landed URL's `/u/<n>/` with the requested one.
- Indices follow Google's sign-in order and can shift when accounts are added/removed: key accounts by **email**, store the index as a cache, re-verify the email after every switch.
- The in-page "Switch account" link goes to `accounts.google.com/AccountChooser` (off-site, multi-step) — not used.

## Credits
- `readCredits` (flow.ts) opens `button "Account details"` and reads `link /Google Flow credits/` → works for whichever `/u/<n>/` is loaded. Verified: each index reported its own balance (50 each).
- Same panel has `text "Credits refresh daily at <h:mm AM/PM>"` — **per account, different times** (seen 4:59 AM, 5:38 PM, 8:22 AM). Parse it for `refreshAt` instead of assuming midnight.
- The panel also contains "Sign out of all accounts": never click anything else in it; close with Escape.

## Projects
- Projects are per account: `/u/0/project/<id>` opened as `/u/1/project/<id>` lands on `/u/1/404?reason=project` ("Project not found").
- So Task 5 must keep a Flow project per (account, studio sub-project) and switch project together with account.

## Decision
SWITCH_METHOD=authuser (path form `/u/<n>/`, not the `?authuser=` query)

## Task 5 findings (2026-10-31, live)
- Flow home (`/u/<n>/`) has `button "New project"`; clicking it lands on `/u/<n>/project/<uuid>` (free). The home also lists `Edit project title` / `Delete project` per project: never touched.
- The "Credits refresh daily at" time of an account with an untouched balance follows the clock (two accounts read 8:32 AM, then 8:35 AM three minutes later), so it only means something once credits were spent. Exhaustion uses it anyway; worst case an account is retried a little early.
- Live check: acct 0's stored balance faked to 0 with `FLOW_MCP_FORCE_SWITCH=1`, one image job -> note "acct 0 out of credits → acct 1", new Flow project created in acct 1, image generated and saved there. Balances 50/50 before and after.
