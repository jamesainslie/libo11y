/**
 * The Transport a content script or extension page uses: each batch goes to the
 * worker as an ExportMessage.
 */
import type { SendResult, Transport } from "@libo11y/web/internal";
import type { ChromeLike } from "./chrome.ts";
import { type ExportMessage, isReply, PROTOCOL_VERSION } from "./protocol.ts";

const DEFAULT_TIMEOUT_MILLIS = 10_000;

const TIMEOUT: unique symbol = Symbol("timeout") as never;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A Transport over runtime.sendMessage. An ExportReply with ok true is "ok", with ok false is
 * "fatal" with its reason; no answer, a rejected sendMessage (the worker is starting or the
 * extension reloaded) or a timeout of timeoutMillis (default 10000) is "retry". The mode is
 * ignored: messaging has no unload budget.
 */
export function createMessagingTransport(
  chrome: ChromeLike,
  timeoutMillis: number = DEFAULT_TIMEOUT_MILLIS,
): Transport {
  return {
    async send(req): Promise<SendResult> {
      const message: ExportMessage = {
        libo11y: PROTOCOL_VERSION,
        type: "export",
        signal: req.signal,
        body: req.body,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMillis);
      });
      let reply: unknown;
      try {
        reply = await Promise.race([chrome.runtime.sendMessage(message), expired]);
      } catch (err) {
        return { kind: "retry", reason: `o11y: messaging the worker: ${errorText(err)}` };
      } finally {
        clearTimeout(timer);
      }
      if (reply === TIMEOUT) {
        return { kind: "retry", reason: `o11y: messaging the worker: timeout after ${timeoutMillis} ms` };
      }
      if (!isReply(reply) || reply.type !== "export-reply") {
        return { kind: "retry", reason: "o11y: messaging the worker: no export reply" };
      }
      if (reply.ok) return { kind: "ok" };
      return { kind: "fatal", reason: `o11y: the worker refused the batch: ${reply.reason ?? "no reason"}` };
    },
  };
}
