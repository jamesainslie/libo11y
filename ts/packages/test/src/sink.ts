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
  /** Stops the server, drops open connections and rejects pending waitFor calls. Idempotent. */
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

/** The default cap on a request body as received: 32 MiB. */
export const MAX_BODY_BYTES: number = 32 * 1024 * 1024;

/** The default cap on a gzip body once inflated: 32 MiB. */
export const MAX_INFLATED_BYTES: number = 32 * 1024 * 1024;

/** Size limits for a sink. Internal: startOtlpSink uses the 32 MiB defaults. */
export interface SinkLimits {
  readonly maxBodyBytes: number;
  readonly maxInflatedBytes: number;
}

// readBody collects the body, counting into seen. Past limit it stops collecting and rejects with
// 413; the rest of the body is discarded unread.
function readBody(req: IncomingMessage, limit: number, seen: { bytes: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      seen.bytes += chunk.length;
      if (seen.bytes > limit) {
        req.off("data", onData);
        req.resume();
        reject(new HttpError(413, `o11ytest: sink: body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function inflate(raw: Buffer, limit: number): Buffer {
  try {
    return gunzipSync(raw, { maxOutputLength: limit });
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new HttpError(413, `o11ytest: sink: inflated body exceeds ${limit} bytes`);
    }
    throw new HttpError(
      400,
      `o11ytest: sink: inflating: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function decode(signal: OtlpSignal, contentType: string, body: Uint8Array): unknown {
  let value: unknown;
  try {
    value =
      contentType === JSON_TYPE
        ? JSON.parse(new TextDecoder().decode(body))
        : decodeOtlpProtobuf(signal, body);
  } catch (err) {
    throw new HttpError(
      400,
      `o11ytest: sink: decoding ${signal}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `o11ytest: sink: decoding ${signal}: the JSON body is not an object`);
  }
  return value;
}

interface Waiter {
  readonly signal: OtlpSignal;
  readonly count: number;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

/** Starts an OTLP/HTTP sink on 127.0.0.1 at a free port. Bodies are capped at 32 MiB, inflated or not. */
export function startOtlpSink(opts: OtlpSinkOptions = {}): Promise<OtlpSink> {
  return startOtlpSinkWithLimits(opts, {
    maxBodyBytes: MAX_BODY_BYTES,
    maxInflatedBytes: MAX_INFLATED_BYTES,
  });
}

/** startOtlpSink with explicit size limits. Internal: not exported from the package. */
export async function startOtlpSinkWithLimits(opts: OtlpSinkOptions, limits: SinkLimits): Promise<OtlpSink> {
  const status = opts.status ?? 200;
  const received: Record<OtlpSignal, unknown[]> = { traces: [], metrics: [], logs: [] };
  const requests: OtlpRequestInfo[] = [];
  let waiters: Waiter[] = [];
  let closed = false;

  const settle = (): void => {
    waiters = waiters.filter((w) => {
      if (received[w.signal].length < w.count) return true;
      w.resolve();
      return false;
    });
  };

  const closedError = (signal: OtlpSignal, count: number): Error =>
    new Error(
      `o11ytest: sink: closed while waiting for ${count} ${signal} request(s); received ${received[signal].length}`,
    );

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const signal = PATHS[path];
    if (signal === undefined) throw new HttpError(404, `o11ytest: sink: no such path ${path}`);
    if (req.method !== "POST") throw new HttpError(405, `o11ytest: sink: ${req.method ?? ""} not allowed`);
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const encoding = req.headers["content-encoding"]?.trim().toLowerCase();
    const seen = { bytes: 0 };
    let raw: Buffer;
    try {
      raw = await readBody(req, limits.maxBodyBytes, seen);
    } finally {
      requests.push({ path, contentType, encoding, bytes: seen.bytes });
    }
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
    const body = encoding === "gzip" ? inflate(raw, limits.maxInflatedBytes) : raw;
    received[signal].push(decode(signal, contentType, body));
    res.writeHead(200, { "content-type": contentType, "content-length": "0" }).end();
    settle();
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const code = err instanceof HttpError ? err.status : 500;
      const text = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(code, {
          "content-type": "text/plain; charset=utf-8",
          // A body cut off at the limit leaves unread bytes on the connection.
          ...(code === 413 ? { connection: "close" } : {}),
        });
      }
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
      if (closed) return Promise.reject(closedError(signal, count));
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
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        waiters.push(waiter);
      });
    },
    close(): Promise<void> {
      closed = true;
      for (const w of waiters) w.reject(closedError(w.signal, w.count));
      waiters = [];
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
