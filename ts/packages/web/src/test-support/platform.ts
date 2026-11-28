/**
 * A minimal core Platform that runs in browsers, Bun and Node, so tests can drive real core
 * telemetry without the full browser setup: StackContextManager, no environment, an empty resource, no exporters of its own (inject
 * spanExporter, metricReader or logExporter through the options), console lines collected, Web
 * Crypto hashing. Tests and browser fixtures only; never built.
 */
import type { Platform, RecordingGate } from "@libo11y/core";
import type { ContextManager } from "@opentelemetry/api";
import { StackContextManager } from "@opentelemetry/sdk-trace";

/** Options for testPlatform. */
export interface TestPlatformOptions {
  readonly gate?: RecordingGate;
  readonly contextManager?: () => ContextManager;
  /** Receives every console sink line. */
  readonly lines?: string[];
}

export function testPlatform(opts: TestPlatformOptions = {}): Platform {
  return {
    name: "web",
    env: () => ({}),
    detectResource: async () => ({ detected: {}, fromEnv: {} }),
    contextManager: opts.contextManager ?? (() => new StackContextManager()),
    buildExporters: () => ({}),
    writeConsoleLine: (line) => {
      opts.lines?.push(line);
    },
    writeDiagnosticLine: () => {},
    sha1: async (data) =>
      new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>)),
    randomUUID: () => crypto.randomUUID(),
    ...(opts.gate === undefined ? {} : { gate: opts.gate }),
  };
}
