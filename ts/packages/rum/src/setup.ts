/**
 * setupRum: @libo11y/web's setup with RUM wired in (decision P1). In order: settings, the
 * retention buffer (opened lazily), the session manager, the bus, the summary accumulator, the
 * view tracker, the span processor, then web's setupWithDeps with wrapped dependencies. After
 * setup: consent wiring (collectors run only while granted), session events, hide handling and
 * activity listeners. The returned handle is web's telemetry extended in place with rum.
 *
 * The span processor reaches core as options.spanProcessor. Core treats an injected processor as
 * the traces route ("injected") and then uses no span exporter the platform builds, so RUM also
 * injects a forwarding span exporter. When web hands RUM its platform options (onPlatform, before
 * core builds anything), RUM builds the span exporter for the route traces would have had without
 * RUM: none in hermetic mode, else OTEL_TRACES_EXPORTER from the browser env. An app that injects
 * its own spanExporter keeps it, routed by session; one that injects only a spanProcessor keeps sole
 * charge of span export.
 *
 * Consent. Closing the gate stops RUM at once, in the gate listener, so a grant that follows a
 * revoke before the revoke hooks finish starts RUM again. The revoke hook then empties the
 * retention buffer. A page that never had consent touches no RUM storage on revoke.
 */
import { O11yError, type SignalReport } from "@libo11y/core";
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
  type RUMSessionRetained,
} from "@libo11y/spec";
import { createContextManager, type WebTelemetry } from "@libo11y/web";
import {
  browserEnv,
  type ConsentController,
  createSpanExporter,
  type Delivery,
  defaultSetupDeps,
  type OtlpBatch,
  openQueue,
  type PersistentQueue,
  type QueueOptions,
  type SetupDeps,
  setupWithDeps,
} from "@libo11y/web/internal";
import { diag, type Span } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ConsoleSpanExporter, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { recordInstantAction } from "./actions/record.ts";
import { ATTR_SESSION_ID, ATTR_USER_ID } from "./attrs.ts";
import { createBus } from "./bus.ts";
import { rumContextManager } from "./context-manager.ts";
import type { RetentionRouting } from "./contracts/retention.ts";
import type { RequestStartHook, RumRuntime, RumSettings } from "./contracts/runtime.ts";
import type { SessionStore } from "./contracts/session.ts";
import { createBreadcrumbs } from "./errors/breadcrumbs.ts";
import { recordError } from "./errors/record.ts";
import type { Rum, RumSetupOptions, RumTelemetry } from "./options.ts";
import { createRetentionBuffer, RETENTION_QUEUE_DEFAULTS } from "./retention/buffer.ts";
import { retainingSpanExporter, withRetention } from "./retention/exporters.ts";
import { sessionsIn } from "./retention/sessions.ts";
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
  /** Install the telemetry globally, as setup does. Default true; tests that run two tabs in one process pass false. */
  readonly install?: boolean;
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

/** A kept session this tab ended, and the session its rotation started. */
interface EndingSession {
  readonly id: string;
  readonly retained: RUMSessionRetained;
  successor: string | undefined;
}

