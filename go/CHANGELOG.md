# Changelog

All notable changes to the libo11y Go module are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the module adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing has been released yet. The first release will be `go/v0.1.0`,
followed by `go/o11ygin/v0.1.0`. Entries under Changed, Fixed, and Security
describe changes relative to earlier unreleased development commits, so
anyone tracking a pre-release commit can see what moved.

### Added

- Telemetry specification and enforcement: the `spec/` registry
  drives generated `spec` (typed keys, enums, event names, schema/version
  constants, slog+9 severity) and internal validation tables. Runtime
  enforcement: required tier-0 identity at init (`WithEnvironment`,
  `WithEnvironmentValues`, `WithServiceNamespace`, `WithoutStrictIdentity`,
  `ErrNoEnvironment`, `ErrInvalidEnvironment`), `service.instance.id`
  derivation, single schema-URL stamping, a key-based sensitivity policy
  (`WithPIIMode`, `o11y.schema.violations` self-metric), the `SDK.Event`
  API, the `Record` wide-event accumulator with
  `o11yhttp.WithCanonicalLine`, and `o11ytest` conformance assertions.
  Build-info attributes use their spec forms (`vcs.ref.head.revision`,
  `o11y.build.time`, `o11y.build.modified`).
- `o11y.Setup` and `o11y.New`: one-call OpenTelemetry pipeline construction
  (traces, metrics, logs over OTLP) returning an owned `SDK` handle with
  idempotent, per-signal-reporting `Shutdown` and `ForceFlush`.
- Standard `OTEL_*` environment configuration via autoexport and resource
  detection, with strict option-over-environment-over-default precedence
  and required `service.name` resolution.
- Correlated slog pipeline: console (JSON/text) and OTLP sinks behind one
  fan-out handler with full `slog.Handler` contract compliance, top-level
  `trace_id`/`span_id` on console records, uniform attribute replacer, and
  runtime-adjustable level.
- W3C Trace Context + Baggage propagation installed by default.
- Runtime metrics on by default; `WithHistogramBuckets` and `WithViews`
  for metric shaping.
- `o11yhttp`: route-aware net/http server and client instrumentation on
  stable HTTP semantic conventions, with path filtering and public-endpoint
  mode.
- `o11ygrpc`: gRPC server and client stats handlers.
- `redact`: capture-time protection (`Secret`, `Masked`, tag-driven
  `Struct` with mask/redact/omit, strictest-wins nesting, fail-closed
  unknown tags) across slog, fmt, and JSON surfaces.
- `o11ytest`: hermetic in-memory test harness recording spans, metrics,
  and correlated log records, safe under `t.Parallel()`.
- Runnable HTTP server example.
- First-class exemplar support for metric-to-trace reconciliation:
  `WithExemplarFilter` option (default trace-based, honoring
  OTEL_METRICS_EXEMPLAR_FILTER), `o11ytest.Recorder.Exemplars` accessor
  (including exponential histograms), and tests pinning that spans, logs,
  and metric exemplars from one operation share one trace identity,
  including through the HTTP middleware's duration histogram.
- Rust-client parity features: `ForceEmit` context marker for always-emit
  audit records; startup summary record doubling as an initialization
  canary (sink failures fail `Setup`) with `SDK.EffectiveConfig` accessor;
  build-info resource detector (module version and VCS stamp) and
  container detector; `SDK.ShutdownOnSignals` lifecycle helper;
  `o11ygin` Gin middleware as a nested module. Parity matrix in
  `docs/PARITY.md`.
- `redact`: the `o11y` tag accepts the specification's vocabulary,
  `confidential` (masks) and `secret` (redacts) (`730a2d6`).
- Baggage egress filter: an inject-only seam that filters baggage members
  leaving the process, with an allow-all default predicate (`866f2e4`).
  Extraction is never altered.
- `WithLogExporter` injects a log exporter (records are still batched;
  `nil` disables log export), and `SDK.LoggerProvider` exposes the logger
  provider for bridges other than slog. Records from those bridges get the
  same sensitivity enforcement as slog records.
- `WithoutOTELEnv`: an opt-in mode in which no `OTEL_*` variable affects
  behavior apart from the experimental `OTEL_GO_X_PER_SERIES_START_TIMESTAMPS`
  and `OTEL_GO_X_DEPRECATED_RUNTIME_METRICS` switches, which have no
  overriding option. Configuration comes from options and library defaults,
  a signal with nothing injected is disabled, and keys named in
  `OTEL_RESOURCE_ATTRIBUTES` that the library resource does not define are
  shadowed with empty values (they are exported as `key=""`).
