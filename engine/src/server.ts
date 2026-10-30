import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { HOME_DIR } from "./chrome.js";
import { LocalCore, OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { loadAccounts } from "./accounts.js";
import { PtyHub, startClaude } from "./pty.js";

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);
export const TOKEN_FILE = join(HOME_DIR, "token");
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../../ui/index.html", import.meta.url));
const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));
// Fixed allowlist: a request path is only ever a lookup key, never a filesystem path.
const nm = (p: string) => fileURLToPath(new URL(`../node_modules/${p}`, import.meta.url));
const VENDOR: Record<string, [string, string]> = {
  "xterm.js": [nm("@xterm/xterm/lib/xterm.js"), "text/javascript"],
  "xterm.css": [nm("@xterm/xterm/css/xterm.css"), "text/css"],
  "addon-fit.js": [nm("@xterm/addon-fit/lib/addon-fit.js"), "text/javascript"],
  "app.js": [UI_DIR + "app.js", "text/javascript"],
};
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!(inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR) || inside(file, CAPTIONS_DIR)) || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

import { addLesson, pendingLessons, readLessons, resolveLesson } from "./lessons.js";

export type ServerRole = "owner" | "client" | "none";

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process already
// owns the port (that process owns the Flow tab and the queue), "none" when the port is taken by something else.
export let lastServer: Server | undefined; // test hook: lets a test close the listener

export async function startServer(core: Core, spawner = startClaude): Promise<ServerRole> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = randomBytes(24).toString("hex");
  // In memory only, never on disk or in the token file: Claude can read the flow token but must not approve credit spend.
  const uiToken = randomBytes(24).toString("hex");
  let uiTokenGiven = false; // handed out once: the first page load is the owner's studio tab; later loads get an empty token

  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

  const hub = new PtyHub(spawner);
  const wss = new WebSocketServer({ noServer: true });
  const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

  const server = lastServer = createServer(async (req, res) => {
    try {
      // The Host check blocks DNS-rebinding; the token blocks other local pages from driving the queue.
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { name: "flow-mcp" });
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        const html = readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token).replace("__UI_TOKEN__", uiTokenGiven ? "" : uiToken);
        uiTokenGiven = true;
        return res.end(html);
      }

      if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
        const hit = Object.hasOwn(VENDOR, url.pathname.slice(8)) ? VENDOR[url.pathname.slice(8)] : undefined;
        if (!hit) return json(res, 404, { error: "Not found." });
        res.writeHead(200, { "content-type": hit[1], "cache-control": "no-store" });
        return res.end(readFileSync(hit[0]));
      }
      // Read-only and email-free: index, credits, exhausted flag, refresh time.
      if (req.method === "GET" && url.pathname === "/api/accounts") {
        const now = new Date();
        return json(res, 200, loadAccounts(join(HOME_DIR, "accounts.json")).map((a) => {
          const exhausted = !!a.exhaustedUntil && new Date(a.exhaustedUntil) > now;
          return { index: a.index, credits: a.credits ?? null, exhausted, refreshAt: exhausted ? a.exhaustedUntil : null };
        }));
      }

      if (req.method === "POST" && url.pathname === "/api/approve") {
        if (req.headers["x-ui-token"] !== uiToken) return json(res, 403, { error: "Only the studio page can approve credit spending." });
        if (!(core instanceof LocalCore)) return json(res, 404, { error: "Not found." });
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}") as { batch?: string; job_id?: string };
        return json(res, 200, { approved: core.queue.approve({ batch: body.batch, job_id: body.job_id }).map((j) => j.id) });
      }

      if (req.method === "POST" && (url.pathname === "/api/lessons/resolve" || url.pathname === "/api/lessons/add")) {
        if (req.headers["x-ui-token"] !== uiToken) return json(res, 403, { error: "Only the studio page can change lessons." });
        const b = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}") as { id?: string; action?: "save" | "discard"; editedText?: string; text?: string; scope?: string };
        if (url.pathname.endsWith("/add")) addLesson(b.text ?? "", b.scope);
        else resolveLesson(b.id ?? "", b.action === "save" ? "save" : "discard", b.editedText);
        return json(res, 200, { ok: true });
      }

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      if (given !== token) return json(res, 401, { error: "Missing or wrong token." });

      if (req.method === "GET" && url.pathname === "/api/pending") {
        return core instanceof LocalCore ? json(res, 200, core.queue.pendingApproval()) : json(res, 404, { error: "Not found." });
      }
      if (req.method === "GET" && url.pathname === "/api/lessons") return json(res, 200, { lessons: readLessons(), pending: pendingLessons() });
      if (req.method === "GET" && url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") ?? "");

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { path });
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[method] as (a: unknown) => Promise<unknown>)(args));
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  // Host + Origin + UI token, all checked before the upgrade; claude is only spawned after attach() on an accepted socket.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ok = url.pathname === "/pty" && allowedHosts.has(req.headers.host ?? "") &&
      allowedOrigins.has(req.headers.origin ?? "") && sameSecret(url.searchParams.get("ui") ?? "", uiToken);
    if (!ok) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
  });
  server.on("close", () => { hub.kill(); for (const c of wss.clients) c.terminate(); wss.close(); });

  const listening = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(PORT, "127.0.0.1", () => ok(true));
  });
  if (listening) {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return "owner";
  }
  // The port is taken. Who has it matters enormously: becoming a second LOCAL core means two processes drive the same
  // Flow tab with separate queues, which is how a shot got generated and charged twice while flow_status reported an
  // empty queue (2026-09-20). Claude Desktop starts several of these at once and the owner is often still booting, or
  // busy inside a Playwright call, so one 2 s health check timing out proves nothing.
  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === "flow-mcp") return "client";
    // A valid answer from something that is NOT us means the port belongs to an unrelated program, and driving Flow
    // locally is safe.
    if (other) return "none";
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Never confirmed, but something holds the port and it is most likely a busy sibling. Defer to it: a client whose
  // calls fail loudly is far better than a second process silently spending the user's credits.
  return "client";
}
