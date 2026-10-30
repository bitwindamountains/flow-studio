import { test } from "node:test";
import assert from "node:assert";
import { JobQueue } from "./queue.js";

test("JobQueue is exported", () => {
  assert.strictEqual(typeof JobQueue, "function");
});
