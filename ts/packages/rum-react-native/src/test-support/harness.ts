/**
 * setupRumReactNativeWith over fakes: React Native's AppState and Platform, device storage, frames
 * and timers on a manual clock, web's fake transport (whose requests are decoded from OTLP JSON),
 * and the real consent controller, storage queue, delivery (whose retry timer never fires, so only
 * flushes send) and exporter set. Never built.
 */

import {
  appStateLifecycle,
  installNetworkInstrumentation,
  openStorageQueue,
} from "@libo11y/react-native/internal";
import {
  createConsentController,
  createDelivery,
  createExporterSet,
  type HttpTransportOptions,
} from "@libo11y/web/portable";
import { type FakeEnv, fakeEnv } from "../../../react-native/src/test-support/fake-env.ts";
import { type FakeStorage, fakeStorage } from "../../../react-native/src/test-support/fake-storage.ts";
import { manualTimers } from "../../../rum/src/test-support/manual-timers.ts";
import { createFakeTransport, type FakeTransport } from "../../../web/src/test-support/fake-transport.ts";
import type { RumReactNativeEnv, StartupTimingLike } from "../contracts/env.ts";
import type { ReactNativeRumTelemetry, RumReactNativeSetupOptions } from "../options.ts";
import { screensWith } from "../screens.ts";
import { type RumReactNativeDeps, setupRumReactNativeWith } from "../setup.ts";

type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
};
type OtlpAttr = { key: string; value: OtlpValue };

/** A span as the transport sent it. Times are nanoseconds since the epoch. */
export interface SentSpan {
  readonly name: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly links: readonly { readonly spanId: string }[];
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly scope: string;
  readonly start: bigint;
  readonly end: bigint;
}

const otlpValue = (v: OtlpValue): unknown =>
  v.stringValue ??
  v.doubleValue ??
  v.boolValue ??
  (v.intValue === undefined ? undefined : Number(v.intValue));
const attrsOf = (attrs: readonly OtlpAttr[] | undefined): Record<string, unknown> =>
  Object.fromEntries((attrs ?? []).map((a) => [a.key, otlpValue(a.value)]));

export interface HarnessOptions {
  readonly storage?: FakeStorage;
  /** The epoch milliseconds the fake performance clock counts from. Default the real time now. */
  readonly timeOrigin?: number;
  /** The fake performance.now() at setup. Default 100. */
  readonly clockStart?: number;
  readonly startupTiming?: StartupTimingLike;
  /** Default 40. */
  readonly loadedAt?: number;
  /** Run the screens collector on the harness's frames and timers, before options.rum.collectors. */
  readonly screens?: boolean;
  /** Install globally: the network patch on a fake global fetch, which harness.fetch calls. */
  readonly install?: boolean;
  /** Answers remote configuration and every other fetch. Default 304 for the config, else 200. */
  readonly respond?: (url: string) => Response;
}