- `WithPIIHashKey` and `ErrPIIHashKey` for keyed PII hashing.
- `o11ygrpc.WithPublicEndpoint` (links inbound trace context instead of
  adopting it) and `o11ygrpc.WithIgnoreHealthChecks` (excludes
  `grpc.health.v1` probes from tracing and metrics); `o11ygin.WithSpanNameFormatter`.
  The `o11ygin` docs list its exact option set and require registering the
  middleware before `gin.Recovery()`.
- Under `WithoutStrictIdentity`, missing or invalid identity is counted on
  `o11y.schema.violations` (signal `resource`, rules
  `identity_service_name`, `identity_environment`,
  `identity_environment_invalid`), and `spec.SignalResource` names that
  signal.
- Schema artifact: the generator writes the OpenTelemetry schema file
  `spec/schemas/1.0.0` (file format 1.1.0) for the schema URL. Publishing
  it at the URL, and tagging `spec/v1.0.0`, are release steps not yet
  taken.
- Spec-check rules for references, tombstones, enums, units, annotations,
  stabilities, requirement levels, and generated-name collisions; every
  rule ID is listed in `docs/SPEC.md`, section 8.
- `make release-check` (`scripts/release-check.sh`) validates the release
  sequence, `go/vX.Y.Z` then `go/o11ygin/vX.Y.Z`, against a throwaway local
  remote. `go/o11ygin` now requires `github.com/jamesainslie/libo11y/go`
  v0.1.0 instead of a placeholder pseudo-version.
- CI: `.github/workflows/ci.yml` runs the same gates as `make ci` (lint,
  vet, race tests, tidy check, spec check and drift, release check,
  govulncheck). Every job calls the Makefile target except lint, which runs
  the same golangci-lint version through `golangci/golangci-lint-action`.
- `ExampleNew`, a smoke test for `examples/httpserver`, and OTLP wire-level
  tests against in-process gRPC and HTTP receivers.

### Changed

- Minimum Go version raised from 1.25.0 to 1.26.0 for both the `go` and
  `go/o11ygin` modules. `golang.org/x/net` v0.60.0, the first release that
  fixes GO-2026-6603, GO-2026-6610, GO-2026-6611, GO-2026-6612, and
  GO-2026-6617, declares `go 1.26.0`, as do the OpenTelemetry v1.47.0
  releases adopted here. No version of `x/net` that clears those
  advisories supports Go 1.25.
- Dependencies upgraded: OpenTelemetry Go v1.47.0 (`otel/log` and
  `otel/sdk/log` now on the stable v1 line), OTLP log exporters v0.23.0,
  contrib v0.72.0 (`otelslog` bridge v0.21.0), gRPC v1.84.0, and
  `golang.org/x/net` v0.61.0. The global LoggerProvider is now installed
  through `otel.SetLoggerProvider`, which replaces the deprecated
  `otel/log/global` package with identical behavior. `SDK.LoggerProvider`
  and `WithLogExporter` expose the stable `otel/log` v1 types, so
  custom log exporters read attributes as `attribute.KeyValue` and
  `attribute.Value`.
- Breaking (pre-1.0): the default PII mode is `PIIDrop` (it was `PIIHash`,
  and the `PIIMode` constant values changed with it). `PIIHash` now emits
  `hmac-sha256:` plus 32 hex digits, HMAC-SHA256 keyed by
  `WithPIIHashKey` (at least 32 bytes) and truncated to 128 bits, over one
  canonical rendering shared by every signal; it replaces the unkeyed
  `sha256:` prefix of 64 bits. `New` and `Setup` fail with `ErrPIIHashKey`
  when `PIIHash` has no adequate key.
- Breaking (pre-1.0): the startup event `o11y.telemetry.configured` carries
  its settings as `o11y.config.<key>` attributes (`o11y.config.traces`,
  `o11y.config.sampler`, ...) instead of bare keys, which violated its
  registered contract. It adds `o11y.config.service_version_fallback` and
  the per-signal `traces_endpoint`, `metrics_endpoint`, and
  `logs_endpoint`, and reports only sampler names the Go SDK accepts.
- Breaking (pre-1.0): `WithSpanProcessor` no longer displaces
  `WithTraceExporter`; when both are given, both run. A processor alone
  still owns the export path.
