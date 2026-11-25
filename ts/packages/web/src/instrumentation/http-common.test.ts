/**
 * What the fetch and XHR spans share: method normalization, URL attributes, the request URL, the
 * instrument resolver with its consent, and the carriers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecorder } from "@libo11y/test";
import { metrics, propagation, trace } from "@opentelemetry/api";
import { setActiveConsent } from "../consent/active.ts";
import type { Consent, ConsentState } from "../contracts/consent.ts";
import {
  consentAllows,
  DURATION_BUCKETS,
  instrumentResolver,
  methodAttributes,
  requestUrl,
  SCOPE,
  spanName,
  urlAttributes,
  XHR_SETTER,
} from "./http-common.ts";

function fixedConsent(state: ConsentState): Consent {
  return {
    state: () => state,
    grant: () => state,
    revoke: async () => {},
    subscribe: () => () => {},
  };
}

test("methods normalize as on the server", () => {
  assert.deepEqual(methodAttributes("GET"), { "http.request.method": "GET" });
  assert.deepEqual(methodAttributes("patch"), {
    "http.request.method": "PATCH",
    "http.request.method_original": "patch",
  });
  assert.deepEqual(methodAttributes("PURGE"), {
    "http.request.method": "_OTHER",
    "http.request.method_original": "PURGE",
  });
  assert.deepEqual(methodAttributes(""), { "http.request.method": "_OTHER" });
  assert.equal(spanName("GET"), "GET");
  assert.equal(spanName("delete"), "DELETE");
  assert.equal(spanName("PURGE"), "HTTP");
  assert.equal(spanName(""), "HTTP");
});

test("urlAttributes gives server.address, server.port and url.full without credentials", () => {
  assert.deepEqual(urlAttributes(new URL("https://user:pw@api.example.com/v1/x?q=1#frag")), {
    "server.address": "api.example.com",
    "server.port": 443,
    "url.full": "https://api.example.com/v1/x?q=1#frag",
  });
  assert.deepEqual(urlAttributes(new URL("http://[::1]:8080/")), {
    "server.address": "::1",
    "server.port": 8080,
    "url.full": "http://[::1]:8080/",
  });
  assert.equal(urlAttributes(new URL("http://example.com/"))["server.port"], 80);
});

test("requestUrl resolves against the page and refuses what cannot be parsed", () => {
  assert.equal(requestUrl("https://a.example.com/x", undefined)?.href, "https://a.example.com/x");
  assert.equal(
    requestUrl("/api?q=1", "https://app.example.com/page/1")?.href,
    "https://app.example.com/api?q=1",
  );
  assert.equal(requestUrl(new URL("https://b.example.com/"), undefined)?.href, "https://b.example.com/");
  assert.equal(requestUrl("/relative", undefined), undefined);
  assert.equal(requestUrl("http://[bad", "https://app.example.com/"), undefined);
});

test("consentAllows is true without a consent and only when granted with one", () => {
  assert.equal(consentAllows(undefined), true);
  assert.equal(consentAllows(fixedConsent("granted")), true);
  assert.equal(consentAllows(fixedConsent("pending")), false);
  assert.equal(consentAllows(fixedConsent("denied")), false);
});

test("the resolver uses the telemetry's providers and propagator, and its consent when it has one", async () => {
  const rec = await createRecorder({ serviceName: "http-common-test" });
  try {
    const plain = instrumentResolver(rec.telemetry)();
    assert.equal(plain.propagator, rec.telemetry.propagator);
    assert.equal(plain.consent, undefined);
    const consent = fixedConsent("pending");
    const web = Object.assign(Object.create(rec.telemetry) as object, rec.telemetry, { consent });
    const got = instrumentResolver(web as typeof rec.telemetry)();
    assert.equal(got.consent, consent);

    const resolve = instrumentResolver(rec.telemetry);
    assert.equal(resolve(), resolve(), "instruments are cached");
    plain.tracer.startSpan("probe").end();
    const probe = rec.spans().find((s) => s.name === "probe");
    assert.equal(probe?.instrumentationScope.name, SCOPE);
    plain.histogram.record(0.2);
    const rm = await rec.metrics();
    const metric = rm.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === "http.client.request.duration");
    assert.ok(metric, "the histogram is http.client.request.duration");
    assert.equal(metric.descriptor.unit, "s");
    const point = metric.dataPoints[0] as { value: { buckets: { boundaries: number[] } } };
    assert.deepEqual(point.value.buckets.boundaries, DURATION_BUCKETS);
  } finally {
    await rec.shutdown();
  }
});

test("without a telemetry the resolver uses the globals and the active consent, per request", async () => {
  const rec = await createRecorder({ serviceName: "http-common-globals" });
  const resolve = instrumentResolver(undefined);
  try {
    const before = resolve();
    assert.equal(before.consent, undefined);
    const consent = fixedConsent("granted");
    setActiveConsent(consent);
    trace.setGlobalTracerProvider(rec.telemetry.tracerProvider);
    metrics.setGlobalMeterProvider(rec.telemetry.meterProvider);
    propagation.setGlobalPropagator(rec.telemetry.propagator);
    const after = resolve();
    assert.equal(after.consent, consent);
    assert.notEqual(after.tracer, before.tracer, "a provider change rebuilds the instruments");
    after.tracer.startSpan("global-probe").end();
    assert.ok(rec.spans().some((s) => s.name === "global-probe"));
  } finally {
    setActiveConsent(undefined);
    trace.disable();
    metrics.disable();
    propagation.disable();
    await rec.shutdown();
  }
});

test("XHR_SETTER writes through setRequestHeader", () => {
  const set: [string, string][] = [];
  const xhr = { setRequestHeader: (k: string, v: string) => set.push([k, v]) } as unknown as XMLHttpRequest;
  XHR_SETTER.set(xhr, "traceparent", "00-x");
  assert.deepEqual(set, [["traceparent", "00-x"]]);
});

test("url.full redacts the signature query values semconv names, leaving the rest as sent", () => {
  const presigned =
    "https://bucket.s3.amazonaws.com/k?X-Amz-Date=20261125&AWSAccessKeyId=AKIA123&Signature=abc%2Fdef&sig=s1&X-Goog-Signature=g1&q=a%20b&flag";
  assert.equal(
    urlAttributes(new URL(presigned))["url.full"],
    "https://bucket.s3.amazonaws.com/k?X-Amz-Date=20261125&AWSAccessKeyId=REDACTED&Signature=REDACTED&sig=REDACTED&X-Goog-Signature=REDACTED&q=a%20b&flag",
  );
  assert.equal(
    urlAttributes(new URL("https://a.example.com/x?signature=keep&q=1#f"))["url.full"],
    "https://a.example.com/x?signature=keep&q=1#f",
    "the keys match case-sensitively, as semconv lists them",
  );
});
