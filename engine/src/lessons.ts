import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { HOME_DIR } from "./chrome.js";
import { readJson, writeJsonAtomic } from "./persist.js";

export type Lesson = { scope: string; text: string };
export type Proposal = { id: string; text: string; scope: string; createdAt: string };

// Read lazily so tests can set STUDIO_LESSONS after import; pending lives beside the rulebook.
export const lessonsFile = () => process.env.STUDIO_LESSONS ?? join(HOME_DIR, "lessons.md");
const pendingFile = () => join(dirname(lessonsFile()), "lessons-pending.json");

const oneLine = (t: string) => {
  const out = t.replace(/\s+/g, " ").trim();
  if (!out) throw new Error("Lesson text is empty.");
  return out;
};
const scopeOf = (s: string) => {
  const out = s.trim();
  if (!/^(global|model:\S+)$/.test(out)) throw new Error(`Bad scope "${s}": use "global" or "model:<name>".`);
  return out;
};

export function readLessons(): Lesson[] {
  const f = lessonsFile();
  if (!existsSync(f)) return [];
  const out: Lesson[] = [];
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^- \[([^\]]+)\] (.+)$/.exec(line);
    if (m) out.push({ scope: m[1], text: m[2] });
  }
  return out;
}

export const pendingLessons = (): Proposal[] => readJson<Proposal[]>(pendingFile(), []);

export function proposeLesson(text: string, scope = "global"): Proposal {
  const p: Proposal = { id: randomUUID().slice(0, 8), text: oneLine(text), scope: scopeOf(scope), createdAt: new Date().toISOString() };
  writeJsonAtomic(pendingFile(), [...pendingLessons(), p]);
  return p;
}

export function addLesson(text: string, scope = "global"): void {
  const f = lessonsFile();
  mkdirSync(dirname(f), { recursive: true });
  let prefix = "";
  if (existsSync(f)) { const cur = readFileSync(f, "utf8"); if (cur && !cur.endsWith("\n")) prefix = "\n"; }
  appendFileSync(f, `${prefix}- [${scopeOf(scope)}] ${oneLine(text)}\n`);
}

export function resolveLesson(id: string, action: "save" | "discard", editedText?: string): void {
  const all = pendingLessons();
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error(`No pending lesson "${id}".`);
  if (action === "save") addLesson(editedText ?? p.text, p.scope);
  writeJsonAtomic(pendingFile(), all.filter((x) => x.id !== id));
}
