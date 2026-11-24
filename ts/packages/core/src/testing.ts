/**
 * A Platform for tests: hermetic, with console and diagnostic lines captured in arrays. Exported as
 * the `@libo11y/core/testing` subpath.
 */
import type { ContextManager } from "@opentelemetry/api";
import { SDK_INFO } from "@opentelemetry/core";
import type { Platform } from "./platform.ts";
import { sha1 } from "./sha1.ts";
import { hexEncode } from "./utf8.ts";

export type { Platform } from "./platform.ts";

/** A Platform whose console and diagnostic lines land in arrays. */
export interface TestPlatform extends Platform {
  /** Every line the default writeConsoleLine received. */
  readonly lines: string[];
  /** Every line the default writeDiagnosticLine received. */
  readonly diagnostics: string[];
}

/** Options for createTestPlatform: any Platform member, plus the required context manager factory. */
export type TestPlatformOptions = Partial<Platform> & { contextManager: () => ContextManager };

type CryptoLike = { getRandomValues?(a: Uint8Array): Uint8Array };

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto;
  if (crypto?.getRandomValues !== undefined) return crypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function randomUUIDv4(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = hexEncode(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Returns a test Platform. By default it has an empty environment, detects only the upstream
 * telemetry.sdk.* attributes, builds no exporters, and captures console and diagnostic lines.
 */
export function createTestPlatform(overrides: TestPlatformOptions): TestPlatform {
  const lines: string[] = [];
  const diagnostics: string[] = [];
  const detected = Object.fromEntries(
    Object.entries(SDK_INFO).filter(([k]) => k.startsWith("telemetry.sdk.")),
  );
  return {
    name: "test",
    env: () => ({}),
    detectResource: async () => ({ detected: { ...detected }, fromEnv: {} }),
    buildExporters: () => ({}),
    writeConsoleLine: (line: string) => {
      lines.push(line);
    },
    writeDiagnosticLine: (line: string) => {
      diagnostics.push(line);
    },
    sha1: async (data: Uint8Array) => sha1(data),
    randomUUID: randomUUIDv4,
    ...overrides,
    lines,
    diagnostics,
  };
}
