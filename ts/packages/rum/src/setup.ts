/**
 * setupRum: @libo11y/web's setup with RUM wired in (decision P1). In order: settings, the
 * retention buffer (opened lazily), the session manager, the bus, the summary accumulator, the
 * view tracker, the span processor, then web's setupWithDeps with wrapped dependencies. After
 * setup: consent wiring (collectors run only while granted), session events, hide handling and
 * activity listeners. The returned handle is web's telemetry extended in place with rum.
 *
 * The span processor reaches core as options.spanProcessor. Core treats an injected processor as
 * the traces route ("injected") and then uses no exporter the platform builds, so RUM also injects
 * a forwarding span exporter, and its createExporterSet wrapper builds web's span exporter for the
 * route traces would have had without RUM: none in hermetic mode or with OTEL_SDK_DISABLED, else
 * OTEL_TRACES_EXPORTER from the browser env. An app that injects its own spanExporter keeps it,
 * routed by session; one that injects only a spanProcessor keeps sole charge of span export.
 */
import { type ExporterSet, O11yError, type SignalReport } from "@libo11y/core";
import {
  ATTR_RUM_CONFIG_VERSION,
  ATTR_RUM_CONNECTION_EFFECTIVE,
  ATTR_RUM_PLATFORM,
  ATTR_RUM_SESSION_RETAINED,
  ATTR_RUM_VIEW_ID,
  EVENT_RUM_SESSION_END,
  EVENT_RUM_SESSION_START,
  EVENT_RUM_VIEW_SUMMARY,
  RUM_CONNECTION_EFFECTIVE_VALUES,
} from "@libo11y/spec";
import type { WebTelemetry } from "@libo11y/web";
import {
  browserEnv,
  type ConsentController,
  type Delivery,
  defaultSetupDeps,
  openQueue,
  type PersistentQueue,
  type QueueOptions,
  type SetupDeps,
  setupWithDeps,
} from "@libo11y/web/internal";
import { diag } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import { ATTR_SESSION_ID, ATTR_USER_ID } from "./attrs.ts";
import { createBus } from "./bus.ts";
import type { RetentionRouting } from "./contracts/retention.ts";
import type { RequestStartHook, RumRuntime, RumSettings } from "./contracts/runtime.ts";
import type { SessionStore } from "./contracts/session.ts";
import type { Rum, RumSetupOptions, RumTelemetry } from "./options.ts";
import { createRetentionBuffer, RETENTION_QUEUE_DEFAULTS } from "./retention/buffer.ts";
import { retainingSpanExporter, withRetention } from "./retention/exporters.ts";
import { localStorageSessionStore } from "./session/local-store.ts";
import { createSessionManager } from "./session/manager.ts";
import { resolveSettings } from "./settings.ts";
import { rumSpanProcessor } from "./span-processor.ts";
import { createSummaryAccumulator } from "./summary/accumulator.ts";
import { VERSION } from "./version.ts";
import { createViewTracker } from "./views/tracker.ts";
import { gatewayTransportOptions } from "./wire.ts";

/** What setupRumWith builds on. Internal: tests and the extension wiring replace parts of it. */
export interface RumDeps {
  readonly web: SetupDeps;
  readonly openRetentionQueue: (opts: QueueOptions) => Promise<PersistentQueue>;
  /** The session manager first uses the store when consent is granted, so it must open nothing before. */
  readonly sessionStore: () => SessionStore;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** performance.now(). */
  readonly perfNow: () => number;
  readonly location: () => string;
  readonly prerendered: () => boolean;
  readonly connection: () => string | undefined;
  readonly document: (EventTarget & { readonly visibilityState?: string }) | undefined;
  readonly window: EventTarget | undefined;
}

/** The real dependencies of a page. */
export function defaultRumDeps(): RumDeps {
  const g = globalThis as {
    document?: EventTarget & { visibilityState?: string; prerendering?: boolean };
    location?: { href: string };
    navigator?: { connection?: { effectiveType?: string } };
  };
  const web = defaultSetupDeps();
  return {
    web,
    openRetentionQueue: openQueue,
    sessionStore: () => localStorageSessionStore(),
    now: Date.now,
    perfNow: () => performance.now(),
    location: () => g.location?.href ?? "about:blank",
    prerendered: () => {
      if (g.document?.prerendering === true) return true;
      const nav = performance.getEntriesByType?.("navigation")[0] as { activationStart?: number } | undefined;
      return (nav?.activationStart ?? 0) > 0;
    },
    connection: () => g.navigator?.connection?.effectiveType,
    document: g.document,
    window: web.window,
  };
}

