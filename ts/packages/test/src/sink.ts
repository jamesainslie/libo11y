/**
 * An in-process OTLP/HTTP sink for tests: a node:http server on 127.0.0.1 that accepts
 * POST /v1/traces, /v1/metrics and /v1/logs as application/json or application/x-protobuf, plain
 * or gzip-encoded, and keeps each request decoded into its OTLP/JSON shape. It works on Bun and Node.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { decodeOtlpProtobuf, type OtlpSignal } from "./otlp-schema.ts";

/** One request the sink received on a signal path. */
export interface OtlpRequestInfo {
  readonly path: string;
  /** The media type, without parameters. */
  readonly contentType: string;
  /** The Content-Encoding header, when present. */
  readonly encoding: string | undefined;
  /** The body's length as received, before inflating. */
  readonly bytes: number;
}

/** Options for startOtlpSink. */
export interface OtlpSinkOptions {
  /** The status every signal request gets, to simulate 429 or 503. Default 200. Only 200 stores. */
  readonly status?: number;
  /** A Retry-After header sent with every signal request's response. */
  readonly retryAfter?: string;
}

/** A running OTLP/HTTP sink. */
export interface OtlpSink {
  /** The base URL, http://127.0.0.1:<port>, for OTEL_EXPORTER_OTLP_ENDPOINT. */
  readonly url: string;
  /** Each accepted ExportTraceServiceRequest, decoded into OTLP/JSON shape, in arrival order. */
  traces(): readonly unknown[];
  /** Each accepted ExportMetricsServiceRequest, decoded into OTLP/JSON shape, in arrival order. */
  metrics(): readonly unknown[];
  /** Each accepted ExportLogsServiceRequest, decoded into OTLP/JSON shape, in arrival order. */
  logs(): readonly unknown[];
  /** Every request to a signal path, whatever its outcome, in arrival order. */
  requests(): readonly OtlpRequestInfo[];
  /** Resolves once signal has count accepted requests (default 1); rejects after timeoutMillis (default 5000). */
  waitFor(signal: OtlpSignal, count?: number, timeoutMillis?: number): Promise<void>;
  /** Stops the server and drops open connections. Idempotent. */
  close(): Promise<void>;
}

const PATHS: Readonly<Record<string, OtlpSignal>> = {
  "/v1/traces": "traces",
  "/v1/metrics": "metrics",
  "/v1/logs": "logs",
};

const PROTOBUF_TYPES: ReadonlySet<string> = new Set(["application/x-protobuf", "application/protobuf"]);
const JSON_TYPE = "application/json";

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function decode(signal: OtlpSignal, contentType: string, body: Uint8Array): unknown {
  try {
    if (contentType === JSON_TYPE) return JSON.parse(new TextDecoder().decode(body)) as unknown;
    return decodeOtlpProtobuf(signal, body);
  } catch (err) {
    throw new HttpError(
      400,
      `o11ytest: sink: decoding ${signal}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface Waiter {
  readonly signal: OtlpSignal;
  readonly count: number;
  readonly resolve: () => void;
}

/** Starts an OTLP/HTTP sink on 127.0.0.1 at a free port. */
export async function startOtlpSink(opts: OtlpSinkOptions = {}): Promise<OtlpSink> {
  const status = opts.status ?? 200;
  const received: Record<OtlpSignal, unknown[]> = { traces: [], metrics: [], logs: [] };
  const requests: OtlpRequestInfo[] = [];
  let waiters: Waiter[] = [];

  const settle = (): void => {
    waiters = waiters.filter((w) => {
      if (received[w.signal].length < w.count) return true;
      w.resolve();
      return false;
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const signal = PATHS[path];
    if (signal === undefined) throw new HttpError(404, `o11ytest: sink: no such path ${path}`);
    if (req.method !== "POST") throw new HttpError(405, `o11ytest: sink: ${req.method ?? ""} not allowed`);
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const encoding = req.headers["content-encoding"]?.trim().toLowerCase();
    const raw = await readBody(req);
    requests.push({ path, contentType, encoding, bytes: raw.length });
    if (contentType !== JSON_TYPE && !PROTOBUF_TYPES.has(contentType)) {
      throw new HttpError(415, `o11ytest: sink: unsupported content type ${contentType}`);
    }
    if (encoding !== undefined && encoding !== "gzip" && encoding !== "identity") {
      throw new HttpError(415, `o11ytest: sink: unsupported content encoding ${encoding}`);
    }
    if (opts.retryAfter !== undefined) res.setHeader("retry-after", opts.retryAfter);
    if (status !== 200) {
      res.writeHead(status, { "content-type": contentType, "content-length": "0" }).end();
      return;
    }
    let body: Uint8Array;
    try {
      body = encoding === "gzip" ? gunzipSync(raw) : raw;
    } catch (err) {
      throw new HttpError(
        400,
        `o11ytest: sink: inflating: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    received[signal].push(decode(signal, contentType, body));
    res.writeHead(200, { "content-type": contentType, "content-length": "0" }).end();
    settle();
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const code = err instanceof HttpError ? err.status : 500;
      const text = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    traces: () => [...received.traces],
    metrics: () => [...received.metrics],
    logs: () => [...received.logs],
    requests: () => [...requests],
    waitFor(signal: OtlpSignal, count = 1, timeoutMillis = 5000): Promise<void> {
      if (received[signal].length >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== waiter);
          reject(
            new Error(
              `o11ytest: sink: timed out after ${timeoutMillis} ms waiting for ${count} ${signal} request(s); ` +
                `received ${received[signal].length}`,
            ),
          );
        }, timeoutMillis);
        timer.unref?.();
        const waiter: Waiter = {
          signal,
          count,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
        waiters.push(waiter);
      });
    },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
