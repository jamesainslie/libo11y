/**
 * Parents requests to the open action. When the inner context manager has no active
 * span, the open action's context is active, so fetch and XHR spans a click handler starts, even
 * after an await the StackContextManager cannot follow, become the action's children. An action
 * that has ended is never active.
 */
import { type Context, type ContextManager, type Span, trace } from "@opentelemetry/api";

export function rumContextManager(inner: ContextManager, action: () => Span | undefined): ContextManager {
  const cm: ContextManager = {
    active(): Context {
      const ctx = inner.active();
      if (trace.getSpan(ctx) !== undefined) return ctx;
      const a = action();
      return a === undefined || !a.isRecording() ? ctx : trace.setSpan(ctx, a);
    },
    with: (ctx, fn, thisArg, ...args) => inner.with(ctx, fn, thisArg, ...args),
    bind: (ctx, target) => inner.bind(ctx, target),
    enable() {
      inner.enable();
      return cm;
    },
    disable() {
      inner.disable();
      return cm;
    },
  };
  return cm;
}