const runtimes = new WeakMap<object, RumRuntime>();

/** The RUM runtime behind a RumTelemetry, for the adapter packages and the browser fixtures. */
export function runtimeOf(telemetry: object): RumRuntime | undefined {
  return runtimes.get(telemetry);
}

/** Builds browser telemetry with RUM and installs it globally, as the setup of `@libo11y/web` does. */
export function setupRum(options: RumSetupOptions = {}): Promise<RumTelemetry> {
  return setupRumWith(options, defaultRumDeps());
}

function composeProcessors(first: SpanProcessor, second: SpanProcessor | undefined): SpanProcessor {
  if (second === undefined) return first;
  return {
    onStart: (s, c) => {
      first.onStart(s, c);
      second.onStart(s, c);
    },
    onEnd: (s) => {
      first.onEnd(s);
      second.onEnd(s);
    },
    forceFlush: async () => {
      await Promise.all([first.forceFlush(), second.forceFlush()]);
    },
    shutdown: async () => {
      await Promise.all([first.shutdown(), second.shutdown()]);
    },
  };
}

const SUCCESS: ExportResult = { code: ExportResultCode.SUCCESS };

/** A span exporter that hands every batch to the target set later, and succeeds while there is none. */
function forwardingSpanExporter(target: () => SpanExporter | undefined): SpanExporter {
  return {
    export(spans, done) {
      const t = target();
      if (t === undefined) done(SUCCESS);
      else t.export(spans, done);
    },
    forceFlush: async () => {
      await target()?.forceFlush?.();
    },
    shutdown: async () => {
      await target()?.shutdown();
    },
  };
}

