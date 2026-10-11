# Changelog

All notable changes to the libo11y Go module are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the module adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Telemetry specification and enforcement: the `spec/` registry
  drives generated `spec` (typed keys, enums, event names, schema/version
  constants, slog+9 severity) and internal validation tables. Runtime
  enforcement: required tier-0 identity at init (`WithEnvironment`,
  `WithServiceNamespace`, `WithoutStrictIdentity`, `ErrNoEnvironment`,
  `ErrInvalidEnvironment`), `service.instance.id` derivation, single
  schema-URL stamping, an unbypassable sensitivity replacer (`WithPIIMode`,
  `o11y.schema.violations` self-metric), the `SDK.Event` API, the `Record`
  wide-event accumulator with `o11yhttp.WithCanonicalLine`, and
  `o11ytest` conformance assertions. Build-info attributes renamed to their
  spec forms (`vcs.ref.head.revision`, `o11y.build.time`,
  `o11y.build.modified`).
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
- First-class exemplar support for 360-degree signal reconciliation:
  `WithExemplarFilter` option (default trace-based, honoring
  OTEL_METRICS_EXEMPLAR_FILTER), `o11ytest.Recorder.Exemplars` accessor,
  and tests pinning that spans, logs, and metric exemplars from one
  operation share one trace identity, including through the HTTP
  middleware's duration histogram.
- Rust-client parity features: `ForceEmit` context marker for always-emit
  audit records; startup summary record doubling as an initialization
  canary (sink failures fail `Setup`) with `SDK.EffectiveConfig` accessor;
  build-info resource detector (module version and `vcs.*` stamp) and
  container detector; `SDK.ShutdownOnSignals` lifecycle helper;
  `o11ygin` Gin middleware as a nested module. Parity matrix in
  `docs/PARITY.md`.

### Changed

- Minimum Go version raised from 1.25.0 to 1.26.0 for both the `go` and
  `go/o11ygin` modules. `golang.org/x/net` v0.60.0, the first release that
  fixes GO-2026-6603, GO-2026-6610, GO-2026-6611, GO-2026-6612, and
  GO-2026-6617, declares `go 1.26.0`, as do the patched OpenTelemetry
  releases. No version of `x/net` that clears those advisories supports
  Go 1.25.
- Dependencies upgraded: OpenTelemetry Go v1.47.0 (`otel/log` and
  `otel/sdk/log` now on the stable v1 line), OTLP log exporters v0.23.0,
  contrib v0.72.0 (`otelslog` bridge v0.21.0), gRPC v1.84.0, and
  `golang.org/x/net` v0.61.0. The global LoggerProvider is now installed
  through `otel.SetLoggerProvider`, which replaces the deprecated
  `otel/log/global` package with identical behavior.

### Security

- Cleared every third-party module advisory reported by `govulncheck`:
  GO-2026-6505 (`otel/sdk` and OTLP trace exporters), GO-2026-6508
  (`otlploggrpc`), GO-2026-6615 (`otel/sdk/log`), GO-2026-6061 and
  GO-2026-6348 (`google.golang.org/grpc`), and GO-2026-6603, GO-2026-6610,
  GO-2026-6611, GO-2026-6612, and GO-2026-6617 (`golang.org/x/net`).
- Remaining findings are in the Go standard library and are fixed by the
  toolchain, not by this module: build with go1.26.9 or later. Affected
  packages: `net/http` (GO-2026-5026, GO-2026-6089, GO-2026-6603,
  GO-2026-6605, GO-2026-6610, GO-2026-6611, GO-2026-6612, GO-2026-6613,
  GO-2026-6617), `net/textproto` (GO-2026-6608), `crypto/tls`
  (GO-2026-5856, GO-2026-6090, GO-2026-6607), `html/template`
  (GO-2026-6091, GO-2026-6599, GO-2026-6600), `net/url` (GO-2026-6218),
  and `encoding/asn1` (GO-2026-5972).
