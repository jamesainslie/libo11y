/**
 * WP4 (instrumentation). Client spans for XMLHttpRequest.
 */
import type { HttpInstrumentationOptions } from "../options.ts";

/**
 * Patches XMLHttpRequest.prototype.open and send: open records the method and URL (resolved
 * against the page), send starts a CLIENT span with the fetch span's name and attributes, injects
 * context by setRequestHeader under the same propagate rule, and the span ends on loadend with
 * http.response.status_code from status (status 0 is a failure with error.type from the event:
 * "abort", "timeout" or "error"). Synchronous XHR is instrumented the same way. Returns a function
 * that restores the original methods. A no-op where XMLHttpRequest does not exist (workers).
 */
export function installXhrInstrumentation(opts: HttpInstrumentationOptions = {}): () => void {
  void opts;
  throw new Error("not implemented");
}
