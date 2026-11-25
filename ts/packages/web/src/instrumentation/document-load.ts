/**
 * WP4 (instrumentation). The documentLoad span. L5 RUM adds the app_load shape's attributes to it
 * through a span processor; L4 records only what the navigation entry says.
 */
import type { DocumentLoadOptions } from "../options.ts";

/** The span names. */
export const DOCUMENT_LOAD_SPAN = "documentLoad";
export const DOCUMENT_FETCH_SPAN = "documentFetch";

/**
 * Records, once per page, an INTERNAL span "documentLoad" from the PerformanceNavigationTiming
 * entry's startTime to loadEventEnd, with a child CLIENT span "documentFetch" from fetchStart to
 * responseEnd. The documentLoad span's parent is the remote context of the entry's Server-Timing
 * traceparent when there is one (traceparentFromServerTiming), else none. Attributes: url.path and
 * url.scheme of the document (never the query or fragment), and on documentFetch
 * http.response.status_code from responseStatus when the browser exposes it. The navigation
 * timing marks (fetchStart, domainLookupStart, ..., loadEventEnd) are span events at their times.
 *
 * Waits for the load event (and one task after it, so loadEventEnd is set). If consent is not
 * granted then, waits for the first grant and records then, with the same historical times; if the
 * page is hidden first, records nothing. Resolves when the span ended or was abandoned; never
 * rejects. A no-op without document or a navigation entry.
 */
export function recordDocumentLoad(opts: DocumentLoadOptions = {}): Promise<void> {
  void opts;
  throw new Error("not implemented");
}
