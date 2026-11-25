/**
 * WP1 (transport). The OTLP/HTTP JSON Transport over fetch, fetch keepalive and sendBeacon.
 */
import type { Transport } from "../contracts/transport.ts";
import type { SignalEndpoints } from "./endpoints.ts";

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

/**
 * Builds the HTTP Transport. Each send posts the batch to its signal's URL with Content-Type
 * application/json, gzip-compressed with Content-Encoding gzip when compression is on and the
 * runtime can. "normal" uses fetch with an AbortSignal timeout. "unload" uses fetch with keepalive
 * when the (compressed) body fits UNLOAD_BODY_LIMIT and the keepalive bytes in flight leave room,
 * else sendBeacon with the uncompressed body as an application/json Blob when no headers are
 * configured and it fits, else a retry result with reason "unload budget". Offline (isOnline false)
 * is a retry without a request. A signal without a URL is fatal. Statuses map as SendResult
 * documents, with Retry-After parsed for 429 and 503.
 */
export function createHttpTransport(opts: HttpTransportOptions): Transport {
  void opts;
  throw new Error("not implemented");
}
