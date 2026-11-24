/**
 * Events: contract-bearing log records identified by name. An event is emitted at info under a
 * forced context, so the level gate never drops it, and is correlated to its context. The name
 * travels as the first attribute, event.name; a caller's event.name is removed. Any name is
 * accepted, as in Go: registered contracts are checked by @libo11y/test, not at runtime.
 */
import { EVENT_NAME_KEY } from "@libo11y/spec";
import { type Context, context } from "@opentelemetry/api";
import type { LogAttributes, LogValue } from "./log-values.ts";
import { forceEmit, type LogPipeline } from "./logger.ts";

/** The attributes of event name: event.name first, then attrs without any event.name. */
export function eventAttributes(name: string, attrs?: LogAttributes): LogAttributes {
  const out: { [key: string]: LogValue } = { [EVENT_NAME_KEY]: name };
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k !== EVENT_NAME_KEY) out[k] = v;
  }
  return out;
}

/**
 * Merges later into earlier as Go's dedupe does: a key in both keeps later's value at later's
 * position.
 */
export function lastWins(earlier: LogAttributes, later: LogAttributes): LogAttributes {
  const out: { [key: string]: LogValue } = {};
  for (const [k, v] of Object.entries(earlier)) {
    if (!Object.hasOwn(later, k)) out[k] = v;
  }
  return Object.assign(out, later);
}

/** Emits event name through pipeline. strict rethrows a sink failure, for the startup canary. */
export function emitEvent(
  pipeline: LogPipeline,
  name: string,
  attrs?: LogAttributes,
  ctx?: Context,
  opts: { readonly strict?: boolean; readonly consoleOnly?: boolean } = {},
): void {
  pipeline.emit("info", name, eventAttributes(name, attrs), {
    ...opts,
    ctx: forceEmit(ctx ?? context.active()),
  });
}
