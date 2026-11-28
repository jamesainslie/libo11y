/**
 * setupRumCore on a runtime with no browser at all, for core.test.ts, which runs this in a child
 * process after removing every browser global. The binding builds a bare telemetry over the
 * OpenTelemetry SDK; the lifecycle and the session store are in memory.
 */
import type { Telemetry } from "@libo11y/core";
import { createConsentController, createMemoryQueue } from "@libo11y/web/portable";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import type { RumLifecycleHandlers, RumPlatformOptions } from "../contracts/binding.ts";
import type { SessionState, SessionStore } from "../contracts/session.ts";
import { setupRumCore } from "../core-setup.ts";

/** What one run recorded. */
export interface BareRun {
  readonly sessionId: string | undefined;
  readonly events: readonly string[];
  readonly spans: readonly string[];
  readonly unsubscribed: boolean;
}

export async function runBareCore(): Promise<BareRun> {
  const events: string[] = [];
  const spans: string[] = [];
  let handlers: RumLifecycleHandlers | undefined;
  let stored: SessionState | undefined;
  const store: SessionStore = {
    load: async () => stored,
    save: (s) => {
      stored = s;
    },
    onChange: () => () => {},
    close: () => {},
  };
  const t = await setupRumCore<RumPlatformOptions, Telemetry>(
    {},
    { viewName: () => "app" },
    {
      platform: "react_native",
      bind: async (options, w) => {
        w.consentController(createConsentController({ initial: "granted" }));
        const tracerProvider = new TracerProvider({
          spanProcessors: [
            ...(options.spanProcessor === undefined ? [] : [options.spanProcessor]),
            {
              onStart: () => {},
              onEnd: (s) => spans.push(s.name),
              forceFlush: async () => {},
              shutdown: async () => {},
            },
          ],
        });
        const telemetry = {
          tracerProvider,
          loggerProvider: new LoggerProvider(),
          resource: { attributes: { "service.name": "bare" } },
          event: (name: string) => events.push(name),
          forceFlush: async () => ({}),
          shutdown: async () => {
            await tracerProvider.shutdown();
            return {};
          },
        };
        return telemetry as unknown as Telemetry;
      },
      lifecycle: {
        visible: () => true,
        subscribe: (h) => {
          handlers = h;
          return () => {
            handlers = undefined;
          };
        },
      },
      openRetentionQueue: async (o) => createMemoryQueue(o),
      sessionStore: () => store,
      now: Date.now,
      perfNow: () => performance.now(),
      timeOrigin: Date.now() - performance.now(),
      location: () => "app:///",
      prerendered: () => false,
      connection: () => undefined,
    },
  );
  const sessionId = t.rum.sessionId();
  t.rum.addAction("tap");
  handlers?.hide();
  await t.shutdown();
  return { sessionId, events, spans, unsubscribed: handlers === undefined };
}
