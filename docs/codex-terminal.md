# Using Codex in Flow Studio

If Studio says the window cannot approve credits, close that window and run `Flow Studio.cmd`. When a server is already running, the launcher asks before restarting it; choose **Yes** after any generation or editing finishes. Choosing **No** leaves the current server running and cancels the new launch. The launcher refuses to stop an unrelated process on Studio's port. Restarting creates a fresh owner session in the dedicated Studio browser profile; it does not grant approval authority to an arbitrary tab.

The subsequent [workflow usability improvements](workflow-usability.md) add protected drafts, take history and tracked editing tasks for both agents. Tracked edits require the new MCP progress tools; restart the agent session after loading that update.

After any active generation finishes, restart Flow Studio with `Flow Studio.cmd` and reload its window to load the updated server and UI. In the terminal bar, select **Codex CLI**, then press **Switch agent**. Claude Code remains the default and can be selected again the same way. Switching ends the current terminal process and starts the selected CLI; it does not transfer the chat conversation.

Codex must be installed on PATH and signed in using its own CLI login. No credentials or model defaults are changed by Studio. The installed CLI on this machine is 0.166.0.

Codex starts in `D:/flow-studio/remotion`, with the projects folder added to its workspace, a workspace-write sandbox, and on-request command approvals. It loads the parent repository's `AGENTS.md` and `.codex/config.toml`. That configuration points at the same Flow Studio MCP and disables `flow_generate`, `flow_edit`, and `flow_continue`; use the `studio_*` tools and the owner's credit approval button. The running Studio owner continues to drive its existing Brave Flow session.

Both agents use the owner's Remotion style skills under `remotion/.claude/skills/`. Their locations are recorded in `AGENTS.md`. The Edit/Revise buttons send their instructions to whichever terminal agent is running.

The terminal selection is shared across open Studio windows and lasts until Studio restarts. Each window receives the active selection when it connects. Only owner-authorized terminal connections can switch agents.

The status beside the selector reports the actual CLI process state, including its exit code if it stops. Edit/Revise is disabled when the CLI is not running. Reconnecting the window preserves an exited session and its error output; press Restart deliberately to begin another chat. A running process may still be waiting for sign-in or project trust, so complete any prompts visible in the terminal first.

Use **Expand terminal** for Codex's sign-in menus or a longer coding session, and **Restore layout** to return to the storyboard and editing controls. Switching/restarting focuses the running terminal and retains its dimensions. Session identifiers prevent a delayed Edit submission from entering a replacement chat; queued terminal output is drained before resetting to the new chat.

Codex runs with `--no-daemon` and an explicit `TERM=xterm-256color` / `COLORTERM=truecolor` environment. These keep the embedded CLI lifecycle local to its terminal and avoid inheriting `TERM=dumb` from the Studio launcher. Terminal output travels separately from process-control messages.

Implementation references: [official CLI reference](https://developers.openai.com/codex/cli/reference/) and [configuration reference](https://developers.openai.com/codex/config-reference/). CLI flags and project MCP discovery were also checked against the installed executable.

Validation after usability review: 128 engine/UI tests passed. `cd engine; npm run test:terminal` exercises the full UI in isolated headless Chrome at 1366px and 480px, including switching, focus, output isolation, exit gating, restart, expansion, stale-output reset, and control bounds. It uses mocked services and never connects to Studio or Flow. Set `FLOW_TEST_CHROME` to override the browser executable. A separate real Windows PTY test launched Codex in an isolated home/workspace and reached the sign-in menu without the terminal warning. MCP configuration discovery was checked from the real Remotion working directory without starting an MCP server. No model request or Flow generation was sent by these checks; signed-in editing remains a live-check limitation.
# Guided workspace and scoped messages

The workflow rail locks future stages until their prerequisites are met. Earlier stages remain accessible, and earlier renders stay reviewable when the current kept clips require repair. The same CLI session stays mounted while navigating.

The **Terminal** mode passes raw keyboard input unchanged, for sign-in, trust prompts, CLI approvals and terminal commands. It does not automatically attach screen context. The **Message** mode forwards an explicit request with the selected project, stage and scene/take/render. Confirm that the CLI is at its normal input prompt before each send; a running process is not proof it is ready. The current integration has no automatic idle detection.

A send receipt means forwarded to the CLI, not understood or finished. If delivery is uncertain, inspect the terminal before retrying. Drafts are retained; reconnect never silently replays requests. Messages keep their captured target even if the owner navigates afterward. Switch/Restart still starts a new chat; ordinary screen navigation does not.

New read-only MCP methods: `studio_workflow_read` and `studio_context_read`. Owner-only screen publication is ephemeral and confers no spending/approval authority. Restart the embedded agent after a coordinated Studio restart to discover these methods.

Isolated tests cover protocol behavior. Actual turn acceptance in Claude/Codex and interaction with their sign-in/trust dialogs still requires owner-present verification.

