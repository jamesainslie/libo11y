/**
 * WP3 (web platform and setup). setup and createTelemetry for browsers.
 */
import type { WebSetupOptions, WebTelemetry } from "./options.ts";

/**
 * Builds browser telemetry and installs it globally, as the server's setup does, then: records the
 * consent as the active consent, patches fetch and XMLHttpRequest and records the documentLoad span
 * as options.instrumentations says, and flushes on hide. In order: the consent controller, the
 * queue (openQueue, unless transport.offlineQueue is false), the endpoints, the HTTP transport, the
 * delivery (mode from document visibility), webPlatform, setupWith with console defaulting to
 * false, then the handle. consent.onRevoke flushes every provider into the closed gate, then clears
 * the delivery. After setup the queue is drained once.
 *
 * The handle is core's Telemetry extended in place with consent (so exemplarStoreOf still finds
 * it), and its shutdown also removes the instrumentation and listeners, clears the active consent,
 * shuts the delivery down and closes the queue, after the providers shut down.
 */
export function setup(options: WebSetupOptions = {}): Promise<WebTelemetry> {
  void options;
  throw new Error("not implemented");
}

/**
 * As setup, without any global: no providers, propagator or context manager installed, no
 * instrumentation, no canary, no active consent. It still flushes on hide and drains the queue.
 */
export function createTelemetry(options: WebSetupOptions = {}): Promise<WebTelemetry> {
  void options;
  throw new Error("not implemented");
}
