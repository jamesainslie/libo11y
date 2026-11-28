/**
 * WP3 (web platform and setup). The browser Platform, also used by @libo11y/webext.
 */
import { type Platform, type RecordingGate, sha1 } from "@libo11y/core";
import type { ContextManager } from "@opentelemetry/api";
import { createContextManager } from "./context.ts";
import type { Delivery, SendMode } from "./contracts/transport.ts";
import { randomUuid } from "./ids.ts";
import type { BrowserExportOptions } from "./options.ts";
import { detectBrowserResource } from "./resource.ts";
import type { SignalEndpoints } from "./transport/endpoints.ts";
import { browserEnv } from "./transport/env.ts";
import { createExporterSet } from "./transport/exporters.ts";

export { randomUuid, type UuidCrypto } from "./ids.ts";
export { browserEnv } from "./transport/env.ts";

/** Options for webPlatform. */
export interface WebPlatformOptions {
  /** Platform.name. Default "web". */
  readonly name?: "web" | "webext";
  readonly exportOptions: BrowserExportOptions;
  /** The resolved endpoints, from resolveEndpoints. */
  readonly endpoints: SignalEndpoints;
  /** The delivery the exporters use. */
  readonly delivery: Delivery;
  /** The consent gate, passed to core as Platform.gate. */
  readonly gate: RecordingGate;
  /** The send mode, for the exporters' unload splitting. Default () => "normal". */
  readonly mode?: () => SendMode;
  /** Default createContextManager. */
  readonly contextManager?: () => ContextManager;
  /** Extra OTEL_* defaults under exportOptions.env, such as the webext worker's short batch delays. */
  readonly envDefaults?: Readonly<Record<string, string>>;
}

/** What webPlatformWith builds on, so tests can replace the exporter set. Internal. */
export interface WebPlatformDeps {
  readonly createExporterSet: typeof createExporterSet;
}

/**
 * A browser Platform: env from browserEnv, detectBrowserResource, the context manager,
 * createExporterSet over the delivery, console lines through the console methods captured when the
 * platform is built (so captureConsole cannot recurse), the global console for captureConsole, and
 * gate. It uses crypto.subtle for SHA-1 with a TypeScript fallback, and crypto.randomUUID with a
 * getRandomValues fallback. No runtime metrics.
 */
export function webPlatform(opts: WebPlatformOptions): Platform {
  return webPlatformWith(opts, { createExporterSet });
}

/** webPlatform over the given dependencies. Internal: setup's and the tests' seam. */
export function webPlatformWith(opts: WebPlatformOptions, deps: WebPlatformDeps): Platform {
  const env = browserEnv(opts.exportOptions, opts.endpoints, opts.envDefaults);
  const mode = opts.mode ?? ((): SendMode => "normal");
  const userAgent = opts.exportOptions.userAgent === true;
  // Bound now, before captureConsole patches the console, so a sink line never re-enters capture.
  const log = console.log.bind(console);
  const warn = console.warn.bind(console);
  return {
    name: opts.name ?? "web",
    env: () => env,
    detectResource: (hermetic) => detectBrowserResource({ hermetic, userAgent, env }),
    contextManager: opts.contextManager ?? createContextManager,
    buildExporters: (req) => deps.createExporterSet(req, opts.delivery, opts.endpoints, { mode }),
    writeConsoleLine: (line) => log(line),
    writeDiagnosticLine: (line) => warn(line),
    sha1: async (data) => {
      const subtle = globalThis.crypto?.subtle;
      if (subtle === undefined) return sha1(data);
      return new Uint8Array(await subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
    },
    randomUUID: () => randomUuid(),
    console: globalThis.console,
    gate: opts.gate,
  };
}
