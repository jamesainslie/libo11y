/**
 * Scaffold, frozen. The fixture server and OTLP sink for the browser tests, on Bun. It binds
 * 127.0.0.1; Chromium maps localhost to it too, so http://localhost:<port> is a second origin.
 *
 *   GET  /health                         200 "ok"
 *   GET  /page/<name>[?serverTiming=tp]  an HTML page loading /bundles/<name>.js; with serverTiming,
 *                                        the response carries Server-Timing: traceparent;desc="tp";
 *                                        with csp=1, Content-Security-Policy: img-src 'self'; with
 *                                        csp=strict, a strict policy (STRICT_CSP) with Trusted Types
 *   GET  /page/<name>/<path...>          the same page, for history navigations that were reloaded
 *   GET  /bundles/<file>                 dist/bundles/<file>
 *   ANY  /echo[?delay=ms]                JSON of the request method, headers and body text (CORS open),
 *                                        after delay milliseconds (at most 5000) when given
 *   GET  /asset/<file>?type=js|css|png[&delay=ms][&serverTiming=tp]
 *                                        a tiny body of that type with Timing-Allow-Origin: *, after
 *                                        delay milliseconds (at most 5000); with serverTiming,
 *                                        Server-Timing: traceparent;desc="tp", db;dur=12
 *   POST /sink/<id>/v1/<signal>          records an OTLP request (gzip decoded), answers from the script
 *   POST /sink/<id>/v1/replay            records a session replay upload the same way, with its query
 *   POST /sink/<id>/script               body {"responses":[{"status":429,"retryAfter":"1"}, ...]}:
 *                                        the next requests get these answers in order, then 200
 *   POST /sink/<id>/offline              body {"offline":true|false}: while true, sink requests are
 *                                        answered by closing the connection (a network error)
 *   GET  /sink/<id>/received             {"requests":[SinkRequest...]} in arrival order
 *   POST /sink/<id>/config               body {"version":"...","config":{...}}: the remote configuration
 *                                        GET /sink/<id>/v1/config serves from now on
 *   GET  /sink/<id>/v1/config            the RUM gateway config endpoint: 404 until a document was
 *                                        posted, then the document with ETag "<version>", or 304 when
 *                                        If-None-Match names it; the requests count in /received as
 *                                        configRequests
 *
 * Every sink response allows CORS from any origin, with Content-Type, Content-Encoding and any
 * requested header, and exposes Retry-After. Sinks are separate per <id>, so parallel tests never
 * share one.
 */

import { join, normalize, resolve } from "node:path";
import { gunzipSync } from "bun";

/** One recorded OTLP request, as /received returns it. */
export interface SinkRequest {
  readonly signal: string;
  readonly contentType: string;
  readonly encoding: string | null;
  /** Bytes on the wire, before gunzip. */
  readonly bytes: number;
  /** The Origin request header. Whether a request was keepalive or a beacon is not visible here; the page reports that. */
  readonly origin: string | null;
  /** The request's query parameters, such as a replay upload's service, session and segment. */
  readonly query: Record<string, string>;
  readonly body: unknown;
}

interface Scripted {
  readonly status: number;
  readonly retryAfter?: string;
}

interface Sink {
  readonly requests: SinkRequest[];
  config: { readonly version: string; readonly config: unknown } | undefined;
  configRequests: number;
  script: Scripted[];
  offline: boolean;
}

const port = Number(process.env.LIBO11Y_BROWSER_PORT ?? "47311");
const bundles = resolve(import.meta.dirname, "..", "dist", "bundles");
const sinks = new Map<string, Sink>();

function sinkFor(id: string): Sink {
  let s = sinks.get(id);
  if (s === undefined) {
    s = { requests: [], script: [], offline: false, config: undefined, configRequests: 0 };
    sinks.set(id, s);
  }
  return s;
}

function cors(req: Request, headers: Headers = new Headers()): Headers {
  headers.set("Access-Control-Allow-Origin", req.headers.get("Origin") ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    req.headers.get("Access-Control-Request-Headers") ?? "Content-Type, Content-Encoding",
  );
  headers.set("Access-Control-Expose-Headers", "Retry-After, ETag");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Timing-Allow-Origin", "*");
  headers.set("Vary", "Origin");
  return headers;
}

