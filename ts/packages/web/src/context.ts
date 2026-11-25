/**
 * WP3 (web platform and setup). The default browser context manager.
 */
import type { ContextManager } from "@opentelemetry/api";

/**
 * A new upstream StackContextManager, enabled. It carries context through synchronous code and
 * context.with only, not across await, timers or event listeners; setup's contextManager option
 * plugs in another, such as ZoneContextManager.
 */
export function createContextManager(): ContextManager {
  throw new Error("not implemented");
}
