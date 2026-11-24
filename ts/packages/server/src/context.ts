/**
 * The server context manager: OpenTelemetry's AsyncLocalStorage manager, which Bun and Node both
 * implement. It carries the active context across timers, microtasks, await, fetch, streams and
 * Bun.serve handlers. On Bun 1.3.x it loses the context in an async generator response body
 * (oven-sh/bun#24199), in a thenable returned after an await (#34266) and in unhandledRejection
 * listeners (#40223); prefer ReadableStream bodies there.
 */
import type { ContextManager } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

/** A new AsyncLocalStorage context manager, enabled. Enabling it again is a no-op. */
export function createContextManager(): ContextManager {
  return new AsyncLocalStorageContextManager().enable();
}
