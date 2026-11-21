import { readFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { basename } from "node:path";
import { ask, AskError, askAvailable } from "./ask.ts";
import { VERSION } from "./mcp.ts";
import { renderNote } from "./render.ts";
import { getNote, linkGraph, recentNotes, relatedNotes, search, stats } from "./search.ts";
import type { Vault } from "./vault.ts";

const WEB_DIR = new URL("../web/", import.meta.url);
const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const MAX_BODY = 16 * 1024;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS } });
const fail = (status: number, error: string) => json({ error }, status);

function boundedInt(value: string | null, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/**
 * The whole web app as one function from Request to Response, so it can be tested without a socket.
 * It only answers requests addressed to this machine (Host check stops DNS rebinding) and only reads the index.
 */
export async function handle(vault: Vault, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fail(403, "vaultmind only answers on localhost.");
  const path = url.pathname;
  const param = (name: string) => url.searchParams.get(name)?.trim() ?? "";

  if (request.method === "POST" && path === "/api/ask") {
    // Asking spends the user's API credit, so refuse anything that is not our own page posting JSON.
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return fail(403, "Cross-origin requests are not allowed.");
    if (!request.headers.get("content-type")?.startsWith("application/json")) return fail(415, "Send JSON.");
    if (!askAvailable()) return fail(503, "Ask is off. Set ANTHROPIC_API_KEY and restart vaultmind to turn it on.");
    let question: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return fail(413, "Question too long.");
      question = (JSON.parse(text) as { question?: unknown }).question;
    } catch {
      return fail(400, "Body must be JSON like {\"question\": \"...\"}.");
    }
    if (typeof question !== "string" || !question.trim() || question.length > 2000) return fail(400, "question must be 1-2000 characters.");
    try {
      vault.keepFresh();
      return json(await ask(vault, question.trim()));
    } catch (error) {
      if (error instanceof AskError) return fail(502, error.message);
      throw error;
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "Method not allowed.");

  const asset = STATIC[path];
  if (asset) return new Response(readFileSync(new URL(asset[0], WEB_DIR)), { headers: { "Content-Type": asset[1], ...SECURITY_HEADERS } });
  if (!path.startsWith("/api/")) return fail(404, "Not found.");

  vault.keepFresh();
  const db = vault.db;
  switch (path) {
    case "/api/status": {
      const s = stats(db);
      return json({ version: VERSION, vault: basename(vault.dir), ...s, semantic: Boolean(vault.embedder) && s.embedded > 0, ask: askAvailable() });
    }
    case "/api/search": {
      const q = param("q");
      if (q.length > 500) return fail(400, "q must be at most 500 characters.");
      if (!q) return json({ mode: "keyword", total: 0, hits: [] });
      const result = await search(db, q, { limit: boundedInt(url.searchParams.get("limit"), 20, 50) || 20, prefix: true, embedder: vault.embedder });
      return json({ ...result, hits: result.hits.map(({ text: _text, ...hit }) => hit) });
    }
    case "/api/recent":
      return json(recentNotes(db, boundedInt(url.searchParams.get("limit"), 30, 200) || 30));
    case "/api/graph":
      return json(linkGraph(db));
    case "/api/note": {
      const note = getNote(db, param("path"));
      if (!note) return fail(404, "No such note. It may have been renamed or deleted.");
      return json({ ...note, html: renderNote(note.body, (target) => getNote(db, target)?.path) });
    }
    case "/api/related": {
      const related = await relatedNotes(db, param("path"), 8);
      return related ? json({ related }) : fail(404, "No such note.");
    }
    default:
      return fail(404, "Not found.");
  }
}

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RangeError("body too large");
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`), {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

/** Serves the web UI on 127.0.0.1 only. Resolves once the port is open. */
export function startWeb(vault: Vault, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    let response: Response;
    try {
      response = await handle(vault, await toRequest(req, port));
    } catch (error) {
      response = error instanceof RangeError || error instanceof TypeError ? fail(400, "Bad request.") : fail(500, "Internal error.");
      if (response.status === 500) console.error(error);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use. Pick another one with --port.`) : error),
    );
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
