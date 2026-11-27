# Changelog

All notable changes to the libo11y TypeScript packages are documented
here: `@libo11y/spec`, `@libo11y/core`, `@libo11y/server`,
`@libo11y/test`, `@libo11y/web`, `@libo11y/webext` and `@libo11y/rum`, which release together at one version from a `ts/vX.Y.Z`
tag. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages
adhere to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@libo11y/rum`, browser RUM over `@libo11y/web`. In development; it is
  not on npm yet. `setupRum` takes the options of the web `setup` and RUM's
  own under `rum`. It shares one session across the tabs of an origin
  through `localStorage` and a `BroadcastChannel`, ending a session after
  15 minutes idle or 4 hours. It records, stores and sends nothing until
  consent is granted, and revoking consent removes the session and the
  retention buffer. A session is head-sampled by a hash of its ID
  (`rum.sessionSampleRate`). Every consented session sends an
  `o11y.rum.view.summary` per view. The detail of a session that is not
  head-sampled waits in an IndexedDB retention buffer until an error or a
  frustration keeps the session. Every OTLP request carries the `sent_at`
  and `client_token` query parameters of the RUM gateway. The collectors
  arrive in later changes.
- `@libo11y/rum`: the `documentLoad` span of `@libo11y/web` becomes the
  `app_load` span shape under `setupRum`. It is renamed `app_load` and
  carries `o11y.rum.span.shape`, `o11y.rum.platform`, `session.id` and
  `o11y.rum.view.id`. `@libo11y/web` on its own still records
  `documentLoad`.
- `@libo11y/web/internal` exports `setupWithDeps`, `defaultSetupDeps` and
  `SetupDeps`, the seam `@libo11y/rum` builds on.
- Size budgets for the browser bundles in `ts/size-budget.json`, checked by
  `bun scripts/size.ts --check` (`make ts-size`) in CI.
- `conformance/rum-summary/`, the view summary vectors the TypeScript
  suite checks.

## [0.2.1] - 2026-11-27

### Added

- `@libo11y/core`: `OTEL_PROPAGATORS` selects the propagators when the
  `propagators` option is absent or empty, as the Go library reads it. It
  is a comma-separated list. Each entry is trimmed, an empty entry is
  dropped, and a name counts once, where it first appears. `tracecontext`
  and `baggage` apply in the order given, and a list that names `none`
  carries nothing. Unset or empty, the default stays `tracecontext` then
  `baggage`. The option beats the variable, `hermetic` ignores it, the
  baggage egress filter still wraps the result, and `effectiveConfig()`
  and the canary report the header fields in the configured order, `none`
  for the propagator that carries nothing, or `custom` for propagators
  that name no fields, which is Go's word. An entry is trimmed of the
  white space Go's `strings.TrimSpace` trims.
- `@libo11y/core`: `O11yErrorCode` gains `UNSUPPORTED_PROPAGATOR`.
  `setup`, `createTelemetry`, `setupWith` and `createTelemetryWith` reject
  with it when `OTEL_PROPAGATORS` names anything but `tracecontext`,
  `baggage` or `none`, even next to a supported name. Go resolves `b3`,
  `b3multi`, `jaeger`, `xray` and `ottrace`. These packages ship no
  propagator for them, and the message says to pass one through the
  `propagators` option.
- `@libo11y/core`: `O11yErrorCode` gains `INVALID_OPTION`. `setup`,
  `createTelemetry`, `setupWith` and `createTelemetryWith` reject with it
  when an option that takes a closed set of values holds anything else,
  and when `propagators` is not an array. The message names the option,
  the value and the allowed values, as in
  `o11y: invalid option logLevel: "verbose" (allowed: trace, debug, info,
  warn, error, fatal)`. A string or number in the message is shortened
  past 64 characters, and an object is named by its kind and never
  printed.

### Changed

- The 0.2.0 release never reached npm, because each package's trusted
  publisher allowed only staged publishing and the release workflow
  publishes directly. 0.2.1 is the first version of `@libo11y/web` and
  `@libo11y/webext` on npm. For every package it carries 0.2.0's changes
  together with the entries below.
- `@libo11y/core`: `OTEL_PROPAGATORS` is now read, where earlier versions
  ignored it. **Migration:** a process that already sets the variable changes on
  upgrade. A value that names anything but `tracecontext`, `baggage` or
  `none`, such as a fleet-wide `tracecontext,baggage,b3`, now fails setup
  with `UNSUPPORTED_PROPAGATOR`. `none` now switches propagation off, and
  `tracecontext` alone stops baggage. To keep the old behaviour, unset the
  variable for the process or pass the `propagators` option, which beats
  it.
- `@libo11y/core`: `O11yErrorCode` has two more members,
  `UNSUPPORTED_PROPAGATOR` and `INVALID_OPTION`. **Migration:** a `switch`
  over the code that TypeScript checks for exhaustiveness needs a case for
  each.

- `@libo11y/core`: a PII token is computed over one canonical rendering
  on every signal. The token for a span, span event, span link and
  resource attribute now uses the bounded rendering the log path always
  used: the value costs one node, each array element or map member one
  more, and past depth 16 or once 2048 nodes are spent the rest renders as
  `truncated`. The attribute path used to render without bounds, so the
  same large value had one token on a log record and another on a span.
  **Migration:** under `piiMode: "hash"`, the token changes for an
  attribute whose value is an array of more than 2047 elements, so such a
  token on a span or the resource does not join with the token earlier
  versions produced for the same value. It now joins with the token a log record
  carries. Every ordinary value, and any array of 2047 elements or fewer,
  keeps the token it had. The Go library made the same change, and the
  two agree again.
- `@libo11y/core`: an option outside the closed set of values it takes is
  refused when the telemetry is built, where it used to be accepted in
  silence. `logLevel: "verbose"` dropped every record, `error` and `fatal`
  included, and `console: "pretty"` wrote text. `logLevel`, `console`,
  `piiMode` and `exemplarFilter` are checked, and so are the boolean
  options `strictIdentity`, `captureConsole`, `logExport`,
  `runtimeMetrics`, `startupSummary` and `hermetic`, which must be `true`
  or `false`. A string or a number that used to be read as a boolean, such
  as `runtimeMetrics: 0` or `hermetic: "false"`, is now an error. An
  option that is `undefined` or `null` still takes its default, and the
  `OTEL_*` variables are read as before. **Migration:** a value passed
  straight from the environment or a config file can now fail setup, such
  as `logLevel: process.env.LOG_LEVEL` holding `INFO`,
  `console: process.env.LOG_FORMAT`, `hermetic: process.env.CI` or
  `captureConsole: "true"`. Convert it to one of the allowed values first.
- `@libo11y/core`: an instrument of the telemetry's meter provider reads a
  measurement's attributes once, into an object the library owns. A
  change the caller makes to the attributes object after the call, or to
  an array in it, no longer reaches the data point. The SDK used to keep
  the caller's own object when nothing in it was classified.
- `@libo11y/server`: each OTLP exporter is upstream's exporter base,
  export delegate, configuration and serializer over libo11y's own HTTP
  transport, in place of upstream's exporter classes. Upstream exports
  neither its HTTP transport nor its retrying transport, and neither can
  be stopped. A collector sees the same requests: the same headers,
  `User-Agent`, gzip, framing, retried statuses and network errors,
  backoff and `Retry-After` handling, and the diag logger gets the same
  messages about retries. The transport differs from upstream's in the
  next five entries and in nothing else. The package no longer depends on
  `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/exporter-trace-otlp-proto`,
  `@opentelemetry/exporter-logs-otlp-http` or
  `@opentelemetry/exporter-logs-otlp-proto`.
- `@libo11y/server`: `OTEL_EXPORTER_OTLP_TIMEOUT` bounds a whole export
  attempt: connecting, sending and reading the response. Upstream's
  timeout is an idle timeout that starts only once the socket has
  connected. A connection that never completes now fails at the timeout.
  A response that trickles in for longer than the timeout now fails too,
  where upstream let it run as long as bytes kept arriving.
- `@libo11y/server`: stopping an exporter destroys its requests in flight,
  cancels its wait between two retries and fails every later export at
  once. Upstream's transport does nothing when it is shut down.
- `@libo11y/server`: stopping an exporter destroys its HTTP agent, which
  closes the idle keep-alive connections to the collector.
- `@libo11y/server`: exports that start before an exporter's HTTP agent
  exists share one agent, where upstream builds one for each. A
  `Retry-After` longer than a timer can hold, about 24.8 days, waits that
  long, where upstream's timer fires after a millisecond.
- `@libo11y/server`: under Bun a gzip body is sent with a
  `Content-Length`, where upstream streams the compressed body and Bun
  frames that as chunked. The transport compresses the body before it
  sends it. Under Node both send a gzip body chunked, and a body that is
  not compressed is framed the same by both on each runtime.
- `@libo11y/core`: the logger copies an array, and a plain object inside
  an array, when it reads a record's attributes. A change made to the
  array after the call no longer reaches the record.
- `@libo11y/core`: `forceFlush` also waits for the exports that were in
  flight when a signal's turn came, such as a batch the timer had just
  sent, and reports one that fails. It does not wait for an export that
  starts later, so flushes that overlap do not hold each other back.
- `@libo11y/core`: `forceFlush` reports an export that fails at any point
  while the flush runs, whichever signal was flushing at the time.
- `@libo11y/core`: `shutdown` waits, inside its deadline, until every
  exporter it watches has nothing in flight, then fails the exports still
  in flight and calls each exporter's `shutdown()`. That includes an
  injected `spanExporter` or `logExporter`, whose `shutdown()` can now be
  called at the deadline while one of its exports is still in flight. An
  exporter's `shutdown()` should stop it without waiting for the
  collector.
- `@libo11y/core`: `timeoutMillis` of `shutdown` and `forceFlush` is read
  deliberately when it is not a number. A string that reads as a finite
  number is taken as that number, as before. Any other value that is not a
  number is the 5000 ms default, where it used to arm a timer that fired
  after a millisecond.
- `@libo11y/core`: the logger, the exporters and the instrumentation each
  have their own rate limit for `o11y: telemetry error` lines, a burst of
  five refilled one every 30 s, so a failure on a hot path cannot use up
  the lines an exporter failure needs.
- `@libo11y/server`: `instrumentFetch` and `instrumentServe` report their
  own failures through the `telemetry` they were given, so the lines are
  written for a `createTelemetry` handle too. Without a `telemetry` they
  go to the OpenTelemetry global error handler as before. A throw while
  ending a request is reported there too, where it went to the diag
  logger. So is a `route`, `propagate` or `watchBody` option that throws,
  which used to be written to the diag logger with the message of what
  was thrown. The report now names the class of the error only, because a
  message can quote the request's URL.

### Fixed

- `@libo11y/core`: no logger method throws into the application, and
  neither do `child` or `Telemetry.event`. An `attrReplacer` that throws,
  an attribute whose getter throws and a revoked `Proxy` used to throw
  from `logger.info`. Now an attribute that cannot be read or classified
  is dropped and the rest of the record is emitted. A replacer that fails
  drops the whole record, message included, so no attribute leaves
  unredacted. Each failure is reported on the diagnostic stream. A
  replacer or sink that fails on the startup canary still fails
  `setupWith` with `CANARY_REJECTED`.
- `@libo11y/core`: a report of such a failure names the step, the class of
  the error and the attribute key, and never the error's message. A
  message can quote the value that made the hook fail, as
  `new URL(value)` and `JSON.parse(value)` do. The error itself is on the
  report's `cause`.
- `@libo11y/core`: the logger reads each attribute once, before the policy
  classifies it. A value inside an array used to be read again by each
  sink, so a getter could return one value to the policy and another to
  the console.
- `@libo11y/core`: a log sink that throws is reported on the diagnostic
  stream. It used to be swallowed without a trace.
- `@libo11y/core`: wide records and metric instruments never throw into
  the application. `currentRecord().set(...)`, `add`, `max` and
  `emitEvent`, and `add`, `record` and an observable callback's `observe`
  on the telemetry's meter provider, used to throw when an attribute could
  not be read, such as a getter that throws or a revoked `Proxy`. Now the
  attribute is dropped, the rest is kept, the measurement or the event
  still goes out, and the failure is reported without the message of what
  was thrown. An instrument and `emitEvent` report through the telemetry's
  own handler. `set`, `add` and `max` have no telemetry and report to the
  OpenTelemetry global error handler. Span attributes are read by
  upstream's tracer and can still throw.
- `@libo11y/server`: `instrumentFetch` and `instrumentServe` never fail a
  request because of telemetry. A propagator that throws on `inject` or
  `extract` used to fail the request. Now it is reported and the request
  goes on without the propagated context. A span that cannot start leaves
  the request uninstrumented, and a span that cannot end replaces neither
  the response nor the request's own error. A handler's own error and a
  failed fetch still reach the caller.
- `@libo11y/server`: `instrumentServe` calls the handler as if it were not
  wrapped when it cannot read the request, such as a value that is not a
  `Request`, where it used to throw before the handler ran. A handler or
  a `fetchImpl` that resolves with something that is not a `Response`
  gets that value returned unchanged, where reading its status used to
  throw.
- `@libo11y/core`: a `forceFlush` that overlaps another resolves only when
  what its caller emitted before the call has been exported. Upstream's
  batch log processor returns at once from a flush that overlaps another,
  so the second caller could get `ok: true` with its own record still
  unsent, which loses the record in a function that is frozen right after
  the flush. Callers that arrive while a flush of logs runs now share one
  follow-up flush that starts when the running one ends, so a caller
  waits for the rest of one flush and one more, never longer.
- `@libo11y/core`: the report of `shutdown` and `forceFlush` includes a
  signal whose export failed. When the collector answered an error status,
  refused the connection or timed out, `shutdown` used to resolve with
  `ok: true` for logs and metrics, because upstream's batch log processor
  and periodic metric reader report a failed export to the error handler
  only. Each failed signal now also gets its `o11y.telemetry.dropped`
  event.
- `@libo11y/server`: once `shutdown` has resolved, the telemetry holds
  nothing that keeps the process alive. With an unreachable collector a
  Node process used to stay up for as long as the operating system kept
  trying to connect, more than a minute, and a Bun process until the 10 s
  OTLP timeout. Shutdown now ends the requests in flight and the waits
  between retries when its deadline passes. One case remains under Node:
  a name lookup in progress cannot be cancelled, so when the collector's
  host name does not resolve and the resolver does not answer, the process
  stays alive until the resolver gives up, 10 s where it was measured.
- `@libo11y/core`: `shutdown` fails the exports still in flight when it
  settles, which clears the export timers of upstream's batch processors
  and periodic reader. A deadline shorter than the export timeout used to
  leave the process alive until the export timeout.
- `@libo11y/server`: `shutdownOnSignals` gives `beforeShutdown` and the
  telemetry shutdown one deadline between them, and the two never take
  longer than `timeoutMillis`. Each used to get the whole of it, so the
  two could take twice as long as stated. `beforeShutdown` may now use
  nine tenths of the deadline, and the shutdown gets what is left of the
  whole, which is never less than a tenth. A `beforeShutdown` that needs
  more than nine tenths is reported as a `lifecycle` error and the
  shutdown starts without it. **Migration:** a `beforeShutdown` that
  relied on the whole deadline now gets nine tenths of it. Raise
  `timeoutMillis` if it needs longer.

### Security

- `@libo11y/core`: a `piiHashKey` that is not a `Uint8Array` is refused
  with `PII_HASH_KEY`, in every `piiMode`. Versions up to 0.2.0 accepted a
  string. The length check passed, because a 32-character string has
  length 32, and the string was then converted to an empty byte array, so
  every token was HMAC-SHA256 under an empty key. Anyone who could read
  such tokens could recover a low-entropy value, such as an IP address,
  by trying candidates. Two different string keys also produced the same
  tokens.

  Who is affected: a caller that passed a string, for example
  `piiHashKey: process.env.PII_HASH_KEY`. The type forbids it, so this
  takes JavaScript or a cast in TypeScript. A key that was a `Uint8Array`
  or a `Buffer` of at least 32 bytes was never affected, and its tokens
  are unchanged.

  What to do: upgrade, and pass the key as bytes, for example
  `Buffer.from(process.env.PII_HASH_KEY, "base64")`. Treat tokens that
  were produced with a string key as unprotected. They will not join with
  tokens produced after the fix.

  The message of the error names the kind of value given and never the
  key, any part of it, or its length. The policy also refuses to compute a
  token under anything but a `Uint8Array` of at least 32 bytes, and drops
  the value, so no other path can reach an empty key.

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

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/ts/v0.2.1...HEAD
[0.2.1]: https://github.com/jamesainslie/libo11y/compare/ts/v0.2.0...ts/v0.2.1
[0.2.0]: https://github.com/jamesainslie/libo11y/compare/ts/v0.1.2...ts/v0.2.0
[0.1.2]: https://github.com/jamesainslie/libo11y/compare/ts/v0.1.1...ts/v0.1.2
[0.1.1]: https://github.com/jamesainslie/libo11y/compare/ts/v0.1.0...ts/v0.1.1
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/ts/v0.1.0
