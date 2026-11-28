/**
 * WP5 (webext). The runtime messaging protocol between content scripts or extension pages and the
 * service worker. The types are a contract frozen by the L4 scaffold; the guards are WP5's.
 *
 * Every libo11y message is a plain JSON object with `libo11y: 1`, so it survives Chrome's JSON
 * serialization of runtime messages and other listeners can tell it apart.
 */
import type { OtlpSignal } from "@libo11y/web";
import { OTLP_SIGNALS } from "@libo11y/web/internal";

/** The protocol version every message carries. A listener ignores any other value. */
export const PROTOCOL_VERSION = 1;

/** A content script's or page's export batch, for the worker to persist and deliver. */
export interface ExportMessage {
  readonly libo11y: typeof PROTOCOL_VERSION;
  readonly type: "export";
  readonly signal: OtlpSignal;
  /** The OTLP/HTTP JSON request body, exactly as the worker will post it. */
  readonly body: string;
}

/**
 * The worker's answer to an ExportMessage, sent once the batch is in the worker's IndexedDB queue
 * (ok true), or refused: consent closed, malformed, or the queue refused it (ok false, with reason).
 * A refused batch is not retried by the sender.
 */
export interface ExportReply {
  readonly libo11y: typeof PROTOCOL_VERSION;
  readonly type: "export-reply";
  readonly ok: boolean;
  readonly reason?: string;
}

/** An application message carrying the sender's active trace context. */
export interface TracedMessage {
  readonly libo11y: typeof PROTOCOL_VERSION;
  readonly type: "traced";
  /** What the propagator injected: traceparent, and tracestate and baggage when present. */
  readonly carrier: Readonly<Record<string, string>>;
  /** The application's message. */
  readonly payload: unknown;
}

/** The answer to a TracedMessage: the listener's result, or its error message. */
export interface TracedReply {
  readonly libo11y: typeof PROTOCOL_VERSION;
  readonly type: "traced-reply";
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Every libo11y message. */
export type Libo11yMessage = ExportMessage | ExportReply | TracedMessage | TracedReply;

type Fields = Readonly<Record<string, unknown>>;

// libo11y reads m as a libo11y message of the given type: a non-array object with libo11y 1.
function framed(m: unknown, type: Libo11yMessage["type"]): m is Fields {
  return (
    typeof m === "object" &&
    m !== null &&
    !Array.isArray(m) &&
    (m as Fields).libo11y === PROTOCOL_VERSION &&
    (m as Fields).type === type
  );
}

function isCarrier(c: unknown): c is Readonly<Record<string, string>> {
  return (
    typeof c === "object" &&
    c !== null &&
    !Array.isArray(c) &&
    Object.values(c).every((v) => typeof v === "string")
  );
}

/** True for a well-formed ExportMessage: libo11y 1, a known signal and a string body. */
export function isExportMessage(m: unknown): m is ExportMessage {
  return (
    framed(m, "export") &&
    (OTLP_SIGNALS as readonly unknown[]).includes(m.signal) &&
    typeof m.body === "string"
  );
}

/** True for a well-formed TracedMessage: libo11y 1 and a carrier of string values. */
export function isTracedMessage(m: unknown): m is TracedMessage {
  return framed(m, "traced") && isCarrier(m.carrier);
}

/** True for an ExportReply or TracedReply. */
export function isReply(m: unknown): m is ExportReply | TracedReply {
  if (framed(m, "export-reply")) {
    return typeof m.ok === "boolean" && (m.reason === undefined || typeof m.reason === "string");
  }
  if (framed(m, "traced-reply")) {
    return typeof m.ok === "boolean" && (m.error === undefined || typeof m.error === "string");
  }
  return false;
}