/** How long a tab that ended a session waits to hear whether another tab's rotation won. */
export const SESSION_END_ELECTION_MILLIS = 500;

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
  hermetic: boolean,
  env: Readonly<Record<string, string>>,
): "otlp" | "console" | "none" {
  if (hermetic || (env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true") return "none";
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
    ...(webOptions.transport?.timeoutMillis === undefined
      ? {}
      : { sendTimeoutMillis: webOptions.transport.timeoutMillis }),
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
  // The breadcrumb ring every error carries (decision P18): actions, view starts and requests.
  const crumbs = createBreadcrumbs();
  // A request that ends after a revoke must not leave a breadcrumb for the next grant.
  bus.subscribe((s) => {
    if (s.type === "breadcrumb" && controller?.recording() === true) crumbs.add(s.kind, s.label, s.at);
  });
  /** The open action, so requests started meanwhile become its children (decision P10). */
  let active: Span | undefined;
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
  views.subscribe((e) => {
    if (e.type === "start")
      bus.publish({ type: "breadcrumb", kind: "view", label: e.view.name, at: e.view.startTime });
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
  // put never rejects.
  const puts = new Set<Promise<void>>();
  const settled = async (): Promise<void> => {
    await Promise.allSettled([...puts]);
  };
  const routing: RetentionRouting = {
    decide: (id) => session.decide(id),
    buffer: (b) => {
      const p = retention.put(b).finally(() => puts.delete(p));
      puts.add(p);
    },
  };
  // A buffered batch goes out only when every session it holds records of is to be sent, because
  // the buffer is shared by every tab and may hold another session's batches.
  const keep = (b: OtlpBatch): boolean => {
    const ids = sessionsIn(b);
    return ids !== undefined && [...ids].every((id) => session.decide(id) === "send");
  };

  const appExporter = webOptions.spanExporter;
  // An app that injects only a processor exports spans itself, so RUM adds no exporter.
  const forward = webOptions.spanProcessor === undefined || appExporter !== undefined;
  let spanTarget: SpanExporter | undefined =
    appExporter === undefined ? undefined : retainingSpanExporter(appExporter, routing);
  const webDeps: SetupDeps = {
    ...deps.web,
    createConsentController: (o) => {
      controller = deps.web.createConsentController(o);
      return controller;
    },
    createHttpTransport: (o) =>
      deps.web.createHttpTransport(gatewayTransportOptions(o, resolved.clientToken, deps.now)),
    onPlatform: (platform, po) => {
      delivery = po.delivery;
      if (forward && appExporter === undefined) {
        const route = naturalTracesRoute(webOptions.hermetic === true, browserEnv(webOptions, po.endpoints));
        const inner =
          route === "console"
            ? new ConsoleSpanExporter()
            : route === "otlp" && po.endpoints.traces !== undefined
              ? createSpanExporter(po.delivery, po.mode === undefined ? {} : { mode: po.mode })
              : undefined;
        spanTarget = inner === undefined ? undefined : retainingSpanExporter(inner, routing);
      }
      deps.web.onPlatform?.(platform, po);
    },
    // Traces are injected, so web builds no span exporter here; logs are routed by session. The
    // gateway accepts only delta sums and histograms, so app metrics export with delta temporality.
    createExporterSet: (req, d, endpoints, eo) =>
      withRetention(
        deps.web.createExporterSet(req, d, endpoints, { ...eo, metricTemporality: "delta" }),
        routing,
      ),
    installFetchInstrumentation: (o) => deps.web.installFetchInstrumentation({ ...o, onStart }),
    installXhrInstrumentation: (o) => deps.web.installXhrInstrumentation({ ...o, onStart }),
  };

  let t: WebTelemetry;
  try {
    t = await setupWithDeps(
      {
        ...webOptions,
        spanProcessor: composeProcessors(processor, webOptions.spanProcessor),
        contextManager: () =>
          rumContextManager((webOptions.contextManager ?? createContextManager)(), () => active),
        ...(forward ? { spanExporter: forwardingSpanExporter(() => spanTarget) } : {}),
      },
      webDeps,
      deps.install !== false,
    );
  } catch (err) {
    views.close();
    session.close();
    retention.close();
    throw err;
  }
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
    activeAction: () => active,
    setActiveAction(span) {
      active = span;
    },
    breadcrumbs: () => crumbs.snapshot(deps.perfNow()),
  };

  // Collectors run only while consent is granted.
  const running: (() => void)[] = [];
  let starting: Promise<void> | undefined;
  /** Consent was granted at some point in this page, so RUM may have stored something. */
  let everStarted = false;
  /** Bumped by stopAll, so a start whose session load outlived a revoke does nothing. */
  let generation = 0;
  const startAll = (): Promise<void> => {
    everStarted = true;
    const gen = generation;
    starting ??= (async () => {
      await session.start();
      // Revoked while the session loaded, and maybe granted again: that later start runs instead.
      if (gen !== generation || !gate.recording()) return;
      views.begin();
      // A kept session may find batches an earlier page of it left in the buffer.
      if (session.kept()) {
        flushRetention().catch((err: unknown) => diag.warn("o11y: rum: retention flush failed", err));
      }
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
    generation++;
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
    await settled();
    if (delivery !== undefined && gate.recording()) await retention.flush(delivery, keep);
  };
  // Session end (decision P13): when tabs rotate an expired session at the same moment, each ends
  // it and starts a session of its own, then all adopt the same newest one. The tab whose session
  // won emits o11y.rum.session.end, so it is emitted once: each tab waits SESSION_END_ELECTION_MILLIS
  // for the others' broadcasts and emits only if its successor is still the current session. An
  // unkept session that ends removes only its own records from the shared retention buffer.
  const endTimers = new Set<ReturnType<typeof setTimeout>>();
  let endingSession: EndingSession | undefined;
  const offSession = session.subscribe((e) => {
    if (e.type === "kept") {
      flushRetention().catch((err: unknown) => diag.warn("o11y: rum: retention flush failed", err));
    } else if (e.type === "start" && e.local) {
      if (endingSession !== undefined && e.previous?.id === endingSession.id)
        endingSession.successor = e.session.id;
      t.event(EVENT_RUM_SESSION_START, {
        [ATTR_SESSION_ID]: e.session.id,
        [ATTR_RUM_PLATFORM]: "web",
        ...(e.session.configVersion === undefined
          ? {}
          : { [ATTR_RUM_CONFIG_VERSION]: e.session.configVersion }),
      });
    } else if (e.type === "end" && e.local) {
      const ended = e.session;
      if (ended.retained === undefined) {
        void (async () => {
          await settled();
          await retention.discard((b) => sessionsIn(b)?.has(ended.id) === true);
        })();
        return;
      }
      const candidate: EndingSession = { id: ended.id, retained: ended.retained, successor: undefined };
      endingSession = candidate;
      const timer = setTimeout(() => {
        endTimers.delete(timer);
        if (endingSession === candidate) endingSession = undefined;
        if (!gate.recording() || candidate.successor === undefined) return;
        if (session.current()?.id !== candidate.successor) return; // another tab's rotation won
        t.event(EVENT_RUM_SESSION_END, {
          [ATTR_SESSION_ID]: candidate.id,
          [ATTR_RUM_SESSION_RETAINED]: candidate.retained,
        });
      }, SESSION_END_ELECTION_MILLIS);
      endTimers.add(timer);
    }
  });

  const stopRecording = (): void => {
    stopAll();
    active = undefined;
    crumbs.clear();
    summary.reset();
    views.end();
    session.clear();
  };
  const offRevoke = gate.onRevoke(async () => {
    if (!everStarted) return;
    await settled();
    // A grant may already have followed the revoke; its session's records are not to be removed.
    if (!gate.recording()) await retention.clear();
  });
  const offGate = gate.subscribe((recording) => {
    if (recording) startAll().catch((err: unknown) => diag.warn("o11y: rum: start failed", err));
    else if (everStarted) stopRecording();
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
    startView(o) {
      if (!gate.recording()) return;
      const cause = active?.isRecording() === true ? active.spanContext() : undefined;
      views.start({
        kind: "soft",
        ...(o?.name === undefined ? {} : { name: o.name }),
        ...(cause === undefined ? {} : { cause }),
      });
    },
    setViewName(name) {
      if (gate.recording()) views.rename(name);
    },
    viewRendered() {
      if (gate.recording()) views.rendered();
    },
    addAction(name) {
      if (gate.recording()) recordInstantAction(runtime, "custom", name);
    },
    addError(error, o) {
      if (!gate.recording()) return;
      recordError(
        runtime,
        o?.source ?? "custom",
        error,
        o?.componentStack === undefined ? {} : { componentStack: o.componentStack },
      );
    },
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
      for (const timer of endTimers) clearTimeout(timer);
      endTimers.clear();
      const report = await webShutdown(opts);
      views.close();
      session.close();
      await settled();
      retention.close();
      return report;
    })();
    return shutdownPromise;
  };

  if (gate.recording()) await startAll();
  return handle;
}
