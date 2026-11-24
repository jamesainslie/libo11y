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
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BaggageEgressPropagator, buildPropagator } from "./propagation.ts";

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
