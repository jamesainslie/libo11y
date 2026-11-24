/**
 * HTTP helpers for the serve and fetch tests: a node:http adapter that runs a fetch-style handler,
 * a Bun.serve handle typed without @types/bun, and listen/close helpers that always settle.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/** Adapts a fetch-style handler to node:http: the request becomes a Request, the Response is streamed back. */
export function nodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void serveOne(handler, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
}

async function serveOne(
  handler: (req: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  } as RequestInit);
  const response = await handler(request);
  const out: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") out.push([name, value]);
  });
  for (const cookie of response.headers.getSetCookie()) out.push(["set-cookie", cookie]);
  res.writeHead(response.status, response.statusText, out.flat());
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.once("close", () => {
    if (!res.writableFinished) void reader.cancel().catch(() => {});
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Backpressure: read on only once the client has taken what was written.
    if (!res.write(value) && !(await drained(res))) {
      await reader.cancel().catch(() => {});
      return;
    }
  }
  res.end();
}

/** Waits for res to drain: true when it did, false when the connection closed first. */
function drained(res: ServerResponse): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onDrain = (): void => {
      res.off("close", onClose);
      resolve(true);
    };
    const onClose = (): void => {
      res.off("drain", onDrain);
      resolve(false);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/** Starts a node:http server on a free loopback port and returns its base URL, without a trailing slash. */
export function listen(listener: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer(listener);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

/** Closes a node:http server, dropping open connections, and waits at most a second. */
export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    server.closeAllConnections();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The Bun.serve surface the tests use, so they typecheck without depending on Bun's types. */
export interface BunServer {
  readonly port: number;
  stop(force?: boolean): Promise<void> | void;
}

export interface BunServeGlobal {
  /** Bun.file: a lazily read file, which Bun.serve can send with sendfile. */
  file(path: string): Blob;
  serve(opts: {
    port: number;
    hostname: string;
    fetch(req: Request, server: unknown): Response | Promise<Response>;
  }): BunServer;
}

/** Bun, when the tests run under it. */
export const bun: BunServeGlobal | undefined = (globalThis as unknown as { Bun?: BunServeGlobal }).Bun;
export const IS_BUN: boolean = bun !== undefined;
