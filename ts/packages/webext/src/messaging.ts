/**
 * WP5 (webext). Trace context across runtime messages.
 */
import type { TextMapPropagator } from "@opentelemetry/api";
import type { ChromeLike } from "./chrome.ts";
import type { TracedMessaging } from "./options.ts";

/**
 * Traced messaging over chrome with propagator (the telemetry's, so the baggage egress filter
 * applies). sendMessage injects the active context into a TracedMessage and unwraps the
 * TracedReply. onMessage extracts the carrier and runs the listener under context.with(extracted),
 * answers with a TracedReply (awaiting a promise result, returning true from the chrome listener),
 * and ignores any message that is not a TracedMessage.
 */
export function createTracedMessaging(chrome: ChromeLike, propagator: TextMapPropagator): TracedMessaging {
  void chrome;
  void propagator;
  throw new Error("not implemented");
}

/** tabs.sendMessage counterpart of TracedMessaging.sendMessage. */
export function sendTracedTabMessage<R>(
  chrome: ChromeLike,
  propagator: TextMapPropagator,
  tabId: number,
  payload: unknown,
): Promise<R> {
  void chrome;
  void propagator;
  void tabId;
  void payload;
  throw new Error("not implemented");
}
