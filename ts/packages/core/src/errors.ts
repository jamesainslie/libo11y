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
  | "UNSUPPORTED_PROPAGATOR"
  | "INVALID_OPTION"
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

// kindOfKey names what was given as a key by its kind alone. It never reads the value's content,
// length or text, and runs none of its code: a key, or anything mistaken for one, is a secret.
function kindOfKey(value: unknown): string {
  switch (typeof value) {
    case "string":
      return "a string (decode a hex or base64 secret into bytes first)";
    case "number":
      return "a number";
    case "bigint":
      return "a bigint";
    case "boolean":
      return "a boolean";
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    case "undefined":
      return "undefined";
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (ArrayBuffer.isView(value)) return "a view of another type";
  return value instanceof ArrayBuffer ? "an ArrayBuffer" : "an object";
}

/**
 * A piiHashKey that is not a Uint8Array, such as a string read from an environment variable. Go's
 * key is typed []byte, so this has no Go counterpart and the message is this implementation's own.
 * The message names the kind of value given and never the value, any part of it, or its length.
 */
export function piiHashKeyTypeError(key: unknown): O11yError {
  return new O11yError(
    "PII_HASH_KEY",
    `o11y: piiHashKey must be bytes: pass a Uint8Array of at least 32 bytes, not ${kindOfKey(key)}`,
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

/**
 * A name in OTEL_PROPAGATORS that libo11y does not ship, such as b3, or does not know. Go resolves
 * more names than this through a contrib registry, so the message is this implementation's own.
 */
export function unsupportedPropagatorError(name: string): O11yError {
  return new O11yError(
    "UNSUPPORTED_PROPAGATOR",
    `o11y: unsupported propagator ${goQuote(name)} in OTEL_PROPAGATORS: use tracecontext, baggage or none, or pass the propagators option`,
  );
}

/** The most characters of a rejected value a message repeats. */
const MAX_ECHOED_CHARACTERS = 64;

// The number of characters (code points) in s, counted without building anything.
function characters(s: string): number {
  let count = s.length;
  for (let i = 0; i + 1 < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdbff) continue;
    const next = s.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      count--;
      i++;
    }
  }
  return count;
}

// echoed renders text for a message: whole when it is short, otherwise its first 64 characters and
// a note that says so. A value read from the environment or a file can be any length and hold
// anything, and the message of a setup error is logged wherever it is caught. A character outside
// the basic plane is kept or left out whole.
function echoed(text: string, render: (s: string) => string): string {
  if (text.length <= MAX_ECHOED_CHARACTERS) return render(text);
  const total = characters(text);
  if (total <= MAX_ECHOED_CHARACTERS) return render(text);
  const head = Array.from(text.slice(0, MAX_ECHOED_CHARACTERS * 2)).slice(0, MAX_ECHOED_CHARACTERS);
  return `${render(head.join(""))} (the first ${MAX_ECHOED_CHARACTERS} of ${total} characters)`;
}

// describeValue names a rejected option value: a string quoted as Go quotes it, a number, boolean or
// bigint as it prints, each shortened past 64 characters, and anything else by its kind. An object
// is never converted to text, which could throw or print more than a message should carry.
function describeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return echoed(value, goQuote);
    case "number":
    case "boolean":
    case "bigint":
      return echoed(String(value), (s) => s);
    case "function":
      return "a function";
    case "symbol":
      return "a symbol";
    case "undefined":
      return "undefined";
  }
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : "an object";
}

/**
 * An option whose value is outside the closed set it takes, such as logLevel "verbose". Go's
 * options are typed, so this has no Go counterpart and the message is this implementation's own.
 */
export function invalidOptionError(
  option: string,
  value: unknown,
  allowed: readonly (string | boolean)[],
): O11yError {
  return new O11yError(
    "INVALID_OPTION",
    `o11y: invalid option ${option}: ${describeValue(value)} (allowed: ${allowed.join(", ")})`,
  );
}

/** Go's "o11y: building <span exporter|metric reader|log exporter>: %w". */
export function exporterError(kind: ExporterKind, cause: unknown): O11yError {
  return new O11yError("EXPORTER", `o11y: building ${kind}: ${causeText(cause)}`, { cause });
}
