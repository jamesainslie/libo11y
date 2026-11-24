/**
 * Adapts a fetch-style handler, (Request) => Promise<Response>, to node:http: the incoming message
 * becomes a Request and the Response is streamed back. Frameworks such as Hono ship adapters like
 * this one; it is here so the example has no dependency beyond @libo11y/server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** A node:http request listener that serves each request with handler. */
export function toNodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    serve(handler, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
}

async function serve(
  handler: (req: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
      headers.append(name, v);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const response = await handler(
    new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, init),
  );

  const out: string[] = [];
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") out.push(name, value);
  });
  for (const cookie of response.headers.getSetCookie()) out.push("set-cookie", cookie);
  res.writeHead(response.status, response.statusText, out);
  if (response.body === null) {
    res.end();
    return;
  }
  // Cancelling the body when the client goes away ends the server span.
  const reader = response.body.getReader();
  res.once("close", () => {
    if (!res.writableFinished) reader.cancel().catch(() => {});
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
