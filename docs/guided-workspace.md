# Guided workspace implementation handoff

Follow-up: the terminal is below the workspace at every width, with vertical resizing and expand/restore. New cuts have an explicit empty ad-reference selection. Plan now offers add/remove controls for ad-wide and scene references, plus a separate reusable library. Removal preserves files/earlier ads and invalidates obsolete waiting jobs. Browser generation now prepares the correct account/cut Flow project before checking for a composer; source-bound edits and Flow asset projects retain their safeguards.

Implemented on `main` (then `build/flow-studio`), preserving the owner's earlier uncommitted work.

## What changed

- Guided five-stage navigation with locked future stages, prerequisite explanations and backward revision.
- Engine-derived readiness, including real file checks, usable kept selections, partial batches and legacy plans without scenario metadata.
- Retained review of old clips/renders when current prerequisites regress. A finished render does not reset the project or chat.
- Responsive workflow rail, focused stage workspace, explicit scene/take/render selection and persistent CLI panel. Project setup and global pending approvals sit outside the stage locks.
- Owner-only, in-memory screen context plus read-only MCP discovery. `studio_current` still returns only project/sub or null.
- Explicit Message/Terminal modes. Context-bearing messages capture their target, use bracketed paste and serialize across the shared terminal. Reconnect does not replay requests; uncertain delivery retains drafts and requires review before retry.
- Scoped Edit/Revise submission preserves note flushing, task IDs, versioned output and existing owner/credit guards.

## Validation

- `cd engine; npm.cmd test`: 153 tests passed at the final implementation checkpoint.
- Isolated terminal browser script: desktop 1366px and mobile 480px.
- Isolated workflow browser script: desktop 1366px, tablet 1024px and mobile 480px. Checks cover locks, notes, backward review, frozen message target, approvals, duplicate jobs, restored takes, edit lifecycle and offline recovery.
- JavaScript syntax check and whitespace check.
- Impeccable detector: no reported findings; xterm stylesheet analysis is incomplete because its source is served through an allowlisted vendor route.
- Fresh independent review found three P2 issues; all were reproduced/fixed and the reviewer verified the fixes with the UI unit tests.

Preview captures are local fixture screenshots in `.tmp/workflow-1366.png`, `.tmp/workflow-1024.png`, `.tmp/workflow-480.png` and `.tmp/codex-terminal-*.png`. They contain synthetic media placeholders, not the owner's actual video.

## Practical limits

The embedded panel remains a real CLI, not a structured conversation protocol. Message mode requires the owner to confirm that the agent is at its normal input prompt. Process status does not prove readiness, a delivery acknowledgment does not prove the model accepted the turn, and ambiguous stage-level messages may still need clarification. Raw terminal typing has no automatic context attachment.

Actual Claude/Codex normal-prompt acceptance, running responses, sign-in/trust/approval dialogs and reconnect behavior require owner-present verification. Automated fake-PTY tests do not establish those facts. No paid Flow job or live authenticated editing/render was used for testing.

## Load the changes

When no generation/edit/render is active, close the old Studio window and restart `Flow Studio.cmd`. Use the window opened by the launcher so it receives the owner session, then restart the embedded agent to discover the new MCP methods. Do not start another engine or browse production profiles to bypass this step.

The live session was left running deliberately while the owner was away. Source edits are snapshotted only on server startup, so the currently open window may still show the previous UI.

