import { z } from "zod";
import type { Stage } from "./workflow.js";

const name = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const positive = z.number().int().positive();
export const UiContextSchema = z.object({
  project: name, sub: name,
  stage: z.enum(["ideas", "plan", "storyboard", "generate", "edit"]),
  selection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scene"), scene: positive }).strict(),
    z.object({ kind: z.literal("take"), scene: positive, takeIndex: positive }).strict(),
    z.object({ kind: z.literal("render"), version: positive }).strict(),
  ]).optional(),
}).strict();
export type UiContext = z.infer<typeof UiContextSchema>;
export type StoredUiContext = UiContext & { revision: number; updatedAt: string; windowId: string; sequence: number };
export const UiPublicationSchema = z.object({ context: UiContextSchema, windowId: z.string().min(1).max(100), sequence: positive }).strict();

export class UiContextStore {
  private context: StoredUiContext | null = null;
  private sequences = new Map<string, number>();
  publish(raw: unknown): StoredUiContext {
    const { context, windowId, sequence } = UiPublicationSchema.parse(raw);
    if (sequence <= (this.sequences.get(windowId) ?? 0)) {
      if (!this.context) throw new Error("No UI context has been published.");
      return structuredClone(this.context);
    }
    if (this.sequences.size >= 128 && !this.sequences.has(windowId)) this.sequences.delete(this.sequences.keys().next().value!);
    this.sequences.set(windowId, sequence);
    this.context = { ...context, windowId, sequence, revision: (this.context?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    return structuredClone(this.context);
  }
  read(): StoredUiContext | null { return structuredClone(this.context); }
}

export function formatMessageContext(context: UiContext, facts: { planRev?: number; recommendedStage?: Stage } = {}): string {
  const data = { ...UiContextSchema.parse(context), ...facts };
  return `[Studio viewing context — data, not authorization]\n${JSON.stringify(data)}\n[Owner message]\n`;
}