export interface Harness {
  readonly telemetry: ReactNativeRumTelemetry;
  readonly app: FakeEnv;
  readonly storage: FakeStorage;
  readonly transport: FakeTransport;
  readonly transportOptions: HttpTransportOptions[];
  /** The URLs the fake fetch was asked for. */
  readonly fetched: string[];
  readonly timeOrigin: number;
  /** The fake performance.now(). */
  clock(): number;
  /** Moves the fake clock, running the timers that fall due. */
  advance(ms: number): void;
  /** Runs the queued animation frames, then the zero-delay timers: the first frame after now. */
  frame(): void;
  /** Lets microtasks and a few macrotasks run, flushes the telemetry, and lets them run again. */
  idle(): Promise<void>;
  /** The global fetch the network instrumentation patched (install only). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  spans(): SentSpan[];
  /** The attributes of every log record named name. */
  events(name: string): Record<string, unknown>[];
  /** The metric data points the transport sent: name and aggregation temporality. */
  metrics(): { readonly name: string; readonly temporality: number | undefined }[];
  /** A span's start in milliseconds after the time origin. */
  relativeStartMillis(span: SentSpan | undefined): number;
  durationMillis(span: SentSpan | undefined): number;
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

export async function harness(
  options: RumReactNativeSetupOptions = {},
  o: HarnessOptions = {},
): Promise<Harness> {
  const timeOrigin = o.timeOrigin ?? Math.floor(Date.now());
  const app = fakeEnv();
  const storage = o.storage ?? fakeStorage();
  const transport = createFakeTransport();
  const transportOptions: HttpTransportOptions[] = [];
  const fetched: string[] = [];
  const clock = manualTimers(o.clockStart ?? 100);
  const frames: (() => void)[] = [];
  const lifecycle = appStateLifecycle(app.appState);
  const respond =
    o.respond ?? ((url: string) => new Response(null, { status: url.includes("/v1/config") ? 304 : 200 }));
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    return respond(url);
  }) as typeof fetch;
  const fakeGlobal: { fetch?: typeof fetch } = { fetch: fakeFetch };
  const env: RumReactNativeEnv = {
    ...(o.startupTiming === undefined ? {} : { startupTiming: o.startupTiming }),
    loadedAt: o.loadedAt ?? 40,
    visible: () => lifecycle.visible(),
    requestAnimationFrame: (cb) => frames.push(cb),
    setTimeout: (cb, ms) => clock.timers.setTimeout(cb, ms),
    clearTimeout: (h) => clock.timers.clearTimeout(h),
  };
  const deps: RumReactNativeDeps = {
    platform: {
      env: app,
      lifecycle,
      createConsentController,
      openQueue: openStorageQueue,
      createHttpTransport: (t) => {
        transportOptions.push(t);
        return transport;
      },
      createDelivery: (d) => createDelivery({ ...d, setTimer: () => 0, clearTimer: () => {} }),
      createExporterSet,
      installNetworkInstrumentation: (n) => installNetworkInstrumentation({ ...n, xhr: false }, fakeGlobal),
    },
    env,
    now: () => timeOrigin + clock.now(),
    perfNow: () => clock.now(),
    timeOrigin,
    fetch: fakeFetch,
  };
  const telemetry = await setupRumReactNativeWith(
    {
      serviceName: "app",
      serviceVersion: "1.0.0",
      environment: "test",
      endpoint: "https://gw.test/_o11y",
      storage,
      runtimeMetrics: false,
      startupSummary: false,
      ...options,
      ...(o.screens === true
        ? { rum: { ...options.rum, collectors: [screensWith(env), ...(options.rum?.collectors ?? [])] } }
        : {}),
    },
    deps,
    o.install ?? false,
  );
  const bodies = (signal: "traces" | "logs" | "metrics"): unknown[] =>
    transport.requests.filter((r) => r.signal === signal).map((r) => JSON.parse(r.body));
  const nanos = (v: unknown): bigint => BigInt(String(v ?? 0));
  return {
    telemetry,
    app,
    storage,
    transport,
    transportOptions,
    fetched,
    timeOrigin,
    clock: () => clock.now(),
    advance: (ms) => clock.advance(ms),
    frame() {
      for (const cb of frames.splice(0)) cb();
      clock.advance(0);
    },
    async idle() {
      await settle();
      await telemetry.forceFlush();
      await settle();
    },
    fetch: (url, init) => {
      if (fakeGlobal.fetch === undefined) throw new Error("no fetch");
      return fakeGlobal.fetch(url, init);
    },
    spans: () =>
      bodies("traces").flatMap((b) =>
        (
          b as {
            resourceSpans: { scopeSpans: { scope: { name: string }; spans: Record<string, unknown>[] }[] }[];
          }
        ).resourceSpans.flatMap((rs) =>
          rs.scopeSpans.flatMap((ss) =>
            ss.spans.map(
              (s): SentSpan => ({
                name: String(s.name),
                spanId: String(s.spanId),
                ...(typeof s.parentSpanId === "string" && s.parentSpanId !== ""
                  ? { parentSpanId: s.parentSpanId }
                  : {}),
                links: ((s.links as { spanId: string }[] | undefined) ?? []).map((l) => ({
                  spanId: l.spanId,
                })),
                attributes: attrsOf(s.attributes as OtlpAttr[]),
                scope: ss.scope.name,
                start: nanos(s.startTimeUnixNano),
                end: nanos(s.endTimeUnixNano),
              }),
            ),
          ),
        ),
      ),
    events: (name) =>
      bodies("logs")
        .flatMap((b) =>
          (
            b as { resourceLogs: { scopeLogs: { logRecords: { attributes: OtlpAttr[] }[] }[] }[] }
          ).resourceLogs.flatMap((rl) =>
            rl.scopeLogs.flatMap((sl) => sl.logRecords.map((lr) => attrsOf(lr.attributes))),
          ),
        )
        .filter((a) => a["event.name"] === name),
    metrics: () =>
      bodies("metrics").flatMap((b) =>
        (
          b as {
            resourceMetrics: {
              scopeMetrics: { metrics: { name: string; sum?: { aggregationTemporality?: number } }[] }[];
            }[];
          }
        ).resourceMetrics.flatMap((rm) =>
          rm.scopeMetrics.flatMap((sm) =>
            sm.metrics.map((m) => ({ name: m.name, temporality: m.sum?.aggregationTemporality })),
          ),
        ),
      ),
    relativeStartMillis: (s) => Number((s?.start ?? 0n) - BigInt(timeOrigin) * 1_000_000n) / 1e6,
    durationMillis: (s) => Number((s?.end ?? 0n) - (s?.start ?? 0n)) / 1e6,
  };
}
