import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alreadySetupError,
  canaryRejectedError,
  duplicateNamespaceError,
  exporterError,
  invalidAppRegistryError,
  invalidEnvironmentError,
  invalidOptionError,
  noEnvironmentError,
  noServiceNameError,
  O11yError,
  piiHashKeyError,
  unsupportedPropagatorError,
  unsupportedProtocolError,
} from "./errors.ts";

// The messages are Go's (go/errors.go and the wrapping in go/resource.go, go/setup.go,
// go/appregistry.go and go/o11y.go), byte for byte.
test("each error carries its code and Go's message", () => {
  const cases: [O11yError, string, string][] = [
    [alreadySetupError(), "ALREADY_SETUP", "o11y: already set up"],
    [
      noServiceNameError(),
      "NO_SERVICE_NAME",
      "o11y: service name required: set WithServiceName or OTEL_SERVICE_NAME",
    ],
    [
      noEnvironmentError(),
      "NO_ENVIRONMENT",
      "o11y: deployment environment required: set WithEnvironment or deployment.environment.name",
    ],
    [
      piiHashKeyError(),
      "PII_HASH_KEY",
      "o11y: PIIHash requires WithPIIHashKey with a key of at least 32 bytes",
    ],
    [
      invalidAppRegistryError("lor.yaml", [
        "libo11y_app_attributes_empty: the registry declares no attributes",
      ]),
      "INVALID_APP_REGISTRY",
      "o11y: invalid application registry: lor.yaml: libo11y_app_attributes_empty: the registry declares no attributes",
    ],
    [
      duplicateNamespaceError("a.yaml", "b.yaml", "lor"),
      "INVALID_APP_REGISTRY",
      'o11y: invalid application registry: a.yaml and b.yaml both declare namespace "lor"',
    ],
    [
      unsupportedProtocolError("grpc", "traces"),
      "UNSUPPORTED_PROTOCOL",
      'o11y: unsupported OTLP protocol "grpc" for traces: use http/protobuf or http/json',
    ],
    [
      unsupportedPropagatorError("b3"),
      "UNSUPPORTED_PROPAGATOR",
      'o11y: unsupported propagator "b3" in OTEL_PROPAGATORS: use tracecontext, baggage or none, or pass the propagators option',
    ],
    [
      invalidOptionError("console", "pre\u0007tty", ["json", "text", false]),
      "INVALID_OPTION",
      'o11y: invalid option console: "pre\\atty" (allowed: json, text, false)',
    ],
  ];
  for (const [err, code, message] of cases) {
    assert.ok(err instanceof O11yError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "O11yError");
    assert.equal(err.code, code);
    assert.equal(err.message, message);
  }
});

test("an invalid environment is quoted as Go's %q and the allowed list is sorted", () => {
  const err = invalidEnvironmentError("prod\u0007", ["staging", "production", "test", "development", "qa"]);
  assert.equal(err.code, "INVALID_ENVIRONMENT");
  assert.equal(
    err.message,
    'o11y: deployment environment not in the allowed set: "prod\\a" (allowed: development, production, qa, staging, test)',
  );
});

test("several registry violations join with a semicolon", () => {
  const err = invalidAppRegistryError("registry 2", ["a: x", "b: attribute lor.y: z"]);
  assert.equal(err.message, "o11y: invalid application registry: registry 2: a: x; b: attribute lor.y: z");
});

test("an exporter error wraps its cause", () => {
  const cause = new Error("unknown exporter or metrics producer");
  for (const [what, want] of [
    ["span exporter", "o11y: building span exporter: unknown exporter or metrics producer"],
    ["metric reader", "o11y: building metric reader: unknown exporter or metrics producer"],
    ["log exporter", "o11y: building log exporter: unknown exporter or metrics producer"],
  ] as const) {
    const err = exporterError(what, cause);
    assert.equal(err.code, "EXPORTER");
    assert.equal(err.message, want);
    assert.equal(err.cause, cause);
  }
  assert.equal(exporterError("span exporter", "boom").message, "o11y: building span exporter: boom");
});

test("a rejected canary wraps its cause", () => {
  const cause = new Error("write failed");
  const err = canaryRejectedError(cause);
  assert.equal(err.code, "CANARY_REJECTED");
  assert.equal(err.message, "o11y: startup canary rejected by log pipeline: write failed");
  assert.equal(err.cause, cause);
});

test("the constructor sets code, message and cause", () => {
  const cause = new Error("inner");
  const err = new O11yError("EXPORTER", "o11y: x", { cause });
  assert.equal(err.code, "EXPORTER");
  assert.equal(err.message, "o11y: x");
  assert.equal(err.cause, cause);
  assert.equal(new O11yError("ALREADY_SETUP", "m").cause, undefined);
});
