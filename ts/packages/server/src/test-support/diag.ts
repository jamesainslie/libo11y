/**
 * Captures what is written through the OpenTelemetry diag logger while fn runs, at every level.
 * The diag logger is process-wide, so a test holds it only for the calls it checks.
 */
import { DiagLogLevel, diag } from "@opentelemetry/api";

export async function capturingDiag(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const logger = Object.fromEntries(
    (["error", "warn", "info", "debug", "verbose"] as const).map((level) => [
      level,
      (...args: unknown[]) => lines.push(`${level}: ${args.map(String).join(" ")}`),
    ]),
  ) as unknown as Parameters<typeof diag.setLogger>[0];
  diag.setLogger(logger, { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true });
  lines.length = 0;
  let captured: string[] = [];
  try {
    await fn();
  } finally {
    // Taken before the logger is removed, which the API itself reports through it.
    captured = [...lines];
    diag.disable();
  }
  return captured;
}
