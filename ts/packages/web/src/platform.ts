/**
 * WP3 (web platform and setup). The browser Platform, also used by @libo11y/webext.
 */
import type { Platform, RecordingGate } from "@libo11y/core";
import type { ContextManager } from "@opentelemetry/api";
import { createContextManager } from "./context.ts";
import { OTLP_SIGNALS } from "./contracts/otlp.ts";
import type { Delivery, SendMode } from "./contracts/transport.ts";
import type { BrowserExportOptions } from "./options.ts";
import { detectBrowserResource } from "./resource.ts";
import type { SignalEndpoints } from "./transport/endpoints.ts";
import { createExporterSet } from "./transport/exporters.ts";

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
 * The OTEL_* variables the platform reports: envDefaults, then exportOptions.env, then
 * OTEL_EXPORTER_OTLP_PROTOCOL=http/json, then OTEL_<SIGNAL>_EXPORTER=none for each signal whose
 * endpoint is undefined unless env names an exporter for it.
 */
export function browserEnv(
  exportOptions: BrowserExportOptions,
  endpoints: SignalEndpoints,
  envDefaults?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...envDefaults, ...exportOptions.env };
  env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  for (const signal of OTLP_SIGNALS) {
    const name = `OTEL_${signal.toUpperCase()}_EXPORTER`;
    if (endpoints[signal] === undefined && (env[name] ?? "").trim() === "") env[name] = "none";
  }
  return env;
}

/** The slice of Web Crypto randomUuid uses. */
export interface UuidCrypto {
  randomUUID?(): string;
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

/**
 * A random lowercase v4 UUID: crypto.randomUUID where it exists (secure contexts), else one built
 * from crypto.getRandomValues as RFC 9562 section 5.4 lays out. Internal.
 */
export function randomUuid(c: UuidCrypto = globalThis.crypto): string {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A browser Platform: env from browserEnv, detectBrowserResource, the context manager,
 * createExporterSet over the delivery, console lines through the console methods captured when the
 * platform is built (so captureConsole cannot recurse), SHA-1 by crypto.subtle, UUIDs by
 * crypto.randomUUID with a getRandomValues fallback outside secure contexts, the global console for
 * captureConsole, and gate. No runtime metrics.
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
    sha1: async (data) =>
      new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>)),
    randomUUID: () => randomUuid(),
    console: globalThis.console,
    gate: opts.gate,
  };
}
