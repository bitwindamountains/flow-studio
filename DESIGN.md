# Flow Studio workspace

Owner-selected direction: adapt the liquid glass and stellar design from `D:\app ideas\PostPilot`, especially `web/src/styles.css` and the refraction filter in `web/index.html`. The 2026-11-02 correction replaces the first pass's stacked dark shells with a composed workspace. This is a working application; the owner's five-stage sequence carries real workflow meaning.

- Silver ground `#f1f1ec`, white content surfaces, midnight `#0f1326`, primary ink `#15171b`, secondary ink `#585e6b`, and blue accent `#2b4bd8`. Warm light belongs in the background; warnings keep their own semantic colors.
- Sparse stars, a restrained orbital arc and blue/warm ambient light sit behind the workspace. The sky fades into silver ground; its opaque region extends further on phones to keep white guidance readable. Glass uses separate SVG refraction and blur/tint layers with restrained upper rims. Unsupported blur and reduced transparency receive opaque surfaces.
- Glass carries navigation: a detached full-height navy workflow rail and a pale project bar. Stage headings sit directly over the sky. A white canvas with a translucent bezel carries prompts, notes, references, scenes and renders. Avoid another dark header strip or a rounded container around every region.
- The terminal keeps a midnight ground with pale text; its toolbar and message controls use pale silver. Do not turn the whole agent panel into a second night-glass navigation shell.
- System sans typography with Geist when locally available, 14px body, 36px desktop and 30px phone stage titles, and tabular counts. No external font or asset requests are required. The orbit/play brand mark belongs to the workflow rail on desktop and a compact product name appears in the phone project bar.
- Desktop has a 204px detached workflow rail (180px on smaller laptops) and a working canvas alongside it. The resizable agent panel stays below the canvas, with a default height up to 280px while respecting saved owner sizing. Below 850px the rail becomes a compact row, the project bar wraps and agent controls stack vertically.
- Edit uses side-by-side notes and render preview on wide screens; smaller screens stack them. Put the edit action immediately after the notes, before optional audio. Kept-clip thumbnails live in an expandable source list. A missing render has a purposeful empty state.
- Visible stage statuses and prerequisite explanations distinguish readiness from the stage being viewed. Current stage is marked with `aria-current=step`; locked stages remain discoverable with an explanation.
- One next-action region below the stage title. Explicit scene/take/render selection controls determine the visible message target. Background refresh must not move the owner to another stage.
- The same xterm session remains mounted across navigation. Terminal mode handles CLI interactions; Message mode attaches a frozen context snapshot to a deliberate send. Readiness is owner-confirmed, never inferred from a running process.
- Preserve notes drafts, focus, versioned media and pending approvals. Global Review jobs remains available outside the stage locks.
- Responsive controls wrap; the scene strip and each drawer scroll within their own regions. Focus rings, labelled regions and text status carry state without relying on color. No decorative animation is required for this operating surface.

Source: `ui/index.html`, `ui/studio.css`, `ui/app.js`. The server snapshots the allowlisted stylesheet with the rest of the UI. Browser verification uses isolated fixture content. Real media, real CLI prompt acceptance and owner-window startup are separate live checks.

## Review desk (2026-11-16)

The autonomous-steps workflow changes structure and wording, not the look: the tokens and the glass, silver ground and midnight terminal above stay. One screen with three always-visible parts:

- Top bar: project menu (project, video, new, jobs), the five steps `Idea`, `Plan`, `Look`, `Assets`, `Edit` as a compact progress row, one alert badge that opens the list of notices (health, connection, owner window), and the Chat button.
- Gate bar, only while a step is in review, changes or blocked: one line of summary, counts, and the approve and changes buttons. While the agent works it is a progress line and asks nothing of the owner. State is always written as text, never colour alone.
- Player and strip: the selected scene or render large, with one tile per scene below it showing a kind icon and one status mark (done, flagged, working, stale). The strip scrolls, filters to flagged and groups by plan section.

Four drawers stay hidden until asked, one open at a time: Details (the selected scene first, then the video: steps with Log and owner Reopen, notes, references, scenes, edit), Chat (Message | Terminal over the one mounted terminal), Alerts (one line per notice, full text on expand) and the plan reader (markdown as plain text). On wide screens a drawer sits beside the desk so the gate stays uncovered; at 850px and below it is a bottom sheet up to 80dvh, with the connection banner floating above it. Escape and the close button return focus to the opener; inside the terminal Escape belongs to the CLI. Optional explanations sit behind a small "Why?" next to the control they explain, and disclosures keep their open state across redraws. Safety-relevant text is shortened, not removed: it lives in the alert list and the gate bar blocked reason. Touch targets are 44px under `(pointer: coarse)` and focus rings are kept. See `docs/review-desk.md`.
