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
  EVENT_NAME_KEY,
  EVENT_RUM_SESSION_END,
  EVENT_RUM_SESSION_START,
  EVENT_RUM_VIEW_SUMMARY,
  RUM_CONNECTION_EFFECTIVE_VALUES,
  type RUMPlatform,
  type RUMSessionRetained,
} from "@libo11y/spec";
import { createContextManager, type WebTelemetry } from "@libo11y/web";
import {
  browserEnv,
  type ConsentController,
  createSpanExporter,
  type Delivery,
  defaultSetupDeps,
  isIgnored,
  OTLP_SIGNALS,
  type OtlpBatch,
  openQueue,
  type PersistentQueue,
  pristineFetch,
  type QueueOptions,
  type SetupDeps,
  type SignalEndpoints,
} from "@libo11y/web/internal";
import { type Attributes, diag, ROOT_CONTEXT, SeverityNumber, type Span } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ConsoleSpanExporter, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { recordInstantAction } from "./actions/record.ts";
import { ATTR_SESSION_ID, ATTR_USER_ID } from "./attrs.ts";
import { type RumBind, type RumWrappers, webBinding } from "./bind.ts";
import { takeBootstrap } from "./bootstrap/buffer.ts";
import { replayBootstrap } from "./bootstrap/replay.ts";
import { createBus } from "./bus.ts";
import type { RemoteConfigDocument } from "./config/clamp.ts";
import type { RemoteConfigConnection } from "./config/remote.ts";
import { rumContextManager } from "./context-manager.ts";
import type { RetentionRouting } from "./contracts/retention.ts";
import type {
  CollectorName,
  RequestStartHook,
  RumRuntime,
  RumScope,
  RumSettings,
} from "./contracts/runtime.ts";
import type { SessionState, SessionStore } from "./contracts/session.ts";
import { createBreadcrumbs } from "./errors/breadcrumbs.ts";
import { recordError } from "./errors/record.ts";
import type { Rum, RumSetupOptions, RumTelemetry } from "./options.ts";
import { createPendingSpans, type PendingSpans } from "./pending-spans.ts";
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
  /** performance.timeOrigin, the origin of perfNow. Unset where perfNow is a fake clock. */
  readonly timeOrigin?: number;
  readonly location: () => string;
  readonly prerendered: () => boolean;
  readonly connection: () => string | undefined;
  readonly document: (EventTarget & { readonly visibilityState?: string }) | undefined;
  readonly window: EventTarget | undefined;
  /** Install the telemetry globally, as setup does. Default true; tests that run two tabs in one process pass false. */
  readonly install?: boolean;
  /** The fetch remote configuration uses. Default web's pristineFetch, which is never instrumented. */
  readonly fetch?: typeof fetch;
  /**
   * Where remote configuration is cached. Default localStorage. Called only once consent is granted.
   * It may resolve later, as a cache in chrome.storage.local does once it has read the stored value.
   */
  readonly storage?: () => CacheStorage | undefined | Promise<CacheStorage | undefined>;
  /** The platform summaries, session starts and app_load record. Default "web". */
  readonly platform?: RUMPlatform;
  /** Runs the platform's setup with RUM's wrappers. Default webBinding(web, install). */
  readonly bind?: RumBind;
  /** The context's limits on the collectors, for a content script. With fixedView, the one view starts when RUM does and is on screen at once. */
  readonly scope?: RumScope;
}

/** The synchronous storage remote configuration caches in. */
type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

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
    timeOrigin: performance.timeOrigin,
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

/**
 * A span exporter that hands every batch to the target set later, and succeeds while there is none.
 * A batch with a span that waits for the session goes on once the session is known.
 */
