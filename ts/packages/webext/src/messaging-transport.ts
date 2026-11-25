/**
 * WP5 (webext). The Transport a content script or extension page uses: each batch goes to the
 * worker as an ExportMessage.
 */
import type { Transport } from "@libo11y/web/internal";
import type { ChromeLike } from "./chrome.ts";

/**
 * A Transport over runtime.sendMessage. An ExportReply with ok true is "ok", with ok false is
 * "fatal" with its reason; no answer, a rejected sendMessage (the worker is starting or the
 * extension reloaded) or a timeout of timeoutMillis (default 10000) is "retry". The mode is
 * ignored: messaging has no unload budget.
 */
export function createMessagingTransport(chrome: ChromeLike, timeoutMillis?: number): Transport {
  void chrome;
  void timeoutMillis;
  throw new Error("not implemented");
}