function json(req: Request, value: unknown, status = 200): Response {
  const headers = cors(req);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

async function recordOtlp(req: Request, url: URL, sink: Sink, signal: string): Promise<Response> {
  const raw = new Uint8Array(await req.arrayBuffer());
  const encoding = req.headers.get("Content-Encoding");
  let body: unknown;
  try {
    const text = new TextDecoder().decode(encoding === "gzip" ? gunzipSync(raw) : raw);
    body = JSON.parse(text);
  } catch (err) {
    body = { undecodable: String(err) };
  }
  sink.requests.push({
    signal,
    contentType: req.headers.get("Content-Type") ?? "",
    encoding,
    bytes: raw.byteLength,
    origin: req.headers.get("Origin"),
    query: Object.fromEntries(url.searchParams),
    body,
  });
  const next = sink.script.shift();
  const headers = cors(req);
  if (next?.retryAfter !== undefined) headers.set("Retry-After", next.retryAfter);
  headers.set("Content-Type", "application/json");
  return new Response("{}", { status: next?.status ?? 200, headers });
}

/** A 1x1 transparent PNG. */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const ASSETS: Readonly<Record<string, { readonly type: string; readonly body: string | Blob }>> = {
  js: { type: "text/javascript", body: "globalThis.__assetLoaded = true;\n" },
  css: { type: "text/css", body: "main { margin: 0; }\n" },
  png: { type: "image/png", body: new Blob([PNG]) },
};

async function asset(url: URL): Promise<Response> {
  const kind = ASSETS[url.searchParams.get("type") ?? ""];
  if (kind === undefined) return new Response("unknown type", { status: 400 });
  const delay = Math.min(5000, Math.max(0, Number(url.searchParams.get("delay") ?? "0") || 0));
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const headers = new Headers({
    "Content-Type": kind.type,
    "Cache-Control": "no-store",
    "Timing-Allow-Origin": "*",
  });
  const tp = url.searchParams.get("serverTiming");
  if (tp !== null) headers.set("Server-Timing", `traceparent;desc="${tp}", db;dur=12`);
  return new Response(kind.body, { headers });
}

/** The csp=strict policy: same-origin only, no inline script, no workers, Trusted Types for script sinks. */
const STRICT_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'none'; require-trusted-types-for 'script'";

function page(name: string, serverTiming: string | null, csp: string | null): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (serverTiming !== null) headers.set("Server-Timing", `traceparent;desc="${serverTiming}"`);
  if (csp === "1") headers.set("Content-Security-Policy", "img-src 'self'");
  if (csp === "strict") headers.set("Content-Security-Policy", STRICT_CSP);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><script type="module" src="/bundles/${name}.js"></script></body></html>`;
  return new Response(html, { headers });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter((p) => p !== "");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (url.pathname === "/health") return new Response("ok");
    if (parts[0] === "page" && parts.length >= 2 && parts[1] !== undefined) {
      return page(parts[1], url.searchParams.get("serverTiming"), url.searchParams.get("csp"));
    }
    if (parts[0] === "bundles" && parts.length >= 2) {
      const file = normalize(join(bundles, ...parts.slice(1)));
      if (!file.startsWith(bundles)) return new Response("forbidden", { status: 403 });
      const f = Bun.file(file);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } });
    }
    if (parts[0] === "asset" && req.method === "GET") return asset(url);
    if (parts[0] === "echo") {
      const delay = Math.min(5000, Math.max(0, Number(url.searchParams.get("delay") ?? "0") || 0));
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return json(req, {
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      });
    }
    if (parts[0] === "sink" && parts[1] !== undefined) {
      const sink = sinkFor(parts[1]);
      const rest = parts.slice(2).join("/");
      if (rest === "received" && req.method === "GET") {
        return json(req, { requests: sink.requests, configRequests: sink.configRequests });
      }
      if (rest === "config" && req.method === "POST") {
        sink.config = (await req.json()) as { version: string; config: unknown };
        return json(req, { ok: true });
      }
      if (rest === "v1/config" && req.method === "GET") {
        sink.configRequests++;
        if (sink.config === undefined) return json(req, { error: "no_remote_config" }, 404);
        const etag = `"${sink.config.version}"`;
        if (req.headers.get("If-None-Match") === etag) {
          const headers = cors(req);
          headers.set("ETag", etag);
          return new Response(null, { status: 304, headers });
        }
        const res = json(req, sink.config);
        res.headers.set("ETag", etag);
        return res;
      }
      if (rest === "script" && req.method === "POST") {
        const { responses } = (await req.json()) as { responses: Scripted[] };
        sink.script = [...responses];
        return json(req, { ok: true });
      }
      if (rest === "offline" && req.method === "POST") {
        sink.offline = ((await req.json()) as { offline: boolean }).offline;
        return json(req, { ok: true });
      }
      const signal = /^v1\/(traces|metrics|logs|replay)$/.exec(rest)?.[1];
      if (signal !== undefined && req.method === "POST") {
        if (sink.offline) {
          srv.timeout(req, 1);
          return new Promise<Response>(() => {});
        }
        return recordOtlp(req, url, sink, signal);
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`libo11y browser fixture server on ${server.url}`);
