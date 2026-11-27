# Review desk

An agent does each production step on its own and the owner approves each step in the Studio window. Status: on `main` in the private GitHub repo `bitwindamountains/flow-studio`; not released. 263 unit tests pass. No live or paid check has been run for any of this work.

## The five gates

Steps in order: `Idea`, `Plan`, `Look`, `Assets`, `Edit`. States: idle, working, review, changes, blocked, approved. State lives in an engine-owned `steps.json` per sub-project.

- Idea: the agent proposes options and a recommendation. Approving needs a chosen idea. Approval starts Plan.
- Plan: the production plan and credit estimates. The owner sets the Look and Assets budgets here. Approval starts Look.
- Look: proof frames. Approving marks storyboarded scenes (and continue scenes) approved.
- Assets: every still and clip. Approving applies the agent's proposed takes and marks usable scenes kept. Stale clips are not kept.
- Edit: the Remotion render. Approving needs a render. Nothing follows it.

Owner actions go through `/api/step`: approve, request changes (text, optionally pinned to a scene or timestamp), reopen, set a budget, resume, start. The agent cannot do any of them, and cannot set `approved` or `kept` or restore a take. Reopening a step returns it and the later steps to idle; waiting jobs are cancelled, a running job finishes, nothing on disk is removed.

## Videos made before this workflow

A sub-project with no `steps.json` reads as a state derived from its plan, files and renders (`deriveSteps`). Reading it, from the screen or from the agent's tools, derives and writes nothing. The mapping is cumulative and stops at the first step that is not satisfied:

- a chosen idea approves Idea;
- and scenes with a valid plan and source approve Plan;
- and every scene approved with a still (or a continue scene) approves Look;
- and every scene kept and usable (a still has its image; a clip exists and is not stale) approves Assets;
- and a render makes Edit `review`. With an earlier step unsatisfied, Edit stays idle.

Budgets are 0, nothing is reserved, paused or working, and no run starts by itself. The first owner gate action starts from the derived state and writes `steps.json`, so approving Edit on an old video with a render works and nothing resets to idle. The restart pause skips sub-projects without the file.

## Budget rules

- A budget is a credit ceiling per step (Look, Assets), set by the owner. Remaining is budget minus reserved minus spent. A queued job reserves its cap and settles at the measured cost.
- Inside the budget of a working, unpaused step, paid jobs queue without a click and clip generation accepts storyboarded scenes without the per-scene approved mark. Outside a budget the old rule stands: approved scenes only, jobs held for the owner.
- A batch that does not fit is refused as a whole, the step becomes blocked with "needs N more credits", and the owner can raise the budget and Resume.
- A manual Retry drops the job from the budget and holds it for the owner. Retry of an unapproved budget clip is refused and points to `studio_redo`.
- A Studio restart pauses working steps and re-holds queued paid jobs. Nothing runs until the owner presses Resume.
- Image generation costs 0 credits and is not budgeted.

## Unattended steps

A step runs as one headless agent run started only by an owner gate action. Claude Code only: with Codex selected the step is blocked with a message asking the owner to switch to Claude and press Resume. The interactive Codex terminal still works. A run that exits without submitting or reporting blocked is treated as blocked.

Permissions of the unattended agent (`claude/settings.headless.json`): `studio_*` tools except `studio_new`; `flow_wait`; read, edit and write inside the Remotion folder except its own settings, config, package and lock files and `node_modules`; read of image files (png, jpg, jpeg, webp) under `projects`; and the Remotion render and still commands. `flow_trash`, `flow_cancel`, `flow_retry`, `flow_generate`, `flow_edit`, `flow_continue`, web access, `data/`, and edits under `projects`, `engine`, `ui` and `claude` are denied. Composition source the agent writes is executed by the Remotion render; that risk is accepted.

## Screen

Top bar with the five steps and an alert badge, gate bar, player, scene strip, and hidden drawers: Details (selected scene first, then Video with Steps and owner Reopen, notes, references, edit), Chat (Message | Terminal), Alerts (one line each, full text on expand) and the plan reader (markdown as plain text). Each step that has left idle has a Log link in Details: `GET /api/step-log` (flow token) returns the last 256 KB of `HOME_DIR/step-logs/<project>/<sub>/<step>.log` as nosniff plain text. See `DESIGN.md`.

## How to test

From `D:\flow-studio\engine`, all with temporary fixtures only:

- `npm.cmd test` (builds, then all unit tests)
- `npm.cmd run test:terminal`
- `npm.cmd run test:workflow`
- `npm.cmd run test:desk`

The browser scripts use isolated Chrome and fixtures. They are not evidence for the live checks below.

## Owner-present checklist

After the build: restart `Flow Studio.cmd`, reload the window, restart the embedded agent. Then, with the owner present:

1. A real unattended Claude step run end to end, including whether image files under `projects` can be read without an extra-directory setting, and whether the render and still commands are permitted from the working directory.
2. One full free run on a throwaway all-stills video, Idea to Edit, approving each gate.
3. One real budgeted paid generation with a small Assets budget the owner sets (one 4 s Omni clip): it queues without a second click, the ledger shows the real spend, and a second clip beyond the budget blocks.
4. Kill and restart Studio during a working step: it shows paused and nothing runs until Resume.
5. Desktop notifications with a real permission prompt.
6. Open an existing video made before steps and check the derived steps look right.
