import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  type TextMapPropagator,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { O11yError } from "./errors.ts";
import { BaggageEgressPropagator, buildPropagator, resolvePropagator } from "./propagation.ts";

function inject(p: TextMapPropagator, ctx: Context): Record<string, string> {
  const carrier: Record<string, string> = {};
  p.inject(ctx, carrier, defaultTextMapSetter);
  return carrier;
}

const CTX = propagation.setBaggage(
  trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
  }),
  propagation.createBaggage({ keep: { value: "1" }, secret: { value: "2" } }),
);

test("the default is W3C trace context plus baggage, with Go's fields", () => {
  for (const given of [undefined, []]) {
    const p = buildPropagator(given);
    assert.deepEqual(p.fields(), ["traceparent", "tracestate", "baggage"]);
    const carrier = inject(p, CTX);
    assert.equal(carrier.traceparent, "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    assert.equal(carrier.baggage, "keep=1,secret=2");
  }
});

test("one propagator is used as is and several form a composite in order", () => {
  const tc = new W3CTraceContextPropagator();
  assert.deepEqual(buildPropagator([tc]).fields(), ["traceparent", "tracestate"]);
  const other: TextMapPropagator = {
    inject: (_c, carrier, setter) => setter.set(carrier, "x-other", "1"),
    extract: (c) => c,
    fields: () => ["x-other"],
  };
  const p = buildPropagator([other, tc]);
  assert.deepEqual(p.fields(), ["x-other", "traceparent", "tracestate"]);
  assert.deepEqual(Object.keys(inject(p, CTX)), ["x-other", "traceparent"]);
});

test("the egress filter drops disallowed baggage on inject only", () => {
  const p = new BaggageEgressPropagator(buildPropagator(undefined), (key) => key !== "secret");
  assert.equal(inject(p, CTX).baggage, "keep=1");
  const extracted = p.extract(ROOT_CONTEXT, { baggage: "keep=1,secret=2" }, defaultTextMapGetter);
  assert.deepEqual(
    propagation
      .getBaggage(extracted)
      ?.getAllEntries()
      .map(([k]) => k),
    ["keep", "secret"],
  );
  assert.deepEqual(p.fields(), ["traceparent", "tracestate", "baggage"]);
});

test("baggage metadata survives the egress filter", () => {
  const ctx = propagation.setBaggage(
    ROOT_CONTEXT,
    propagation.createBaggage({ k: { value: "v", metadata: { toString: () => "p=1" } as never } }),
  );
  const p = new BaggageEgressPropagator(buildPropagator(undefined), () => true);
  assert.equal(inject(p, ctx).baggage, "k=v;p=1");
});

// OTEL_PROPAGATORS, as Go reads it: a comma-separated list, each entry trimmed, empty entries
// dropped, names case-sensitive. The TypeScript packages ship tracecontext, baggage and none.
test("with no option and no names, OTEL_PROPAGATORS leaves the default", () => {
  for (const named of [undefined, "", "   ", ",", " , ,"]) {
    const { propagator, fields } = resolvePropagator(undefined, named);
    assert.deepEqual(fields, ["traceparent", "tracestate", "baggage"], JSON.stringify(named));
    assert.deepEqual(Object.keys(inject(propagator, CTX)), ["traceparent", "baggage"]);
  }
});

test("OTEL_PROPAGATORS selects tracecontext and baggage by name, in the order given, each once", () => {
  const only = resolvePropagator(undefined, "tracecontext");
  assert.deepEqual(only.fields, ["traceparent", "tracestate"]);
  assert.deepEqual(Object.keys(inject(only.propagator, CTX)), ["traceparent"]);

  const bag = resolvePropagator([], "baggage");
  assert.deepEqual(bag.fields, ["baggage"]);
  assert.deepEqual(inject(bag.propagator, CTX), { baggage: "keep=1,secret=2" });

  const both = resolvePropagator(undefined, " baggage , tracecontext ,, baggage,tracecontext ");
  assert.deepEqual(both.fields, ["baggage", "traceparent", "tracestate"]);
  assert.deepEqual(Object.keys(inject(both.propagator, CTX)), ["baggage", "traceparent"]);
  assert.deepEqual(both.propagator.fields(), ["baggage", "traceparent", "tracestate"]);

  // A name given twice is one propagator, used as it is, not a composite of two.
  const twice = resolvePropagator(undefined, "tracecontext, tracecontext");
  assert.ok(twice.propagator instanceof W3CTraceContextPropagator);
});

test("none carries nothing in either direction, alone or next to other names, and reports as none", () => {
  for (const named of ["none", " none ", "tracecontext,none", "none,baggage"]) {
    const { propagator, fields } = resolvePropagator(undefined, named);
    assert.deepEqual(fields, ["none"], named);
    assert.deepEqual(propagator.fields(), []);
    assert.deepEqual(inject(propagator, CTX), {});
    const extracted = propagator.extract(
      ROOT_CONTEXT,
      { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", baggage: "k=v" },
      defaultTextMapGetter,
    );
    assert.equal(extracted, ROOT_CONTEXT);
  }
});

test("a name the packages do not ship is refused with UNSUPPORTED_PROPAGATOR, even next to one they do", () => {
  for (const [named, bad] of [
    ["b3", "b3"],
    ["b3multi", "b3multi"],
    ["jaeger", "jaeger"],
    ["xray", "xray"],
    ["ottrace", "ottrace"],
    ["nope", "nope"],
    ["TraceContext", "TraceContext"],
    ["tracecontext, b3 ,baggage", "b3"],
    ["none,jaeger", "jaeger"],
  ] as const) {
    assert.throws(
      () => resolvePropagator(undefined, named),
      (err: unknown) => {
        assert.ok(err instanceof O11yError, named);
        assert.equal(err.code, "UNSUPPORTED_PROPAGATOR");
        assert.equal(
          err.message,
          `o11y: unsupported propagator "${bad}" in OTEL_PROPAGATORS: use tracecontext, baggage or none, or pass the propagators option`,
        );
        return true;
      },
    );
  }
});

test("the propagators option beats OTEL_PROPAGATORS, whatever it names", () => {
  const tc = new W3CTraceContextPropagator();
  const { propagator, fields } = resolvePropagator([tc], "b3,none");
  assert.equal(propagator, tc);
  assert.deepEqual(fields, ["traceparent", "tracestate"]);
});

// Fourth review: three details where the two implementations disagreed.

const FIELDLESS: TextMapPropagator = { inject: () => {}, extract: (ctx) => ctx, fields: () => [] };

test("a configured propagator that names no fields reports as custom, as Go reports it", () => {
  // An empty value in the effective configuration reads as "nothing is configured".
  const one = resolvePropagator([FIELDLESS], undefined);
  assert.deepEqual(one.fields, ["custom"]);
  assert.equal(one.propagator, FIELDLESS);
  assert.deepEqual(resolvePropagator([FIELDLESS, FIELDLESS], "none").fields, ["custom"]);
  // Next to a propagator that names fields, those fields are the report.
  assert.deepEqual(resolvePropagator([FIELDLESS, new W3CBaggagePropagator()], undefined).fields, ["baggage"]);
  // "custom" is only ever the report: the none propagator stays "none".
  assert.deepEqual(resolvePropagator(undefined, "none").fields, ["none"]);
});

test("the reported fields are in configured order, each once, as Go lists them", () => {
  const repeating: TextMapPropagator = {
    inject: () => {},
    extract: (ctx) => ctx,
    fields: () => ["x-b", "x-a", "x-b", "baggage"],
  };
  assert.deepEqual(resolvePropagator([repeating], undefined).fields, ["x-b", "x-a", "baggage"]);
  assert.deepEqual(resolvePropagator([repeating, new W3CBaggagePropagator()], undefined).fields, [
    "x-b",
    "x-a",
    "baggage",
  ]);
});

// Go trims each entry with strings.TrimSpace: the Unicode White_Space property. It includes NEL
// (U+0085), which JavaScript's trim() leaves, and not the byte order mark (U+FEFF), which trim()
// strips. A value written by a tool that adds either must mean the same to both libraries.
test("an entry is trimmed of what Go's strings.TrimSpace trims: NEL goes and a byte order mark stays", () => {
  for (const named of [
    "tracecontext\u0085",
    "\u0085tracecontext",
    "\u0085 \t  tracecontext　     \r\n\v\f",
    "tracecontext,\u0085",
    "\u0085,tracecontext, \u0085 ",
  ]) {
    const { propagator, fields } = resolvePropagator(undefined, named);
    assert.deepEqual(fields, ["traceparent", "tracestate"], JSON.stringify(named));
    assert.ok(propagator instanceof W3CTraceContextPropagator, JSON.stringify(named));
  }
  // An entry of nothing but white space is empty, so it is dropped and the default applies.
  assert.deepEqual(resolvePropagator(undefined, "\u0085").fields, ["traceparent", "tracestate", "baggage"]);

  for (const [named, quoted] of [
    ["﻿tracecontext", '"\\ufefftracecontext"'],
    ["tracecontext﻿", '"tracecontext\\ufeff"'],
    ["baggage, ﻿ ", '"\\ufeff"'],
    // U+200B, a zero width space, is not White_Space either.
    ["​none", '"\\u200bnone"'],
  ] as const) {
    assert.throws(
      () => resolvePropagator(undefined, named),
      (err: unknown) => {
        assert.ok(err instanceof O11yError, JSON.stringify(named));
        assert.equal(err.code, "UNSUPPORTED_PROPAGATOR");
        assert.equal(
          err.message,
          `o11y: unsupported propagator ${quoted} in OTEL_PROPAGATORS: use tracecontext, baggage or none, or pass the propagators option`,
        );
        return true;
      },
    );
  }
});