- Breaking (pre-1.0): the forbidden keys (`host.ip`, `host.mac`,
  `process.command_line`, `process.command_args`, `device.id`) no longer
  have generated constants in `spec` (`HostIPKey`, `HostMACKey`,
  `ProcessCommandLineKey`, `ProcessCommandArgsKey`, and `DeviceIDKey` are
  removed). They remain classified, so the sensitivity policy still
  handles them.
- Breaking (pre-1.0): `spec.SchemaURL` is
  `https://schemas.o11y.ing/libo11y/1.0.0` (it was a
  raw.githubusercontent.com URL), stamped on every resource. The URL is not
  yet served.
- Breaking (pre-1.0): `o11ytest.Start` builds its SDK with
  `WithoutOTELEnv`, so ambient `OTEL_*` variables no longer change harness
  behavior. Keys named in `OTEL_RESOURCE_ATTRIBUTES` that the harness
  resource does not define appear on recorded telemetry with empty values.
- Breaking (pre-1.0): `redact.Struct` output shapes. Maps render sorted by
  key text (ties broken by the key's dynamic type name). A map under a mask
  floor, with a key type that may carry protection, or with two keys of
  equal text renders by position, `{"0":{"key":...,"value":...}}`, with the
  key masked, or `REDACTED` when its type may carry protection. Values
  with a text form whose type cannot carry protection (`time.Time`,
  `net.IP`) render as text. Errors render their `Error()` text, or
  `REDACTED` when anything reachable from them may carry protection.
  Cycles and structures deeper than 32 levels render `REDACTED`.
- `Shutdown` stops logs, metrics, and traces concurrently under one
  deadline instead of in sequence, so a hung exporter cannot consume the
  others' budget. The first call runs the shutdown and every call returns
  its result; a concurrent caller stops waiting when its own context ends.
- Every stream of the SDK's own instruments now carries the sensitivity
  policy's attribute filter, so an instrument's experimental advisory
  attribute keys are no longer honored.
- Internal (no public API change): the generated `Sensitivity` zero value
  in the internal `spectables` package is `Unclassified` (it was `Public`),
  and an unknown sensitivity class in the registry is a generator error
  instead of a silent `Internal`.
- `SDK.Propagator` returns the configured propagator wrapped by the
  baggage egress filter, including a propagator passed to
  `WithPropagators`.
- `SDK.Event` and `Record.EmitEvent` drop any caller-supplied
  `event.name` (the library sets it) and keep only the last value of a
  duplicated key, so attributes passed to `EmitEvent` replace accumulated
  ones.

### Fixed

- The log classifier crashed the process on uncomparable values (slices,
  maps) because it compared `slog.Value`s; it now tracks the action taken.
  `WithAttrs` and `WithGroup` on the classifying handler classify
  pre-bound attributes and extend the group path.
- `redact.Struct`: the mask floor applies to every value kind a
  `LogValuer` returns; map keys are masked under a mask floor; pointer and
  interface traversal is bounded and `nil` no longer panics; `time.Time`,
  `net.IP`, and similar leaf types render as text instead of being
  mangled; tagged values a `LogValuer` returns under passthrough are
  walked; text-marshaling types that may carry tags are walked instead of
  trusted; func and chan components fail closed; map keys whose type may
  carry tags render `REDACTED`; colliding key text renders positionally;
  and errors render through `Error()` instead of vanishing.
- `o11yhttp.WithCanonicalLine`: route span names and the `http.route`
  metric attribute survive the canonical wrapper; optional writer
  interfaces (`http.Flusher`, `http.Hijacker`, `io.ReaderFrom`) are
  preserved; the summary reports the first committed final status (101
  for hijacked connections, 500 only when a panic committed nothing);
  writer hooks are observed only after they take effect; and requests
  excluded by `WithFilter` or `WithIgnorePaths` emit no summary.
- `o11yhttp`: a panicking handler marks the server span Error, and unknown
  request methods are normalized to `_OTHER` with
  `http.request.method_original`, bounding span-name and summary
  cardinality.
- Grouped log attributes are classified on their dotted effective key, so
  `slog.Group("host", slog.String("ip", v))` is judged as `host.ip`
  (`d477b9d`). Go maps, slices of maps, and pointers logged as one value
  are walked on every sink and bridge, with cycle detection, a depth
  bound, and a 2048-node budget, failing closed.
- One span violation is counted once when an injected processor and an
  injected exporter both run.
- `Shutdown` returns the finished result to a later caller whose context
  is already done, instead of a spurious waiting error.
- Event attribute deduplication passes inline groups (empty keys) through.
- `conformance.CheckEvent` no longer accepts a bare `<template>.` key as
  satisfying a template requirement.
- `o11ytest.AssertConforms` fails on what the code under test emits:
  secret attributes it put on logs or spans (through
  `o11y.schema.violations`), events missing required attributes, and
  secret attributes visible in recorded telemetry, reading grouped log
  attributes under their dotted keys. It flushes before reading the
  violation count and reports resource violations from harness options
  separately.
- The registry loader decodes every file strictly (unknown fields fail,
  including in nested enum and deprecation mappings); spec-check enforces
  cross-group references, cardinality through references, enums, units,
  and annotations, which it previously claimed but did not check;
  `make spec-generate` validates before writing and writes nothing unless
  every artifact renders; `make spec-drift` also fails on untracked
  generated files; and a golden test catches drift in `go test`.
- The credential headers (`http.request.header.authorization`,
  `http.request.header.proxy-authorization`, `http.request.header.cookie`,
  `http.response.header.set-cookie`) are classified secret.
- The quick starts, the package doc, and `examples/httpserver` set a
  deployment environment, so they no longer fail with `ErrNoEnvironment`.
  The example sets server timeouts, drains before exiting, and no longer
  echoes upstream errors to clients.

### Security

- Grouped attributes bypassed classification: a secret or PII attribute
  inside `slog.Group` was judged on its leaf key and emitted (`d477b9d`).
- Secret span attributes were exported unredacted; the exporter now
  redacts span attributes (`a923ad6`) and span event and link attributes
  (`b524912`).
- Logging a slice or map could crash the host process through the
  classifier (see Fixed).
- `redact.Struct` leaked values under a mask floor (non-string `LogValuer`
  results, map keys, text forms of types with nested tags) and could hang
  on pointer or interface cycles.
- The startup summary echoed `OTEL_EXPORTER_OTLP_*ENDPOINT` values verbatim,
  including userinfo, query, and fragment credentials, to every sink.
  Endpoints are now sanitized, and a value with an ambiguous `@` is
  withheld. URL paths are kept, so credentials placed in an endpoint path
  are still shown.
- Classification now covers every signal: the resource (including keys
  from `OTEL_RESOURCE_ATTRIBUTES`, shadowed with empty values when
  dropped), metric data point and exemplar filtered attributes on streams
  of the SDK's own instruments, span PII (span, event, and link
  attributes, at export and in injected span processors' `OnEnd`), and
  records from any log bridge on the SDK's LoggerProvider, including the
  global provider after `Setup`. Previously only the slog pipeline and
  span secrets were covered. Not covered: values under unclassified keys,
  log bodies and other free text (span names, span status descriptions,
  span event names), instrumentation scope attributes, metrics from metric
  producers (`OTEL_METRICS_PRODUCERS`, or readers built with
  `sdkmetric.WithProducer` such as the Prometheus bridge, which bypass
  views), members of `attribute.MAP`-valued span and metric attributes,
  injected span processors' `OnStart`, and baggage.
- PII hashing is keyed (HMAC-SHA256), because an unkeyed hash of a
  low-entropy value such as an IPv4 address is reversible by enumeration.
- Cleared every third-party module advisory reported by `govulncheck`:
  GO-2026-6505 (`otel/sdk` and OTLP trace exporters), GO-2026-6508
  (`otlploggrpc`), GO-2026-6615 (`otel/sdk/log`), GO-2026-6061 and
  GO-2026-6348 (`google.golang.org/grpc`), and GO-2026-6603, GO-2026-6610,
  GO-2026-6611, GO-2026-6612, and GO-2026-6617 (`golang.org/x/net`).
- Remaining findings are in the Go standard library and are fixed by the
  toolchain, not by this module: build with go1.26.9 or later on the 1.26
  line, or go1.27.2 or later on the 1.27 line. Affected packages:
  `net/http` (GO-2026-5026, GO-2026-6089, GO-2026-6603, GO-2026-6605,
  GO-2026-6610, GO-2026-6611, GO-2026-6612, GO-2026-6613, GO-2026-6617),
  `net/textproto` (GO-2026-6608), `crypto/tls` (GO-2026-5856,
  GO-2026-6090, GO-2026-6607), `html/template` (GO-2026-6091,
  GO-2026-6599, GO-2026-6600), `net/url` (GO-2026-6218), and
  `encoding/asn1` (GO-2026-5972).
