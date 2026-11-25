/**
 * OTEL_PROPAGATORS on the server platform, for parity with Go: what setup and createTelemetry
 * build from it, and that instrumentFetch and instrumentServe use what was built.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { O11yError, type Telemetry } from "@libo11y/core";
import { context, propagation, type TextMapPropagator, trace } from "@opentelemetry/api";
import { createContextManager } from "./context.ts";
import { instrumentFetch } from "./fetch.ts";
import { instrumentServe } from "./serve.ts";
import { createTelemetry, setup } from "./setup.ts";
import { clearedOtelEnv, withEnv } from "./test-support/env.ts";

const OPTIONS = {
  serviceName: "propagators-test",
  environment: "test",
  console: false,
  runtimeMetrics: false,
} as const;

const NO_EXPORT = {
  OTEL_TRACES_EXPORTER: "none",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
};

const INBOUND = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function telemetryWith(named: string | undefined, options: object = {}): Promise<Telemetry> {
  return withEnv(
    { ...clearedOtelEnv(), ...NO_EXPORT, ...(named === undefined ? {} : { OTEL_PROPAGATORS: named }) },
    () => createTelemetry({ ...OPTIONS, ...options }),
  );
}

/** The headers instrumentFetch sends for a request made under baggage, and the trace instrumentServe joins. */
async function roundTrip(telemetry: Telemetry): Promise<{ sent: string[]; joined: boolean }> {
  const manager = createContextManager().enable();
  context.setGlobalContextManager(manager);
  try {
    let sent: string[] = [];
    const traced = instrumentFetch(
      (async (_input: unknown, init?: RequestInit) => {
        sent = [...new Headers(init?.headers).keys()].sort();
        return new Response("ok");
      }) as unknown as typeof fetch,
      { telemetry },
    );
    const withBaggage = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ tenant: { value: "t1" } }),
    );
    await context.with(withBaggage, () => traced("http://upstream.test/"));

    let traceId = "";
    const serve = instrumentServe(
      async () => {
        traceId = trace.getActiveSpan()?.spanContext().traceId ?? "";
        return new Response("ok");
      },
      { telemetry },
    );
    await serve(new Request("http://svc.test/", { headers: { traceparent: INBOUND } }));
    return { sent, joined: traceId === "4bf92f3577b34da6a3ce929d0e0e4736" };
  } finally {
    context.disable();
  }
}

test("without OTEL_PROPAGATORS the default is W3C trace context plus baggage", async () => {
  const telemetry = await telemetryWith(undefined);
  try {
    assert.deepEqual(await roundTrip(telemetry), { sent: ["baggage", "traceparent"], joined: true });
    assert.match(telemetry.effectiveConfig(), / o11y\.config\.propagators=traceparent,tracestate,baggage /);
  } finally {
    await telemetry.shutdown();
  }
});

test("OTEL_PROPAGATORS=tracecontext sends the trace context and no baggage", async () => {
  const telemetry = await telemetryWith(" tracecontext ,");
  try {
    assert.deepEqual(await roundTrip(telemetry), { sent: ["traceparent"], joined: true });
    assert.match(telemetry.effectiveConfig(), / o11y\.config\.propagators=traceparent,tracestate /);
  } finally {
    await telemetry.shutdown();
  }
});

test("OTEL_PROPAGATORS=baggage sends baggage and joins no inbound trace", async () => {
  const telemetry = await telemetryWith("baggage");
  try {
    assert.deepEqual(await roundTrip(telemetry), { sent: ["baggage"], joined: false });
  } finally {
    await telemetry.shutdown();
  }
});

test("OTEL_PROPAGATORS=none sends nothing and joins nothing", async () => {
  const telemetry = await telemetryWith("none");
  try {
    assert.deepEqual(await roundTrip(telemetry), { sent: [], joined: false });
    assert.match(telemetry.effectiveConfig(), / o11y\.config\.propagators=none /);
  } finally {
    await telemetry.shutdown();
  }
});

test("a propagator the packages do not ship rejects createTelemetry and setup with UNSUPPORTED_PROPAGATOR", async () => {
  for (const named of ["b3", "b3multi", "jaeger", "xray", "ottrace", "tracecontext,nope"]) {
    const bad = named.split(",").at(-1);
    const unsupported = (err: unknown): boolean => {
      assert.ok(err instanceof O11yError, named);
      assert.equal(err.code, "UNSUPPORTED_PROPAGATOR");
      assert.equal(
        err.message,
        `o11y: unsupported propagator "${bad}" in OTEL_PROPAGATORS: use tracecontext, baggage or none, or pass the propagators option`,
      );
      return true;
    };
    await assert.rejects(telemetryWith(named), unsupported);
    await assert.rejects(
      withEnv({ ...clearedOtelEnv(), ...NO_EXPORT, OTEL_PROPAGATORS: named }, () => setup(OPTIONS)),
      unsupported,
    );
  }
  // setup gave its guard back each time: a setup that is configured well still works.
  const telemetry = await withEnv({ ...clearedOtelEnv(), ...NO_EXPORT }, () =>
    setup({ ...OPTIONS, startupSummary: false }),
  );
  await telemetry.shutdown();
});

test("the propagators option beats OTEL_PROPAGATORS, and hermetic mode does not read it", async () => {
  const custom: TextMapPropagator = {
    inject: (_ctx, carrier, setter) => setter.set(carrier, "x-custom", "1"),
    extract: (ctx) => ctx,
    fields: () => ["x-custom"],
  };
  const withOption = await telemetryWith("b3", { propagators: [custom] });
  const hermetic = await telemetryWith("b3", { hermetic: true });
  try {
    assert.deepEqual(await roundTrip(withOption), { sent: ["x-custom"], joined: false });
    assert.deepEqual(await roundTrip(hermetic), { sent: ["baggage", "traceparent"], joined: true });
  } finally {
    await withOption.shutdown();
    await hermetic.shutdown();
  }
});
