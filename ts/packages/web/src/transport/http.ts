/**
 * WP1 (transport). The OTLP/HTTP JSON Transport over fetch, fetch keepalive and sendBeacon.
 */
import type { SendRequest, SendResult, Transport } from "../contracts/transport.ts";
import { canGzip, gzip } from "./compress.ts";
import type { SignalEndpoints } from "./endpoints.ts";
import { pristineFetch, pristineSendBeacon } from "./pristine.ts";
import { parseRetryAfter, RETRYABLE_STATUSES } from "./retry.ts";

/** The largest body fetch keepalive and sendBeacon take, and the keepalive bytes in flight per document. */
export const UNLOAD_BODY_LIMIT = 65_536;

/** Options for createHttpTransport. */
export interface HttpTransportOptions {
  readonly endpoints: SignalEndpoints;
  readonly headers?: Readonly<Record<string, string>>;
  /** Default "gzip". */
  readonly compression?: "gzip" | "none";
  /** Default 10000. */
  readonly timeoutMillis?: number;
  /** Default pristineFetch. */
  readonly fetch?: typeof fetch;
  /** Default pristineSendBeacon; pass undefined explicitly where beacons do not exist (MV3 workers). */
  readonly sendBeacon?: ((url: string, data: BodyInit) => boolean) | undefined;
  /** Default () => navigator.onLine !== false. */
  readonly isOnline?: () => boolean;
}

const DEFAULT_TIMEOUT_MILLIS = 10_000;
const UNLOAD_BUDGET: SendResult = { kind: "retry", reason: "unload budget" };

function navigatorOnline(): boolean {
  return (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false;
}

// timeoutSignal is AbortSignal.timeout where it exists, else an AbortController a timer aborts
// with an Error named TimeoutError, because bare React Native has no DOMException. dispose clears
// the fallback timer.
function timeoutSignal(ms: number): { signal: AbortSignal; dispose: () => void } {
  if (typeof AbortSignal.timeout === "function")
    return { signal: AbortSignal.timeout(ms), dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(Object.assign(new Error("request timed out"), { name: "TimeoutError" })),
    ms,
  );
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
}

function classify(res: Response): SendResult {
  if (res.status >= 200 && res.status < 300) return { kind: "ok" };
  const reason = `HTTP ${res.status}`;
  if (!RETRYABLE_STATUSES.has(res.status)) return { kind: "fatal", reason, status: res.status };
  const retryAfterMillis =
    res.status === 429 || res.status === 503
      ? parseRetryAfter(res.headers.get("Retry-After"), Date.now())
      : undefined;
  return retryAfterMillis === undefined
    ? { kind: "retry", reason }
    : { kind: "retry", reason, retryAfterMillis };
}

/**
 * Builds the HTTP Transport. Each send posts the batch to its signal's URL with Content-Type
 * application/json. "normal" uses fetch with an AbortSignal timeout and gzip-compresses the body with
 * Content-Encoding gzip when compression is on and the runtime can. "unload" never compresses, so
 * the request is issued synchronously. It uses fetch with keepalive when the body fits
 * UNLOAD_BODY_LIMIT and the keepalive bytes in flight leave room, else sendBeacon with the uncompressed body as an application/json Blob when no headers are
 * configured and it fits, else a retry result with reason "unload budget". Offline (isOnline false)
 * is a retry without a request. A signal without a URL is fatal. Statuses map as SendResult
 * documents, with Retry-After parsed for 429 and 503.
 */
export function createHttpTransport(opts: HttpTransportOptions): Transport {
  const fetchImpl = opts.fetch ?? pristineFetch;
  const sendBeacon = "sendBeacon" in opts ? opts.sendBeacon : pristineSendBeacon;
  const isOnline = opts.isOnline ?? navigatorOnline;
  const timeoutMillis = opts.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;
  const gzipOn = (opts.compression ?? "gzip") === "gzip";
  const userHeaders = opts.headers ?? {};
  const hasHeaders = Object.keys(userHeaders).length > 0;
  const encoder = new TextEncoder();
  // The keepalive bytes this transport has in flight; the browser refuses a keepalive fetch past
  // 64 KiB in flight per document, so the transport never asks for one it would refuse.
  let keepaliveInFlight = 0;

  async function post(
    url: string,
    body: Uint8Array,
    gzipped: boolean,
    keepalive: boolean,
  ): Promise<SendResult> {
    if (fetchImpl === undefined) return { kind: "fatal", reason: "fetch is unavailable" };
    const timeout = timeoutSignal(timeoutMillis);
    try {
      const headers = new Headers(userHeaders);
      headers.set("Content-Type", "application/json");
      if (gzipped) headers.set("Content-Encoding", "gzip");
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: body as Uint8Array<ArrayBuffer>,
        signal: timeout.signal,
        ...(keepalive ? { keepalive: true } : {}),
      });
      const result = classify(res);
      res.body?.cancel().catch(() => {});
      return result;
    } catch (err) {
      const name = errorName(err);
      if (name === "TimeoutError" || (name === "AbortError" && timeout.signal.aborted)) {
        return { kind: "retry", reason: "timeout" };
      }
      return { kind: "retry", reason: `network error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      timeout.dispose();
    }
  }

  function beacon(url: string, raw: Uint8Array): SendResult {
    try {
      const sent = sendBeacon?.(
        url,
        new Blob([raw as Uint8Array<ArrayBuffer>], { type: "application/json" }),
      );
      return sent === true ? { kind: "ok" } : { kind: "retry", reason: "beacon refused" };
    } catch (err) {
      return { kind: "retry", reason: `beacon refused: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Unload sends are never compressed: CompressionStream resolves in a later task, and on a real
  // navigation the document is gone by then, so the request would never be issued. Everything up
  // to the keepalive fetch or the beacon runs synchronously in the hide or pagehide handler.
  async function unload(url: string, raw: Uint8Array): Promise<SendResult> {
    const size = raw.byteLength;
    if (size <= UNLOAD_BODY_LIMIT && keepaliveInFlight + size <= UNLOAD_BODY_LIMIT) {
      keepaliveInFlight += size;
      try {
        return await post(url, raw, false, true);
      } finally {
        keepaliveInFlight -= size;
      }
    }
    if (sendBeacon !== undefined && !hasHeaders && raw.byteLength <= UNLOAD_BODY_LIMIT)
      return beacon(url, raw);
    return UNLOAD_BUDGET;
  }

  async function send(req: SendRequest): Promise<SendResult> {
    const url = opts.endpoints[req.signal];
    if (url === undefined) return { kind: "fatal", reason: `no OTLP endpoint for ${req.signal}` };
    if (!isOnline()) return { kind: "retry", reason: "offline" };
    const raw = encoder.encode(req.body);
    if (req.mode === "unload") return unload(url, raw);
    const compressed = gzipOn && canGzip() ? await gzip(raw) : undefined;
    return post(url, compressed ?? raw, compressed !== undefined, false);
  }

  return {
    async send(req) {
      try {
        return await send(req);
      } catch (err) {
        return { kind: "retry", reason: `send failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
