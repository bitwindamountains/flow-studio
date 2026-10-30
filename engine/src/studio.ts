#!/usr/bin/env node
// Standalone Studio: runs the panel without Claude. If Claude's MCP process already serves it, just opens that.
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";
import { openUrl } from "./platform.js";

// This process holds the queue (and maybe a running paid job): log stray errors, never die of them.
process.on("unhandledRejection", (e) => console.error("flow-mcp: unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("flow-mcp: uncaught exception:", e));
const local = new LocalCore();
const role = await startServer(local, undefined, undefined, { studio: true });
const url = `http://127.0.0.1:${PORT}`;
if (role === "none") {
  // Before restore(): a process that is about to exit must not touch the shared queue file.
  console.error(`Port ${PORT} is used by another program. Set FLOW_MCP_PORT to a free port.`);
  process.exit(1);
}
if (role === "owner") local.queue.restore();
console.log(role === "owner" ? `Flow Studio running at ${url} (Ctrl+C to stop)` : `Flow Studio is already served by Claude's flow-mcp at ${url}`);
if (!process.env.FLOW_STUDIO_NO_OPEN) openUrl(url); // the launcher opens its own app window first, so it gets the one-shot UI token
if (role === "client") process.exit(0);
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(sig, () => process.exit(0)); // runs the exit hook that kills claude
