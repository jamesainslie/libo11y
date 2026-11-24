# Changelog

All notable changes to the libo11y TypeScript packages are documented
here: `@libo11y/spec`, `@libo11y/core`, `@libo11y/server` and
`@libo11y/test`, which release together at one version from a `ts/vX.Y.Z`
tag. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages
adhere to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@libo11y/spec`: the spec 1.2.0 attribute keys, enums, event and metric
  names, sensitivity tables and `SCHEMA_URL`, generated from
  `spec/registry`. The root entry point has no dependencies and runs in
  browsers.
- `@libo11y/spec`: `validateAppRegistry` and `compileAppRegistry` for
  application attribute registries, with the Go implementation's rule IDs
  and messages.
- `@libo11y/spec/yaml`: `parseAppRegistry` and `parseAppRegistryBytes`,
  which decode a registry file as Go's yaml.v3 does and throw
  `AppRegistryParseError` with a `kind`.
- `@libo11y/spec`: the `libo11y registry check FILE...` bin, with the Go
  binary's output and exit statuses.
- `@libo11y/core`: the platform-neutral core over OpenTelemetry JS 3.x.
  `setupWith` and `createTelemetryWith` build a `Telemetry` handle from
  `TelemetryOptions` and a `Platform`. Each option beats its `OTEL_*`
  variable.
- `@libo11y/core`: the tier-0 identity contract (`service.name`,
  `deployment.environment.name` from a closed set, the `0.0.0-unknown`
  version fallback), `service.instance.id` derived from Kubernetes pod
  identity as Go derives it, and one schema URL on the resource.
- `@libo11y/core`: the sensitivity policy on every signal. Secrets are
  dropped. PII is dropped, replaced by Go's keyed HMAC token
  (`piiMode: "hash"`), or kept. Application registries classify their own
  keys. Violations are counted on `o11y.schema.violations`.
- `@libo11y/core`: a logger with six levels and child bindings that writes
  JSON or text lines to the console and records to OTLP, correlated with
  the active span. `attrReplacer`, `captureConsole`, `forceEmit` and
  `logProcessor` match Go's attribute replacer, console capture,
  `ForceEmit` and `WithExtraLogHandler`.
- `@libo11y/core`: the `o11y.telemetry.configured` startup canary,
  `effectiveConfig()`, `Telemetry.event`, and wide records through
  `startRecord` and `currentRecord`.
- `@libo11y/core`: exemplars, which libo11y samples itself because
  upstream sdk-metrics records none. `ExemplarStore` holds the samples,
  `exemplarMetricExporter` attaches them to each collection, and
  `OtlpJsonMetricsSerializer` and `toOtlpMetricsObject` write them.
- `@libo11y/core`: a bounded, idempotent `shutdown` and a `forceFlush`
  that resolve with a per-signal `SignalReport` and never reject. The
  default deadline is 5000 ms.
- `@libo11y/core/testing`: `createTestPlatform` and `exemplarStoreOf` for
  platform authors.
- `@libo11y/server`: the server platform for Bun 1.3.13 and Node 24, with
  `setup` (Go `Setup`), `createTelemetry` (Go `New`) and `serverPlatform`.
- `@libo11y/server`: the `AsyncLocalStorage` context manager
  (`createContextManager`), resource detection, and OTLP exporters built
  from `OTEL_*` over `http/protobuf` or `http/json`. `grpc` fails with
  `UNSUPPORTED_PROTOCOL`. `OtlpProtobufMetricsSerializer` writes
  exemplars.
- `@libo11y/server`: `loadAppRegistry`, runtime metrics from upstream's
  `RuntimeNodeInstrumentation`, and `shutdownOnSignals`, whose
  `beforeShutdown` hook stops the HTTP server before telemetry shuts down.
- `@libo11y/server`: `instrumentServe` for fetch-style handlers and
  `instrumentFetch` for outbound requests, the counterparts of Go's
  `o11yhttp` handler and transport. `instrumentServe` takes `route`,
  `publicEndpoint`, `ignorePaths`, `serverTiming`, `canonicalLine` and
  `watchBody`. `setRoute` sets `http.route` from inside a handler for
  frameworks that route internally.
- `@libo11y/test`: `createRecorder`, a hermetic recorder with
  `assertConforms`, `assertCorrelated` and `assertTriangle`, and
  `startOtlpSink`, an in-process OTLP/HTTP receiver that decodes JSON and
  protobuf. `decodeOtlpProtobuf` and `normalizeOtlp` decode and compare
  bodies directly.

[Unreleased]: https://github.com/jamesainslie/libo11y/commits/main/ts
