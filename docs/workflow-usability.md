# Workflow usability improvements

The eight accepted audit gaps are implemented without changing the visual direction or the owner's credit-approval gate.

| Gap | Result |
| --- | --- |
| Notes lose drafts/focus | Independent project save timers/requests, browser draft recovery, visible save state and a preserved-draft action. Autosave updates status without replacing the focused textarea. Conflicts block only their own project's edit submission. |
| Revision audio cannot be reused/replaced | An engine-owned audio manifest reuses imports and remembers the current audio. Replacements use new bg-vN/vo-vN files; previous audio and renders remain intact. Missing selected audio is checked before replacement sources move. |
| Duplicate actions | Generate, storyboard and redo skip active scene jobs and report already queued scenes. Edit submissions have an owner-created task and stay disabled until it finishes or is explicitly marked stopped. |
| Hidden connection failures | Bounded requests, persistent connection errors, disabled stale write controls, Retry connection and Reload Studio. Notes retain local drafts during failures. |
| Approval before an own frame exists | Both the UI and owner endpoint require an existing storyboard still for own-frame approval. Continue scenes approve their clip prompt without a still. |
| Unclear next step | A workflow summary links to the relevant tab or chat. Storyboard cards show active jobs; Make missing stills preserves existing approvals. Stale kept scenes block editing with an explanation. |
| Previous takes hard to recover | Generate exposes native video comparison and owner-only restoration. History includes available earlier queue records. Restoring a take clears Keep and invalidates dependent continuation clips. Active scenes cannot be restored mid-job. |
| No edit acknowledgement/completion state | Persisted Sent/Accepted/Editing/Rendering/Finished/Failed. The agent reports explicit progress; a matching task_id and actual render registration complete the task. Agent/Studio restarts report interrupted work as failed. Late or missing task ids cannot move/register a render during a tracked edit. |

For tracked editing, `studio_edit_task_update` acknowledges and reports progress. `studio_render_done` takes the same `task_id`; it completes the task only after registering the render. Instructions are included in both agents' Studio guidance and the Edit/Revise request. Task status is never guessed from terminal text. **Mark task stopped** changes tracking only; it does not terminate an agent or render. Review the terminal before retrying. Audio and take history are engine-owned metadata; the agent cannot forge them through plan writes.

Validation:

- `cd engine; npm test`: 139 tests pass, including owner authorization, duplicate prevention, take restoration, audio recovery, conflicting draft recovery, task binding and interruption recovery.
- `npm run test:workflow`: isolated Chrome checks pass at 1366px and 480px for note focus, drafts, independent saves, approval requirements, duplicate feedback, restoring takes, edit lifecycle and offline/auth-expiry recovery.
- `npm run test:terminal`: terminal lifecycle/input/switching checks pass at both widths. Browser fixtures load the actual xterm stylesheet.
- Syntax and whitespace checks pass. An independent read-only code review found four edge cases; all were reproduced and corrected with regressions. The UI detector reported no findings, but its vendor-stylesheet analysis is incomplete because that stylesheet is served through a route.

No live Flow generation or authenticated editing/rendering run was performed. Tests use temporary files, fake runners and mocked browser services; they spend no Flow credits and do not read production projects or browser profiles. Existing owner changes were preserved.

Restart Flow Studio and reload its window after active work finishes to load the new server, UI and MCP tool definitions. Existing live agent sessions need restarting to discover the new progress tools. A task reported as failed after a restart should be checked against the terminal and existing renders before submitting again.
# Guided workspace follow-up (2026-11-01)

The next UI pass replaces unrestricted equal tabs with a guided workflow rail, a stage workspace and persistent agent panel. Progress comes from local engine facts; navigation stays separate. Future steps show their prerequisites, backward revisions preserve history, and existing renders remain reviewable when new editing is blocked. Legacy projects with scenes remain accessible; partial batches and intentionally unkept scenes continue to work.

Project creation is outside stage locks. Global **Review jobs** keeps pending approvals reachable from any stage. The per-project last accessible stage and message drafts survive switching; memory fallbacks handle blocked browser storage. New scene/take/render selection controls show the message target explicitly.

Owner-only context publication feeds read-only `studio_context_read`; `studio_current` retains its exact old contract. Message-mode requests capture their target at Send. Tab changes make no model call, raw input stays raw, and delayed Enter cannot cross sessions. Real CLI prompt readiness is owner-confirmed and still requires live verification.

Independent review reproduced three issues—newest-render target drift, asynchronous screen/context mismatch and missing in-memory stage restoration. They were fixed with regressions. Unit suite: 153 passing tests at this checkpoint. Isolated terminal checks pass at 1366/480; workflow checks include 1366/1024/480. The mechanical UI detector reported no findings, with incomplete vendor xterm stylesheet analysis. Live owner-window/actual CLI testing and paid generation were not performed.

See `docs/guided-workspace.md` for the implementation handoff and limitations. Existing historical entries below remain intact.


The review desk (steps with owner gates, budgets, unattended runs) is described in `docs/review-desk.md`.
