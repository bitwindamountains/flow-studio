# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner uses a local Windows application to create and revise videos with an embedded AI agent.

## Product Purpose

Flow Studio connects scenario development, scene planning, storyboard review, Google Flow generation and Remotion editing. The owner wants the interface and conversation to share context, with clear forward progress and easy backward revision.

## Operating Context

- Repository: `D:\flow-studio`; Remotion workspace: `D:\flow-studio\remotion`.
- Five production stages, in order: Ideas, Plan, Storyboard, Generate, Edit.
- One selected project/sub-project and one embedded Claude Code or Codex CLI session.
- The owner selects a scenario in chat, approves scenes, approves credit spending, keeps takes and reviews versioned renders.
- Existing UI: plain HTML/CSS/JavaScript, xterm, a TypeScript/Node server and MCP tools.

## Capabilities and Constraints

- Confirmed redesign requirement: lock future steps until prerequisites are satisfied, allow backward changes and preserve the conversation when switching stages.
- Confirmed context requirement: the active screen and selected item should help the agent interpret the owner's message.
- Screen changes alone should not invoke the model; message context should remain compact.
- Studio operations use flow-studio MCP. Spending approval, scene approval and take restoration remain owner controlled.
- Preserve revision conflicts, notes drafts, earlier compositions, takes, imported audio and renders.
- Raw terminal input includes sign-in, trust, approval and CLI interactions; it cannot safely be treated as ordinary chat messages.

## Evidence on Hand

`AGENTS.md`, `CLAUDE.md`, `docs/workflow-usability.md`, `docs/codex-terminal.md`, `ui/index.html`, `ui/app.js`, `engine/src/core.ts`, `engine/src/pty.ts` and the existing isolated workflow/terminal tests describe current behavior. This planning session has inspected source, not visually verified the live owner window.

## Product Principles

1. Make the current task and the next useful action clear.
2. Guide forward progress while preserving access to earlier work.
3. Keep the owner's screen context and message target aligned.
4. Preserve creative history and explicit spending control.
5. Keep routine navigation free of model calls.

## Deliberately Undecided

The proposed layout, exact unlock rules, controlled message-box interaction and implementation sequence are in the companion redesign documents. They are recommendations for review, not implemented or owner-approved details.