function forwardingSpanExporter(target: () => SpanExporter | undefined, pending: PendingSpans): SpanExporter {
  return {
    export(spans, done) {
      const go = (batch: typeof spans): void => {
        const t = target();
        if (t === undefined) done(SUCCESS);
        else t.export(batch, done);
      };
      const send = (batch: typeof spans): void => {
        try {
          go(batch);
        } catch (err) {
          done({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) });
        }
      };
      const ready = pending.prepare(spans);
      if (Array.isArray(ready)) send(ready);
      else ready.then(send, () => done(SUCCESS));
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

/** The remote configuration URL: base, else the export endpoint next to /v1/<signal>, with the service and client token. */
function configUrl(
  base: string | undefined,
  endpoints: SignalEndpoints | undefined,
  page: string,
  service: unknown,
  clientToken: string | undefined,
): string | undefined {
  let raw = base;
  if (raw === undefined && endpoints !== undefined) {
    for (const [signal, u] of Object.entries(endpoints)) {
      const suffix = `/v1/${signal}`;
      if (u?.endsWith(suffix) === true) {
        raw = `${u.slice(0, -suffix.length)}/v1/config`;
        break;
      }
    }
  }
  if (raw === undefined || typeof service !== "string" || service === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw, page);
  } catch {
    return undefined;
  }
  url.searchParams.set("service", service);
  if (clientToken !== undefined) url.searchParams.set("client_token", clientToken);
  return url.href;
}

export async function setupRumWith(options: RumSetupOptions, deps: RumDeps): Promise<RumTelemetry> {
  const { rum: rumOptions, ...webOptions } = options;
  const resolved = resolveSettings(rumOptions);
  const platform: RUMPlatform = deps.platform ?? "web";
  // Remote configuration (decisions P15, P16). The connection opens on the first grant. settings
  // are those of the current session: the document it started under, within the code's limits. A
  // new session takes the newest document. killed is the kill switch of the newest document.
  const rc = rumOptions?.remoteConfig;
  let remote: RemoteConfigConnection | undefined;
  let killed = false;
  let settings: RumSettings = resolved;
  const forSession = (version: string | undefined): RumSettings =>
    remote === undefined ? resolved : remote.apply(resolved, remote.find(version));
  const newest = (): RumSettings =>
    remote === undefined ? resolved : remote.apply(resolved, remote.current());
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
    sampleRate: () => newest().sessionSampleRate,
    idleMillis: resolved.sessionIdleMillis,
    maxMillis: resolved.sessionMaxMillis,
    configVersion: () => newest().configVersion,
    now: deps.now,
  });
  const bus = createBus();
  // The breadcrumb ring every error carries (decision P18): actions, view starts and requests.
  const crumbs = createBreadcrumbs();
  // A request that ends after a revoke must not leave a breadcrumb for the next grant.
  bus.subscribe((s) => {
    if (s.type === "breadcrumb" && controller?.recording() === true) crumbs.add(s.kind, s.label, s.at, s.key);
  });
  /** The open action, so requests started meanwhile become its children (decision P10). */
  let active: Span | undefined;
  const hooks = new Set<RequestStartHook>();
  let userId: string | undefined;
  let telemetry: WebTelemetry | undefined;
  let controller: ConsentController | undefined;
  let delivery: Delivery | undefined;
  let endpoints: SignalEndpoints | undefined;

  const hidden = (): boolean => deps.document?.visibilityState === "hidden";
  const summary = createSummaryAccumulator({
    platform,
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
    ...(deps.scope?.fixedView === true ? { initialStart: deps.perfNow } : {}),
  });
  views.subscribe((e) => {
    if (e.type === "start") {
      bus.publish({
        type: "breadcrumb",
        kind: "view",
        label: e.view.name,
        at: e.view.startTime,
        key: e.view.id,
      });
    } else if (e.type === "rename") crumbs.relabel(e.view.id, e.view.name);
  });
  /**
   * What the router adapter last reported, kept while consent is not granted too: the path it was
   * on, the name it gave the view and when the view rendered. A grant applies it to the view RUM
   * starts then, so a route that rendered before consent is named and rendered, not left to the
   * view span cap. It applies only while the URL path is still the one reported.
   */
  let routed: { path: string; name?: string; renderedAt?: number } | undefined;
  const pathNow = (): string => {
    try {
      return new URL(deps.location()).pathname;
    } catch {
      return "";
    }
  };
  /** What the adapter reported on this path, or a fresh record when it moved to another path. */
  const samePath = (): NonNullable<typeof routed> => {
    const path = pathNow();
    return routed?.path === path ? routed : { path };
  };
  const routedNow = (): typeof routed =>
    routed !== undefined && routed.path === pathNow() ? routed : undefined;
  const pending = createPendingSpans();
  const processor = rumSpanProcessor({
    platform,
    pending,
    session,
    views,
    queryAllowList: () => settings.queryAllowList,
    userId: () => userId,
    bus,
    now: deps.perfNow,
    ...(deps.timeOrigin === undefined ? {} : { timeOrigin: deps.timeOrigin }),
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
  /** The OTLP endpoints, once web resolved them. */
  let ownUrls: readonly string[] = [];
  const ignoreUrls = webOptions.instrumentations?.ignoreUrls ?? [];
  let spanTarget: SpanExporter | undefined =
    appExporter === undefined ? undefined : retainingSpanExporter(appExporter, routing);
  const wrappers: RumWrappers = {
    consentController: (c) => {
      controller = c;
      return c;
    },
    transportOptions: (o) => gatewayTransportOptions(o, resolved.clientToken, deps.now),
    platform: (po) => {
      delivery = po.delivery;
      endpoints = po.endpoints;
      ownUrls = OTLP_SIGNALS.flatMap((s) => (po.endpoints[s] === undefined ? [] : [po.endpoints[s]]));
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
    },
    exporterSet: (set) => withRetention(set, routing),
    onRequestStart: onStart,
  };
  const bind = deps.bind ?? webBinding(deps.web, deps.install !== false);

  // Hide handling. On a navigation, every engine fires pagehide before visibilitychange, and web's
  // flush on hide runs once per hide and exports whatever is pending at that moment; a flush
  // started after it waits for its export, which never completes once the page is gone. So RUM's
  // listeners are registered before web's: on the first of pagehide or visibilitychange (hidden)
  // they run the hide hooks (vitals commit their values) and emit the summaries, and web's flush
  // then exports them with the detail already pending. web-vitals listens in the capture phase on
  // window, so its own hide reports land before either listener runs.
  //
  // RUM never exports on hide itself. Firefox and WebKit fire pagehide while the document still
  // reports visible, so the send mode is "unload" only once web's own pagehide listener has run,
  // and the microtasks after each listener would carry an export RUM started to the transport
  // before that: a normal send, which the browser drops with the page.
  const doc = deps.document;
  const win = deps.window;
  const hideHooks = new Set<() => void>();
  let hideHandled = false;
  /** What a hide sends, once setup finished. */
  let afterHide: (() => void) | undefined;
  const runHide = (): void => {
    if (hideHandled) return;
    hideHandled = true;
    summary.visibility(false);
    for (const hook of [...hideHooks]) {
      try {
        hook();
      } catch (err) {
        diag.warn("o11y: rum: a hide hook threw", err);
      }
    }
  };
  const onVisibility = (): void => {
    if (hidden()) {
      runHide();
      afterHide?.();
    } else {
      hideHandled = false;
      summary.visibility(true);
      if (!killed) session.touch();
    }
  };
  const onPageHide = (): void => {
    runHide();
    afterHide?.();
  };
  // Only a page restored from the back/forward cache was hidden and is shown again; the pageshow
  // of a load that finished in a background tab is not.
  const onPageShow = (e: Event): void => {
    if ((e as Event & { persisted?: boolean }).persisted === true) hideHandled = false;
  };
  const removeHideListeners = (): void => {
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pagehide", onPageHide);
    win?.removeEventListener("pageshow", onPageShow);
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", onPageHide);
  win?.addEventListener("pageshow", onPageShow);

  let t: WebTelemetry;
  try {
    t = await bind(
      {
        ...webOptions,
        spanProcessor: composeProcessors(processor, webOptions.spanProcessor),
        contextManager: () =>
          rumContextManager((webOptions.contextManager ?? createContextManager)(), () => active),
        ...(forward ? { spanExporter: forwardingSpanExporter(() => spanTarget, pending) } : {}),
      },
      wrappers,
    );
  } catch (err) {
    removeHideListeners();
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

  /** RUM records: consent is granted and remote configuration has not switched it off. */
  const on = (): boolean => gate.recording() && !killed;
  // Events with a body (semconv's browser.web_vital) are bridge records: core's redacting log
  // processor classifies their attributes, and the retention exporters route them by session.id.
  const bodyLogger = t.loggerProvider.getLogger("@libo11y/rum", VERSION);
  const runtime: RumRuntime = {
    platform,
    ...(deps.scope === undefined ? {} : { scope: deps.scope }),
    telemetry: t,
    tracer: t.tracerProvider.getTracer("@libo11y/rum", VERSION),
    gate,
    session,
    views,
    summary,
    bus,
    settings: () => settings,
    now: deps.perfNow,
    emit(name, attrs = {}, ctx, body) {
      if (!gate.recording()) return;
      const s = session.current();
      const v = views.current();
      const merged = {
        ...(s === undefined ? {} : { [ATTR_SESSION_ID]: s.id }),
        ...(v === undefined ? {} : { [ATTR_RUM_VIEW_ID]: v.id }),
        ...(userId === undefined ? {} : { [ATTR_USER_ID]: userId }),
        ...attrs,
      };
      if (body === undefined) {
        t.event(name, merged, ctx);
        return;
      }
      bodyLogger.emit({
        eventName: name,
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        body: { ...body },
        attributes: { ...(merged as Attributes), [EVENT_NAME_KEY]: name },
        // Body events report page-level values at a hide, so the span active then is unrelated.
        context: ctx ?? ROOT_CONTEXT,
      });
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
    onHide(hook) {
      hideHooks.add(hook);
      return () => hideHooks.delete(hook);
    },
    ignored(url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return false;
      }
      return ownUrls.some((own) => u.href.startsWith(own)) || isIgnored(u, ignoreUrls);
    },
  };

  // Collectors run only while consent is granted, remote configuration has not switched RUM off,
  // and the current session's settings enable them.
  const running = new Map<CollectorName, () => void>();
  /** The session is up and the view begun, so the enabled collectors are to run. */
  let collecting = false;
  let starting: Promise<void> | undefined;
  let stopRemote: (() => void) | undefined;
  /** Consent was granted at some point in this page, so RUM may have stored something. */
  let everStarted = false;
  /** Bumped by stopAll, so a start whose session load outlived a revoke does nothing. */
  let generation = 0;
  const reconcile = (): void => {
    const want: ReadonlySet<CollectorName> = collecting && on() ? settings.enabled : new Set();
    for (const [name, stop] of [...running].reverse()) {
      if (want.has(name)) continue;
      running.delete(name);
      try {
        stop();
      } catch (err) {
        diag.warn(`o11y: rum: collector ${name} failed to stop`, err);
      }
    }
    for (const c of resolved.collectors) {
      if (!want.has(c.name) || running.has(c.name)) continue;
      try {
        running.set(c.name, c.start(runtime));
      } catch (err) {
        diag.warn(`o11y: rum: collector ${c.name} failed to start`, err);
      }
    }
  };
  /** Starts the session, the view and the collectors. */
  const activate = async (gen: number): Promise<void> => {
    if (killed) {
      pending.discard();
      return;
    }
    await session.start();
    // Revoked while the session loaded, and maybe granted again: that later start runs instead.
    if (gen !== generation || !gate.recording() || killed) {
      if (gen === generation) pending.discard();
      return;
    }
    settings = forSession(session.current()?.configVersion);
    views.begin();
    // Spans that started while the session loaded, such as app_load right after a late grant.
    const s = session.current();
    pending.resolve((load) => {
      const v = load ? views.loadView() : views.current();
      return {
        ...(s === undefined ? {} : { [ATTR_SESSION_ID]: s.id }),
        ...(v === undefined ? {} : { [ATTR_RUM_VIEW_ID]: v.id }),
      };
    });
    const r = routedNow();
    if (r?.name !== undefined) views.rename(r.name);
    // A kept session may find batches an earlier page of it left in the buffer.
    if (session.kept()) {
      flushRetention().catch((err: unknown) => diag.warn("o11y: rum: retention flush failed", err));
    }
    collecting = true;
    reconcile();
    if (r?.renderedAt !== undefined) views.rendered(r.renderedAt);
    // A fixed view (a content script) is on screen as soon as it starts.
    else if (deps.scope?.fixedView === true) views.rendered();
  };
  /** The kill switch acts at once; every other change waits for the next session. */
  const onRemote = (doc: RemoteConfigDocument | undefined): void => {
    if (!gate.recording()) return;
    const off = doc?.enabled === false;
    if (off && !killed) {
      killed = true;
      collecting = false;
      reconcile();
      active = undefined;
      views.end();
    } else if (!off && killed) {
      killed = false;
      activate(generation).catch((err: unknown) => diag.warn("o11y: rum: start failed", err));
    } else if (!off && collecting) {
      // The document the current session started under may only now be known, as when another
      // tab started the session under a document this tab had not fetched yet.
      settings = forSession(session.current()?.configVersion);
      reconcile();
    }
  };
  const openRemote = (): RemoteConfigConnection | undefined | Promise<RemoteConfigConnection | undefined> => {
    if (rc === undefined) return undefined;
    const url = configUrl(
      rc.url,
      endpoints,
      deps.location(),
      t.resource.attributes["service.name"],
      resolved.clientToken,
    );
    const f = deps.fetch ?? pristineFetch;
    if (url === undefined || f === undefined) {
      diag.warn("o11y: rum: remote configuration has no URL or no fetch; it is off");
      return undefined;
    }
    const connect = (storage: CacheStorage | undefined): RemoteConfigConnection =>
      rc.open({
        url,
        fetch: f,
        ...(storage === undefined ? {} : { storage }),
        timers: {
          setTimeout: (cb, ms) => setTimeout(cb, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        visible: () => !hidden(),
      });
    let storage: ReturnType<NonNullable<RumDeps["storage"]>>;
    try {
      storage = (deps.storage ?? (() => globalThis.localStorage))();
    } catch {
      storage = undefined;
    }
    return storage instanceof Promise ? storage.then(connect, () => connect(undefined)) : connect(storage);
  };
  /** The connection being opened, while its cache storage loads. */
  let opening: Promise<RemoteConfigConnection | undefined> | undefined;
  const startAll = (): Promise<void> => {
    everStarted = true;
    const gen = generation;
    pending.open();
    starting ??= (async () => {
      try {
        if (remote === undefined) {
          const opened = opening ?? openRemote();
          if (opened instanceof Promise) {
            opening = opened;
            const connection = await opened;
            remote ??= connection;
            if (opening === opened) opening = undefined;
            // Revoked while the cache loaded: the revoke found no connection to clear.
            if (gen !== generation) {
              if (!gate.recording()) remote?.clear();
              return;
            }
          } else remote = opened;
        }
        killed = remote?.current()?.enabled === false;
        await activate(gen);
        if (gen !== generation || !gate.recording()) return;
        stopRemote = remote?.start(onRemote);
      } catch (err) {
        // A start that failed releases the spans waiting for its session, so no export stalls.
        if (gen === generation) pending.discard();
        throw err;
      }
    })();
    return starting;
  };
  const stopAll = (): void => {
    generation++;
    pending.discard();
    collecting = false;
    reconcile();
    stopRemote?.();
    stopRemote = undefined;
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
  //
  // Session start (R3f): the o11y.rum.session.start of a kept session waits for the same election,
  // so only the session every context ends up sharing sends its start. That covers two tabs rotating at once and two
  // contexts that both find nothing stored and create the first session, as an extension's side
  // panel and content script do, each before it hears of the other's. A context whose session lost
  // abandons its start. A page that hides first sends its pending start if that session is still
  // current, because a hidden page may never run again.
  const endTimers = new Set<ReturnType<typeof setTimeout>>();
  let endingSession: EndingSession | undefined;
  const pendingStarts = new Map<ReturnType<typeof setTimeout>, () => void>();
  const sendStart = (s: SessionState): void => {
    t.event(EVENT_RUM_SESSION_START, {
      [ATTR_SESSION_ID]: s.id,
      [ATTR_RUM_PLATFORM]: platform,
      ...(s.configVersion === undefined ? {} : { [ATTR_RUM_CONFIG_VERSION]: s.configVersion }),
    });
  };
  /** Decides every start still waiting for its election now. */
  const settleStarts = (): void => {
    for (const [timer, decide] of [...pendingStarts]) {
      clearTimeout(timer);
      decide();
    }
  };
  const offSession = session.subscribe((e) => {
    if (e.type === "start") {
      // A new session takes the newest document; an adopted one, the document it started under.
      settings = forSession(e.session.configVersion);
      queueMicrotask(reconcile);
    }
    // While remote configuration has switched RUM off, a rotation sends no session events.
    if (e.type === "kept") {
      if (on()) flushRetention().catch((err: unknown) => diag.warn("o11y: rum: retention flush failed", err));
    } else if (e.type === "start" && e.local && on()) {
      if (endingSession !== undefined && e.previous?.id === endingSession.id)
        endingSession.successor = e.session.id;
      const started = e.session;
      // An unkept session's start waits in the retention buffer and is sent only if the session is
      // kept. A session that lost its election is abandoned and never kept, so its start is never
      // sent, and buffering it at once means a reload before the election cannot lose it.
      if (started.retained === undefined) {
        sendStart(started);
        return;
      }
      const decide = (): void => {
        pendingStarts.delete(timer);
        if (on() && session.current()?.id === started.id) sendStart(started);
      };
      const timer = setTimeout(decide, SESSION_END_ELECTION_MILLIS);
      pendingStarts.set(timer, decide);
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
        if (!on() || candidate.successor === undefined) return;
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
    // A revoked session sends no start.
    for (const timer of pendingStarts.keys()) clearTimeout(timer);
    pendingStarts.clear();
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
    if (!gate.recording()) {
      remote?.clear();
      await retention.clear();
    }
  });
  const offGate = gate.subscribe((recording) => {
    if (recording) startAll().catch((err: unknown) => diag.warn("o11y: rum: start failed", err));
    else if (everStarted) stopRecording();
  });

  // A hidden page may never run again (frozen or discarded on mobile), so a start still waiting for
  // its election goes out now if its session is still current.
  afterHide = () => {
    settleStarts();
    summary.flush();
  };
  const onActivity = (): void => {
    if (!killed) session.touch();
  };
  const ACTIVITY = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
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
      routed = { path: pathNow(), ...(o?.name === undefined ? {} : { name: o.name }) };
      if (!on()) return;
      const cause = active?.isRecording() === true ? active.spanContext() : undefined;
      views.start({
        kind: "soft",
        ...(o?.name === undefined ? {} : { name: o.name }),
        ...(cause === undefined ? {} : { cause }),
      });
    },
    setViewName(name) {
      routed = { ...samePath(), name };
      if (on()) views.rename(name);
    },
    viewRendered() {
      routed = { ...samePath(), renderedAt: deps.perfNow() };
      if (on()) views.rendered();
    },
    addAction(name) {
      if (on()) recordInstantAction(runtime, "custom", name);
    },
    addError(error, o) {
      if (!on()) return;
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
      removeHideListeners();
      for (const a of ACTIVITY) win?.removeEventListener(a, onActivity, { capture: true });
      offGate();
      offRevoke();
      offSession();
      settleStarts();
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

  // The bootstrap buffer (decision P9) is replayed only into the start setup makes with consent
  // granted. A page that starts pending discards it, even if consent is granted later. It is taken
  // before the collectors start, so an event is never both buffered and seen by a collector; one
  // that happens while the session loads, between the two, is not recorded.
  const early = takeBootstrap();
  if (gate.recording()) {
    await startAll();
    // A scoped context (a content script) shares its world with no page bootstrap of its own: what
    // a bootstrap there buffered may be the host page's, so it is dropped.
    if (!killed && deps.scope === undefined) replayBootstrap(runtime, early);
  }
  return handle;
}
