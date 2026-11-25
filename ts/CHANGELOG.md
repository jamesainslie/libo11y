# Changelog

All notable changes to the libo11y TypeScript packages are documented
here: `@libo11y/spec`, `@libo11y/core`, `@libo11y/server`,
`@libo11y/test`, `@libo11y/web` and `@libo11y/webext`, which release together at one version from a `ts/vX.Y.Z`
tag. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages
adhere to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-25

### Added

- `@libo11y/web`, the browser platform. `setup` and `createTelemetry` run
  the OpenTelemetry JS providers with a pluggable context manager
  (`StackContextManager` by default) and a browser resource of
  `browser.*` attributes. `user_agent.original` is recorded only with
  `userAgent: true`. The console sink defaults to off.
- `@libo11y/web`: an OTLP/HTTP JSON transport. Endpoints come from
  options or from an `env` map of `OTEL_*` variables. Normal sends are
  gzip-compressed through `CompressionStream`. Sends while the page is
  hidden go by `fetch` keepalive or `sendBeacon`, at most 64 KiB per body.
  Retryable failures wait in an IndexedDB queue shared by the origin's
  tabs, with leases, bounds, backoff with full jitter, `Retry-After` on
  `429` and `503`, and a drain on the `online` event and on the next page
  load.
- `@libo11y/web`: the consent gate, `telemetry.consent`, with the states
  `pending`, `granted` and `denied`. It starts `pending`, so nothing is
  recorded until `grant()`. `revoke()` stops recording and clears every
  queue. The gate can respect Do Not Track and Global Privacy Control.
- `@libo11y/web`: `fetch` and XHR client spans that inject trace context
  only into same-origin requests and a `propagateTo` allow-list, and the
  `documentLoad` span, which adopts the navigation's
  `Server-Timing: traceparent` as its parent.
- `@libo11y/webext`, the Manifest V3 extension platform. `setupWorker`
  stores every batch in IndexedDB before it sends it and drains the queue
  on every wake. `setupContentScript` forwards the batches of content
  scripts and extension pages to the worker by runtime messaging. Consent
  is one state for the extension, kept in `chrome.storage.local`.
  `sendMessage`, `onMessage` and `sendTabMessage` carry trace context
  across runtime messages.
- `@libo11y/core`: `RecordingGate` and `Platform.gate`. While a platform's
  gate is closed, no span is sampled, a span that ends is dropped, no
  measurement is kept, observable
  callbacks are not called, and no log record reaches the OTLP leg. The
  console sink still writes. The startup canary's OTLP leg is sent on the
  gate's first open. The server platform has no gate and is unchanged.
- The release check and the release workflow's smoke job bundle
  `@libo11y/web` and `@libo11y/webext` for the browser and fail on any
  Node builtin.

### Changed

- The release workflow publishes each package to npm directly through
  trusted publishing, with provenance. A release no longer waits for a
  maintainer to approve staged packages.

## [0.1.2] - 2026-11-24

### Changed

- The packages are unchanged from 0.1.1. The release workflow now stages
  them through npm trusted publishing, with no npm token, and each
  version still needs a maintainer to approve it with 2FA.

## [0.1.1] - 2026-11-24

### Changed

- The packages are unchanged from 0.1.0. The 0.1.0 release never reached
  npm, so 0.1.1 is the first version published there. The release
  workflow now stages each package for a maintainer to approve with 2FA.

## [0.1.0] - 2026-11-24

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

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/ts/v0.2.0...HEAD
[0.2.0]: https://github.com/jamesainslie/libo11y/compare/ts/v0.1.2...ts/v0.2.0
[0.1.2]: https://github.com/jamesainslie/libo11y/compare/ts/v0.1.1...ts/v0.1.2
[0.1.1]: https://github.com/jamesainslie/libo11y/compare/ts/v0.1.0...ts/v0.1.1
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/ts/v0.1.0
