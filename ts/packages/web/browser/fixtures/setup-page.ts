/**
 * WP3. The setup and consent specs' page: setup from @libo11y/web, configured from the query
 * string, driven through globalThis.__web.
 *
 *   endpoint   the OTLP base URL (the test's sink)
 *   consent    the initial consent state, default the library's default (pending)
 *   userAgent  "1" records user_agent.original
 *   compression  "none" turns gzip off
 */
import "./setup-spy.ts";
import { type ConsentState, setup, type WebTelemetry } from "@libo11y/web";

const params = new URLSearchParams(location.search);
const initial = params.get("consent") as ConsentState | null;
const endpoint = params.get("endpoint") ?? undefined;

/** What the specs call through page.evaluate. */
export interface WebPage {
  readonly telemetry: WebTelemetry;
  readonly hasUserAgentData: boolean;
  /** Ends a span named name, logs "log <name>" and adds 1 to the counter web.test.<name>. */
  emit(name: string): void;
  flush(): Promise<boolean>;
  grant(): ConsentState;
  revoke(): Promise<ConsentState>;
  state(): ConsentState;
  /** Pretends the page was hidden, as a tab switch does. */
  hide(): void;
  shutdown(): Promise<boolean>;
}

const errors: string[] = [];
(globalThis as { __webErrors?: string[] }).__webErrors = errors;

try {
  const telemetry = await setup({
    serviceName: "web-fixture",
    environment: "test",
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(initial === null ? {} : { consent: { initial } }),
    ...(params.get("userAgent") === "1" ? { userAgent: true } : {}),
    ...(params.get("compression") === "none" ? { transport: { compression: "none" } } : {}),
    instrumentations: { documentLoad: false },
  });
  const tracer = telemetry.tracerProvider.getTracer("web-fixture");
  const meter = telemetry.meterProvider.getMeter("web-fixture");
  const web: WebPage = {
    telemetry,
    hasUserAgentData: "userAgentData" in navigator,
    emit(name) {
      tracer.startSpan(name).end();
      telemetry.logger.info(`log ${name}`);
      meter.createCounter(`web.test.${name}`).add(1);
    },
    flush: async () => (await telemetry.forceFlush()).ok,
    grant: () => telemetry.consent.grant(),
    revoke: async () => {
      await telemetry.consent.revoke();
      return telemetry.consent.state();
    },
    state: () => telemetry.consent.state(),
    hide() {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    },
    shutdown: async () => (await telemetry.shutdown()).ok,
  };
  (globalThis as { __web?: WebPage }).__web = web;
} catch (err) {
  errors.push(String(err));
}
