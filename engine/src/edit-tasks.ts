import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { subDir } from "./projects.js";
import { readJson, writeJsonAtomic } from "./persist.js";

const Task = z.object({ owner: z.literal("flow-studio-edit-v1"), id: z.string(), session: z.string().optional(),
  phase: z.enum(["sent", "accepted", "editing", "rendering", "finished", "failed"]), message: z.string(),
  createdAt: z.string(), updatedAt: z.string(), render: z.object({ version: z.number(), path: z.string() }).optional() });
export type EditTask = z.infer<typeof Task>;
const file = (p: string, s: string) => join(subDir(p, s), "edit-task.json");
export const activeEdit = (task: EditTask | null) => !!task && !["finished", "failed"].includes(task.phase);
export function readEdit(p: string, s: string): EditTask | null {
  const data = readJson(file(p, s), null); return data === null ? null : Task.parse(data);
}
export function startEdit(p: string, s: string, session?: string): EditTask {
  if (activeEdit(readEdit(p, s))) throw new Error("An edit task is already active. Review it or mark it stopped before submitting again.");
  const now = new Date().toISOString();
  const task: EditTask = { owner: "flow-studio-edit-v1", id: randomUUID(), session, phase: "sent", message: "Instructions sent; waiting for the agent to acknowledge.", createdAt: now, updatedAt: now };
  writeJsonAtomic(file(p, s), task); return task;
}
export function updateEdit(p: string, s: string, id: string, phase: "accepted" | "editing" | "rendering" | "failed", message = ""): EditTask {
  const task = readEdit(p, s);
  if (!task || task.id !== id || !activeEdit(task)) throw new Error("Edit task is no longer active; read the current task before updating it.");
  const order = ["sent", "accepted", "editing", "rendering", "finished", "failed"];
  if (order.indexOf(phase) < order.indexOf(task.phase)) throw new Error("Edit progress cannot move backward.");
  const next = { ...task, phase, message: message || phase, updatedAt: new Date().toISOString() };
  writeJsonAtomic(file(p, s), next); return next;
}
export function finishEdit(p: string, s: string, id: string, render: { version: number; path: string }): EditTask {
  const task = readEdit(p, s);
  if (!task || task.id !== id || !activeEdit(task)) throw new Error("Edit task is no longer active.");
  const next: EditTask = { ...task, phase: "finished", message: `Render v${render.version} is ready to review.`, render, updatedAt: new Date().toISOString() };
  writeJsonAtomic(file(p, s), next); return next;
}
