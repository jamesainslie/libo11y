/**
 * Propagation. The propagators option wins. Without it OTEL_PROPAGATORS names the propagators, and
 * without that the default is W3C trace context plus W3C baggage. Whatever propagator is configured
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
import { unsupportedPropagatorError } from "./errors.ts";

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

/** The name OTEL_PROPAGATORS gives the propagator that carries nothing. */
const NO_PROPAGATION = "none";

/**
 * What the effective configuration reports for configured propagators that name no fields, such as
 * a custom propagator. It is Go's word. An empty value would read as nothing being configured.
 */
const FIELDLESS_PROPAGATION = "custom";

// Go's strings.TrimSpace: the Unicode White_Space property. It includes NEL (U+0085), which
// String.prototype.trim leaves, and not the byte order mark (U+FEFF), which trim strips.
function trimSpace(s: string): string {
  return s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

// The fields the effective configuration reports, as Go's composeInOrder lists them: in configured
// order, each once, or "custom" when there are none.
function reportedFields(propagator: TextMapPropagator): readonly string[] {
  const fields = [...new Set(propagator.fields())];
  return fields.length === 0 ? [FIELDLESS_PROPAGATION] : fields;
}

/** The propagators OTEL_PROPAGATORS may name here. Go also resolves b3, b3multi, jaeger, xray and ottrace. */
const NAMED: Readonly<Record<string, () => TextMapPropagator>> = {
  tracecontext: () => new W3CTraceContextPropagator(),
  baggage: () => new W3CBaggagePropagator(),
};

const NOTHING: TextMapPropagator = {
  inject: () => {},
  extract: (ctx) => ctx,
  fields: () => [],
};

/** The propagator the configuration selects, before the baggage egress filter wraps it. */
export interface ResolvedPropagator {
  readonly propagator: TextMapPropagator;
  /**
   * What the effective configuration reports: the propagators' fields in their configured order,
   * each once, "none" alone for the propagator that carries nothing, or "custom" alone for
   * configured propagators that name no fields.
   */
  readonly fields: readonly string[];
}

/**
 * Resolves the propagator as Go's buildPropagator does. A non-empty propagators option wins.
 * Otherwise named, the value of OTEL_PROPAGATORS, is read as a comma-separated list: each entry is
 * trimmed of the white space Go's strings.TrimSpace trims, empty entries are dropped, and a name
 * is used once, where it first appears. Names are
 * case-sensitive. tracecontext and baggage are built in the order given, and a list that names
 * none carries nothing. With no names the default applies. Throws UNSUPPORTED_PROPAGATOR for any
 * other name, even next to a known one or next to none.
 */
export function resolvePropagator(
  propagators: readonly TextMapPropagator[] | undefined,
  named: string | undefined,
): ResolvedPropagator {
  if (propagators !== undefined && propagators.length > 0) {
    const propagator = buildPropagator(propagators);
    return { propagator, fields: reportedFields(propagator) };
  }
  const names: string[] = [];
  for (const entry of (named ?? "").split(",")) {
    const name = trimSpace(entry);
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  for (const name of names) {
    if (name !== NO_PROPAGATION && !Object.hasOwn(NAMED, name)) throw unsupportedPropagatorError(name);
  }
  if (names.includes(NO_PROPAGATION)) return { propagator: NOTHING, fields: [NO_PROPAGATION] };
  const propagator = buildPropagator(names.map((name) => (NAMED[name] as () => TextMapPropagator)()));
  return { propagator, fields: reportedFields(propagator) };
}
