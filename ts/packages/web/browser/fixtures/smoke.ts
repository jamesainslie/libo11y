/**
 * Scaffold. The smoke fixture: proves @libo11y/web, core and the OpenTelemetry SDK bundle for the
 * browser and evaluate without Node globals, and reports the platform APIs the transport and queue
 * rely on.
 */
import * as web from "@libo11y/web";
import * as internal from "@libo11y/web/internal";

const probe = {
  exports: Object.keys(web).sort(),
  internalExports: Object.keys(internal).length,
  compressionStream: typeof CompressionStream === "function",
  indexedDB: typeof indexedDB === "object",
  sendBeacon: typeof navigator.sendBeacon === "function",
  secureContext: globalThis.isSecureContext,
};
(globalThis as { __smoke?: typeof probe }).__smoke = probe;