/** The traces route core would have resolved without RUM's injected processor and exporter. */
function naturalTracesRoute(
  config: { readonly hermetic: boolean; readonly sdkDisabled: boolean },
  env: Readonly<Record<string, string>>,
): "otlp" | "console" | "none" {
  if (config.hermetic || config.sdkDisabled) return "none";
  const first = (env.OTEL_TRACES_EXPORTER ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .find((v) => v !== "");
  const value = first ?? "otlp";
  if (value === "otlp" || value === "console" || value === "none") return value;
  throw new O11yError("EXPORTER", `o11y: building span exporter: unknown exporter ${value}`);
}

export async function setupRumWith(options: RumSetupOptions, deps: RumDeps): Promise<RumTelemetry> {
  const { rum: rumOptions, ...webOptions } = options;
  const resolved = resolveSettings(rumOptions);
  // R3d replaces it with the clamped remote configuration.
  const settings: RumSettings = resolved;
  const retention = createRetentionBuffer({
    open: () =>
      deps.openRetentionQueue({
        ...RETENTION_QUEUE_DEFAULTS,
        ...(rumOptions?.retention?.maxBytes === undefined ? {} : { maxBytes: rumOptions.retention.maxBytes }),
        ...(rumOptions?.retention?.maxAgeMillis === undefined
          ? {}
          : { maxAgeMillis: rumOptions.retention.maxAgeMillis }),
      }),
    now: deps.now,
  });
  const session = createSessionManager({
    store: deps.sessionStore(),
    sampleRate: () => settings.sessionSampleRate,
    idleMillis: settings.sessionIdleMillis,
    maxMillis: settings.sessionMaxMillis,
    configVersion: () => settings.configVersion,
    now: deps.now,
  });
  const bus = createBus();
  const hooks = new Set<RequestStartHook>();
  let userId: string | undefined;
  let telemetry: WebTelemetry | undefined;
  let controller: ConsentController | undefined;
  let delivery: Delivery | undefined;

  const hidden = (): boolean => deps.document?.visibilityState === "hidden";
  const summary = createSummaryAccumulator({
    platform: "web",
    emit: (attrs) => telemetry?.event(EVENT_RUM_VIEW_SUMMARY, attrs),
    now: deps.perfNow,
    visible: () => !hidden(),
    context: () => {
      const c = deps.connection();
      return {
        ...(c !== undefined && (RUM_CONNECTION_EFFECTIVE_VALUES as readonly string[]).includes(c)
          ? { [ATTR_RUM_CONNECTION_EFFECTIVE]: c }
          : {}),
        ...(settings.configVersion === undefined
          ? {}
          : { [ATTR_RUM_CONFIG_VERSION]: settings.configVersion }),
      };
    },
  });
  // Every client request counts toward the current view's summary (o11y.rum.summary.requests).
  bus.subscribe((s) => {
    if (s.type === "request-start") summary.count("requests");
  });
  const views = createViewTracker({
    session,
    summary,
    viewName: (u) => settings.viewName(u),
    location: deps.location,
    now: deps.perfNow,
    prerendered: deps.prerendered,
    ...(deps.window === undefined ? {} : { window: deps.window }),
  });
  const processor = rumSpanProcessor({
    platform: "web",
    session,
    views,
    queryAllowList: () => settings.queryAllowList,
    userId: () => userId,
    bus,
    now: deps.perfNow,
  });
  const onStart: RequestStartHook = (span, request) => {
    for (const h of hooks) {
      try {
        h(span, request);
      } catch (err) {
        diag.warn("o11y: rum: onRequestStart hook threw", err);
      }
    }
  };
  // Buffer writes still in flight, so a flush after retention sees every batch exported before it.
  const puts = new Set<Promise<void>>();
  const routing: RetentionRouting = {
    decide: (id) => session.decide(id),
    buffer: (b) => {
      const p = retention.put(b).finally(() => puts.delete(p));
      puts.add(p);
    },
  };

  const appExporter = webOptions.spanExporter;
  // An app that injects only a processor exports spans itself, so RUM adds no exporter.
  const forward = webOptions.spanProcessor === undefined || appExporter !== undefined;
  let spanTarget: SpanExporter | undefined;
  const webDeps: SetupDeps = {
    ...deps.web,
    createConsentController: (o) => {
      controller = deps.web.createConsentController(o);
      return controller;
    },
    createHttpTransport: (o) =>
      deps.web.createHttpTransport(gatewayTransportOptions(o, resolved.clientToken, deps.now)),
    createExporterSet: (req, d, endpoints, eo) => {
      delivery = d;
      if (appExporter !== undefined) {
        spanTarget = retainingSpanExporter(appExporter, routing);
        return withRetention(deps.web.createExporterSet(req, d, endpoints, eo), routing);
      }
      const traces = forward
        ? naturalTracesRoute(req.config, browserEnv(webOptions, endpoints))
        : req.config.traces;
      const built: ExporterSet = withRetention(
        deps.web.createExporterSet({ ...req, config: { ...req.config, traces } }, d, endpoints, eo),
        routing,
      );
      if (forward) spanTarget = built.spanExporter;
      return built;
    },
    installFetchInstrumentation: (o) => deps.web.installFetchInstrumentation({ ...o, onStart }),
    installXhrInstrumentation: (o) => deps.web.installXhrInstrumentation({ ...o, onStart }),
  };

  const t = await setupWithDeps(
    {
      ...webOptions,
      spanProcessor: composeProcessors(processor, webOptions.spanProcessor),
      ...(forward ? { spanExporter: forwardingSpanExporter(() => spanTarget) } : {}),
    },
    webDeps,
    true,
  );
  telemetry = t;
  const gate = controller;
  if (gate === undefined) {
    await t.shutdown();
    throw new O11yError("INVALID_OPTION", "rum: web setup built no consent controller");
  }

  const runtime: RumRuntime = {
    platform: "web",
    telemetry: t,
    tracer: t.tracerProvider.getTracer("@libo11y/rum", VERSION),
    gate,
    session,
    views,
    summary,
    bus,
    settings: () => settings,
    now: deps.perfNow,
    emit(name, attrs = {}, ctx) {
      if (!gate.recording()) return;
      const s = session.current();
      const v = views.current();
      t.event(
        name,
        {
          ...(s === undefined ? {} : { [ATTR_SESSION_ID]: s.id }),
          ...(v === undefined ? {} : { [ATTR_RUM_VIEW_ID]: v.id }),
          ...(userId === undefined ? {} : { [ATTR_USER_ID]: userId }),
          ...attrs,
        },
        ctx,
      );
    },
    onRequestStart(hook) {
      hooks.add(hook);
      return () => hooks.delete(hook);
    },
  };

  // Collectors run only while consent is granted.
  const running: (() => void)[] = [];
  let starting: Promise<void> | undefined;
  const startAll = (): Promise<void> => {
    starting ??= (async () => {
      await session.start();
      if (!gate.recording()) return; // revoked while the session loaded
      views.begin();
      for (const c of resolved.collectors) {
        if (!settings.enabled.has(c.name)) continue;
        try {
          running.push(c.start(runtime));
        } catch (err) {
          diag.warn(`o11y: rum: collector ${c.name} failed to start`, err);
        }
      }
    })();
    return starting;
  };
  const stopAll = (): void => {
    while (running.length > 0) {
      try {
        running.pop()?.();
      } catch (err) {
        diag.warn("o11y: rum: a collector failed to stop", err);
      }
    }
    starting = undefined;
  };

  const flushRetention = async (): Promise<void> => {
    await t.forceFlush();
    await Promise.all([...puts]);
    if (delivery !== undefined && gate.recording()) await retention.flush(delivery);
  };
  const offSession = session.subscribe((e) => {
    if (e.type === "kept") {
      flushRetention().catch((err: unknown) => diag.warn("o11y: rum: retention flush failed", err));
    } else if (e.type === "start" && e.local) {
      t.event(EVENT_RUM_SESSION_START, {
        [ATTR_SESSION_ID]: e.session.id,
        [ATTR_RUM_PLATFORM]: "web",
        ...(e.session.configVersion === undefined
          ? {}
          : { [ATTR_RUM_CONFIG_VERSION]: e.session.configVersion }),
      });
    } else if (e.type === "end" && e.local) {
      if (e.session.retained === undefined) void retention.clear();
      else {
        t.event(EVENT_RUM_SESSION_END, {
          [ATTR_SESSION_ID]: e.session.id,
          [ATTR_RUM_SESSION_RETAINED]: e.session.retained,
        });
      }
    }
  });

  const offRevoke = gate.onRevoke(async () => {
    stopAll();
    summary.reset();
    views.end();
    session.clear();
    await Promise.all([...puts]);
    await retention.clear();
  });
  const offGate = gate.subscribe((recording) => {
    if (recording) {
      startAll().catch((err: unknown) => diag.warn("o11y: rum: start failed", err));
    }
  });

  const doc = deps.document;
  const win = deps.window;
  const onVisibility = (): void => {
    summary.visibility(!hidden());
    if (hidden()) {
      // A microtask, so vitals reported in the same visibilitychange land first (decision P7).
      queueMicrotask(() => {
        summary.flush();
        void t.forceFlush();
      });
    } else session.touch();
  };
  const onPageHide = (): void => {
    summary.flush();
    void t.forceFlush();
  };
  const onActivity = (): void => session.touch();
  const ACTIVITY = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", onPageHide);
  for (const a of ACTIVITY) win?.addEventListener(a, onActivity, { capture: true, passive: true });

  const rum: Rum = {
    sessionId: () => (gate.recording() ? session.current()?.id : undefined),
    identify(id) {
      if (id?.includes("@")) {
        throw new O11yError("INVALID_OPTION", "rum.identify: an email address is not a pseudonymous ID");
      }
      userId = id;
    },
    onRequestStart: (hook) => runtime.onRequestStart(hook),
  };

  const handle = t as WebTelemetry & { readonly rum: Rum };
  Object.defineProperty(handle, "rum", { value: rum, enumerable: true });
  runtimes.set(handle, runtime);
  const webShutdown = t.shutdown.bind(t);
  let shutdownPromise: Promise<SignalReport> | undefined;
  handle.shutdown = (opts) => {
    shutdownPromise ??= (async () => {
      stopAll();
      views.end();
      summary.flush();
      doc?.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("pagehide", onPageHide);
      for (const a of ACTIVITY) win?.removeEventListener(a, onActivity, { capture: true });
      offGate();
      offRevoke();
      offSession();
      const report = await webShutdown(opts);
      views.close();
      session.close();
      await Promise.all([...puts]);
      retention.close();
      return report;
    })();
    return shutdownPromise;
  };

  if (gate.recording()) await startAll();
  return handle;
}
