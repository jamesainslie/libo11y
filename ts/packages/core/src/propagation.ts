/**
 * Propagation. The default is W3C trace context plus W3C baggage. Whatever propagator is configured
 * is wrapped by the baggage egress filter, which drops disallowed baggage members on inject only;
 * extract and fields pass through, so ingress is never filtered. The predicate allows every key
 * unless a test sets it through internal/seams.ts, as in Go.
 */
import {
  type Context,
  propagation,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";

/** Filters baggage members on inject: a member leaves only when allow(key) is true. */
export class BaggageEgressPropagator implements TextMapPropagator {
  private readonly inner: TextMapPropagator;
  private readonly allow: (key: string) => boolean;

  constructor(inner: TextMapPropagator, allow: (key: string) => boolean) {
    this.inner = inner;
    this.allow = allow;
  }

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const bag = propagation.getBaggage(ctx);
    let out = ctx;
    if (bag !== undefined) {
      const entries = bag.getAllEntries();
      const kept = entries.filter(([key]) => this.allow(key));
      if (kept.length !== entries.length) {
        out = propagation.setBaggage(ctx, propagation.createBaggage(Object.fromEntries(kept)));
      }
    }
    this.inner.inject(out, carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.inner.extract(ctx, carrier, getter);
  }

  fields(): string[] {
    return this.inner.fields();
  }
}

/** The configured propagator: the default for none, one as is, several as a composite in order. */
export function buildPropagator(propagators: readonly TextMapPropagator[] | undefined): TextMapPropagator {
  if (propagators === undefined || propagators.length === 0) {
    return new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    });
  }
  if (propagators.length === 1) return propagators[0] as TextMapPropagator;
  return new CompositePropagator({ propagators: [...propagators] });
}
