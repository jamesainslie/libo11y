/**
 * Failed requests as errors, on every platform: a fetch or XHR span that ends without a status is a
 * network error, type NetworkError, message "<METHOD> <host> failed", unless the app aborted it
 * (error.type AbortError from fetch, abort from XHR). It reads the request signals the span
 * processor publishes on the bus.
 */
import type { RumRuntime } from "../contracts/runtime.ts";
import { DescribedError } from "./described.ts";
import type { ErrorRecorder } from "./recorder.ts";

/** The error.type values of a request the app aborted, which is not a failure. */
const ABORTED: ReadonlySet<string> = new Set(["AbortError", "abort"]);

function host(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

/** Records failed requests through rec until the returned function is called. */
export function watchNetworkErrors(rt: RumRuntime, rec: ErrorRecorder): () => void {
  // Requests in flight, so a failed one can be described by its method and host.
  const requests = new Map<string, { method: string; url: string }>();
  const off = rt.bus.subscribe((s) => {
    if (s.type === "request-start") requests.set(s.spanId, { method: s.method, url: s.url });
    else if (s.type === "request-end") {
      const r = requests.get(s.spanId);
      requests.delete(s.spanId);
      if (r !== undefined && s.status === undefined && !ABORTED.has(s.errorType ?? "")) {
        rec.record("network", new DescribedError("NetworkError", `${r.method} ${host(r.url)} failed`), s.at);
      }
    }
  });
  return () => {
    off();
    requests.clear();
  };
}
