/**
 * The server Platform: process.env, AsyncLocalStorage context, resource detection, exporters from
 * OTEL_*, stdout and stderr lines, node:crypto hashing and UUIDs, and the global console for console capture.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Platform } from "@libo11y/core";
import { createContextManager } from "./context.ts";
import { buildExporters } from "./exporters.ts";
import { detectResource } from "./resource.ts";

/** A new server Platform for createTelemetryWith and setupWith. */
export function serverPlatform(): Platform {
  return {
    name: "server",
    env: () => process.env,
    detectResource,
    contextManager: createContextManager,
    buildExporters,
    writeConsoleLine: (line) => {
      process.stdout.write(`${line}\n`);
    },
    writeDiagnosticLine: (line) => {
      process.stderr.write(`${line}\n`);
    },
    sha1: async (data) => new Uint8Array(createHash("sha1").update(data).digest()),
    hmacSha256: (key, data) => new Uint8Array(createHmac("sha256", key).update(data).digest()),
    randomUUID: () => randomUUID(),
    console: globalThis.console,
  };
}
