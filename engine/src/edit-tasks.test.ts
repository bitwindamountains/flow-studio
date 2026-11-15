import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.STUDIO_PROJECTS = mkdtempSync(join(tmpdir(), "studio-tasks-"));
test("edit tasks persist acknowledgements, reject duplicate/stale updates, and finish with a render", async () => {
  const { createSub } = await import("./projects.js"); createSub("Task", "ad");
  const tasks = await import("./edit-tasks.js" as string);
  const first = tasks.startEdit("Task", "ad");
  assert.equal(first.phase, "sent");
  assert.throws(() => tasks.startEdit("Task", "ad"), /already/i);
  tasks.updateEdit("Task", "ad", first.id, "accepted", "Reading notes");
  assert.equal(tasks.readEdit("Task", "ad").phase, "accepted");
  assert.throws(() => tasks.updateEdit("Task", "ad", "stale", "editing"), /task/i);
  tasks.updateEdit("Task", "ad", first.id, "rendering", "Rendering v1");
  assert.throws(() => tasks.updateEdit("Task", "ad", first.id, "accepted"), /backward/i);
  tasks.finishEdit("Task", "ad", first.id, { version: 1, path: "v1.mp4" });
  assert.equal(tasks.readEdit("Task", "ad").phase, "finished");
  const next = tasks.startEdit("Task", "ad");
  assert.notEqual(next.id, first.id);
  tasks.updateEdit("Task", "ad", next.id, "failed", "Agent restarted");
  assert.equal(tasks.readEdit("Task", "ad").phase, "failed");
});
