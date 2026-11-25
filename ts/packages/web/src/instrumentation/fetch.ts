/**
 * WP4 (instrumentation). Client spans for fetch.
 */
import type { HttpInstrumentationOptions } from "../options.ts";

/**
 * Wraps fetchImpl (default globalThis.fetch as it is now) with a CLIENT span per request, as the
 * server's instrumentFetch does (name, attributes, http.client.request.duration with the span's
 * exemplar, status handling, never mutating the caller's Request or init). Differences: traceparent,
 * tracestate and baggage are injected only when shouldPropagate(url, opts.propagateTo) is true; an
 * ignored URL or a closed consent (state() !== "granted") gets no span and no injection; onStart is
 * called after the span starts.
 */
export function instrumentFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  opts: HttpInstrumentationOptions = {},
): typeof fetch {
  void fetchImpl;
  void opts;
  throw new Error("not implemented");
}

/**
 * Replaces globalThis.fetch with instrumentFetch(globalThis.fetch, opts). Returns a function that
 * restores the previous fetch if globalThis.fetch is still the instrumented one. Installing twice
 * without uninstalling is a no-op that returns a no-op.
 */
export function installFetchInstrumentation(opts: HttpInstrumentationOptions = {}): () => void {
  void opts;
  throw new Error("not implemented");
}
