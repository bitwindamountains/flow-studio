import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Fallback only when the file is missing: a corrupt file must never silently read as empty and get overwritten.
export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  try { return JSON.parse(text) as T; } catch (e) {
    throw new Error(`Cannot read ${file}: ${(e as Error).message}. Fix the file or move it aside (the queue will start empty).`);
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
