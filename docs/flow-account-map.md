# Flow account switching — live map (2026-10-31)

Mapped live in the studio Brave profile (`data/chrome-profile`, CDP 9333) with several accounts signed in. Probe: `engine/scripts/probe-accounts.mjs`. 0 credits spent.

## Browser
Brave works: Google sign-in and Flow both accept it. Launcher sets `FLOW_MCP_CHROME` to Brave.

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
