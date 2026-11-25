/**
 * WP5 (webext). Trace context across runtime messages.
 */
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  ROOT_CONTEXT,
  type TextMapPropagator,
} from "@opentelemetry/api";
import type { ChromeLike, RuntimeMessageListener } from "./chrome.ts";
import type { TracedMessageListener, TracedMessaging } from "./options.ts";
import {
  isReply,
  isTracedMessage,
  PROTOCOL_VERSION,
  type TracedMessage,
  type TracedReply,
} from "./protocol.ts";

// tracedMessage wraps payload with the active context, synchronously, so the caller's span is the
// one injected even when the send itself is awaited later.
function tracedMessage(propagator: TextMapPropagator, payload: unknown): TracedMessage {
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, defaultTextMapSetter);
  return { libo11y: PROTOCOL_VERSION, type: "traced", carrier, payload };
}

async function unwrap<R>(reply: Promise<unknown>): Promise<R> {
  const r = await reply;
  if (!isReply(r) || r.type !== "traced-reply") {
    throw new Error("o11y: no traced reply: no traced listener answered the message");
  }
  if (!r.ok) throw new Error(r.error ?? "o11y: the traced listener failed");
  return r.result as R;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) return String(err.message);
  return String(err);
}

function ok(result: unknown): TracedReply {
  return result === undefined
    ? { libo11y: PROTOCOL_VERSION, type: "traced-reply", ok: true }
    : { libo11y: PROTOCOL_VERSION, type: "traced-reply", ok: true, result };
}

function failed(err: unknown): TracedReply {
  return { libo11y: PROTOCOL_VERSION, type: "traced-reply", ok: false, error: errorText(err) };
}

/**
 * Traced messaging over chrome with propagator (the telemetry's, so the baggage egress filter
 * applies). sendMessage injects the active context into a TracedMessage and unwraps the
 * TracedReply. onMessage extracts the carrier and runs the listener under context.with(extracted),
 * answers with a TracedReply (awaiting a promise result, returning true from the chrome listener),
 * and ignores any message that is not a TracedMessage.
 */
export function createTracedMessaging(chrome: ChromeLike, propagator: TextMapPropagator): TracedMessaging {
  return {
    onMessage(listener: TracedMessageListener): () => void {
      const onRuntimeMessage: RuntimeMessageListener = (message, sender, sendResponse) => {
        if (!isTracedMessage(message)) return undefined;
        const extracted = propagator.extract(ROOT_CONTEXT, message.carrier, defaultTextMapGetter);
        let result: unknown;
        try {
          result = context.with(extracted, () => listener(message.payload, sender));
        } catch (err) {
          sendResponse(failed(err));
          return undefined;
        }
        if (typeof (result as PromiseLike<unknown> | undefined)?.then !== "function") {
          sendResponse(ok(result));
          return undefined;
        }
        Promise.resolve(result).then(
          (value) => sendResponse(ok(value)),
          (err: unknown) => sendResponse(failed(err)),
        );
        return true;
      };
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    },
    sendMessage<R = unknown>(payload: unknown): Promise<R> {
      const message = tracedMessage(propagator, payload);
      return unwrap<R>(chrome.runtime.sendMessage(message));
    },
  };
}

/** tabs.sendMessage counterpart of TracedMessaging.sendMessage. */
export function sendTracedTabMessage<R>(
  chrome: ChromeLike,
  propagator: TextMapPropagator,
  tabId: number,
  payload: unknown,
): Promise<R> {
  if (chrome.tabs === undefined) {
    return Promise.reject(new Error("o11y: chrome.tabs is unavailable in this context"));
  }
  const message = tracedMessage(propagator, payload);
  return unwrap<R>(chrome.tabs.sendMessage(tabId, message));
}
