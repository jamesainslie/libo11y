/**
 * A fake RUM gateway for the upload tests: a node:http server on 127.0.0.1 that records each
 * source map upload and answers with a scripted status.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

/** One upload the fake gateway received. */
export interface RecordedUpload {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string | undefined;
  readonly encoding: string | undefined;
  readonly body: string;
}

/** A running fake gateway. */
export interface FakeGateway {
  readonly url: string;
  readonly uploads: RecordedUpload[];
  /** The most requests that were in flight at once. */
  maxInFlight(): number;
  close(): Promise<void>;
}

/**
 * Starts a fake gateway. status picks each response's status from the upload's 0-based arrival
 * index and its query; the default is 201. delayMillis holds each response, so concurrency shows.
 */
export async function startFakeGateway(
  status: (index: number, query: Readonly<Record<string, string>>) => number = () => 201,
  delayMillis = 0,
): Promise<FakeGateway> {
  const uploads: RecordedUpload[] = [];
  let inFlight = 0;
  let peak = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const encoding = req.headers["content-encoding"];
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const query = Object.fromEntries(url.searchParams);
      const index = uploads.length;
      uploads.push({
        method: req.method ?? "",
        path: url.pathname,
        query,
        authorization: req.headers.authorization,
        encoding,
        body: (encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8"),
      });
      const code = status(index, query);
      setTimeout(() => {
        inFlight--;
        res.writeHead(code, { "content-type": "application/json" });
        res.end(code === 201 ? JSON.stringify({ key: `k-${index}` }) : "refused");
      }, delayMillis);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    uploads,
    maxInFlight: () => peak,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
