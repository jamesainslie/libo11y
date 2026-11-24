/**
 * The errors libo11y throws. Each carries a code to branch on, and its message is the Go
 * implementation's, byte for byte, so the two read the same in logs and runbooks.
 */
import { goQuote } from "@libo11y/spec";

/** What went wrong, one code per Go sentinel error or wrapped failure. */
export type O11yErrorCode =
  | "ALREADY_SETUP"
  | "NO_SERVICE_NAME"
  | "NO_ENVIRONMENT"
  | "INVALID_ENVIRONMENT"
  | "PII_HASH_KEY"
  | "INVALID_APP_REGISTRY"
  | "CANARY_REJECTED"
  | "UNSUPPORTED_PROTOCOL"
  | "EXPORTER";

/** An error from libo11y setup or configuration. */
export class O11yError extends Error {
  /** The kind of failure. */
  readonly code: O11yErrorCode;

  constructor(code: O11yErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "O11yError";
    this.code = code;
  }
}

/** The signals an exporter is built for, as Go names them in its wrapped errors. */
export type ExporterKind = "span exporter" | "metric reader" | "log exporter";

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Go ErrAlreadySetup. */
export function alreadySetupError(): O11yError {
  return new O11yError("ALREADY_SETUP", "o11y: already set up");
}

/** Go ErrNoServiceName. */
export function noServiceNameError(): O11yError {
  return new O11yError(
    "NO_SERVICE_NAME",
    "o11y: service name required: set WithServiceName or OTEL_SERVICE_NAME",
  );
}

/** Go ErrNoEnvironment. */
export function noEnvironmentError(): O11yError {
  return new O11yError(
    "NO_ENVIRONMENT",
    "o11y: deployment environment required: set WithEnvironment or deployment.environment.name",
  );
}

/** Go ErrInvalidEnvironment wrapped with the value (%q) and the sorted allowed list. */
export function invalidEnvironmentError(value: string, allowed: Iterable<string>): O11yError {
  const list = [...allowed].sort().join(", ");
  return new O11yError(
    "INVALID_ENVIRONMENT",
    `o11y: deployment environment not in the allowed set: ${goQuote(value)} (allowed: ${list})`,
  );
}

/** Go ErrPIIHashKey. */
export function piiHashKeyError(): O11yError {
  return new O11yError(
    "PII_HASH_KEY",
    "o11y: PIIHash requires WithPIIHashKey with a key of at least 32 bytes",
  );
}

/** Go ErrInvalidAppRegistry for a registry that breaks rules, each violation in Violation.String form. */
export function invalidAppRegistryError(source: string, violations: readonly string[]): O11yError {
  return new O11yError(
    "INVALID_APP_REGISTRY",
    `o11y: invalid application registry: ${source}: ${violations.join("; ")}`,
  );
}

/** Go ErrInvalidAppRegistry for two registries that declare one namespace. */
export function duplicateNamespaceError(first: string, second: string, namespace: string): O11yError {
  return new O11yError(
    "INVALID_APP_REGISTRY",
    `o11y: invalid application registry: ${first} and ${second} both declare namespace ${goQuote(namespace)}`,
  );
}

/** Go's "o11y: startup canary rejected by log pipeline: %w". */
export function canaryRejectedError(cause: unknown): O11yError {
  return new O11yError(
    "CANARY_REJECTED",
    `o11y: startup canary rejected by log pipeline: ${causeText(cause)}`,
    {
      cause,
    },
  );
}

/** An OTLP protocol libo11y does not ship, such as grpc. */
export function unsupportedProtocolError(protocol: string, signal: "traces" | "metrics" | "logs"): O11yError {
  return new O11yError(
    "UNSUPPORTED_PROTOCOL",
    `o11y: unsupported OTLP protocol ${goQuote(protocol)} for ${signal}: use http/protobuf or http/json`,
  );
}

/** Go's "o11y: building <span exporter|metric reader|log exporter>: %w". */
export function exporterError(kind: ExporterKind, cause: unknown): O11yError {
  return new O11yError("EXPORTER", `o11y: building ${kind}: ${causeText(cause)}`, { cause });
}
