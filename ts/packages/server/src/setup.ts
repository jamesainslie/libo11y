/**
 * setup and createTelemetry bound to the server platform: Go's Setup and New for Bun and Node.
 */
import { createTelemetryWith, setupWith, type Telemetry, type TelemetryOptions } from "@libo11y/core";
import { serverPlatform } from "./platform.ts";

/**
 * Builds telemetry on the server platform, emits the o11y.telemetry.configured canary and installs
 * it globally: the AsyncLocalStorage context manager, the tracer, meter and logger providers, the
 * propagator and the error handler (Go Setup). A second call fails with ALREADY_SETUP until the
 * first telemetry shuts down.
 */
export function setup(options: TelemetryOptions = {}): Promise<Telemetry> {
  return setupWith(options, serverPlatform());
}

/** Builds telemetry on the server platform without touching any global or emitting the canary (Go New). */
export function createTelemetry(options: TelemetryOptions = {}): Promise<Telemetry> {
  return createTelemetryWith(options, serverPlatform());
}
