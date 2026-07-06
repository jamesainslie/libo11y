# libo11y design contract

This document defines the cross-language contract every libo11y implementation
follows. Language-specific documents describe how each implementation expresses
the contract in native idiom.

## The problem

Every service team writes the same 100-plus lines of OpenTelemetry setup:
resource composition, exporter wiring, propagator installation, log
correlation, shutdown ordering. Most get at least one of these wrong: severed
trace propagation, logs that cannot be joined to traces, shutdown that drops
buffered telemetry, or a library that crashes its host. libo11y packages the
correct answers once per language.

## Signals

All three signals are first-class and OTLP-native:

- **Traces**: W3C Trace Context propagation, parent-based sampling that honors
  inbound sampling decisions, exemplar linkage into metrics.
- **Metrics**: OTEL semantic conventions only (for example
  `http.server.request.duration` in seconds). No Prometheus-style
  `_total`/`_seconds` hand-rolled naming, no registries, no scrape endpoints.
  Runtime metrics on by default.
- **Logs**: the language's standard structured-logging facade is the front
  door (Go: `slog`; Rust: `tracing`; Java: SLF4J; Zig: `std.log` wrapping).
  Records flow to both a console stream and the OTLP pipeline, both carrying
  the active trace and span identifiers.

## One identity, three surfaces

A request's trace identity lives in the active span context and nowhere else.
Logs read it at emission, spans carry it natively, and outgoing requests
inject it as W3C `traceparent`/`tracestate`. Implementations must not maintain
parallel trace-ID state, and propagation helpers must not depend on process
globals: extraction and injection behave identically whether or not global
propagators are installed.

## Lifecycle

- Initialization is explicit (no import-time side effects) and returns an
  owned handle.
- Two construction paths: a non-global constructor for tests and dependency
  injection, and a setup path that additionally installs process globals so
  third-party instrumentation works untouched. Double global setup is a typed
  error, not a crash.
- Initialization fails fast on configuration errors with typed, inspectable
  errors. It never panics, never exits the process, and never blocks on
  collector connectivity (exporters dial lazily).
- Shutdown is idempotent, bounded by caller deadline (with a sane default),
  flushes every signal, and reports per-signal failures in an aggregated,
  inspectable error. A telemetry library must never be the reason its host
  fails; it must also never silently drop buffered telemetry without saying so.

## Configuration

Precedence, strictly: explicit code option, then standard `OTEL_*` environment
variable, then library default.

libo11y honors the standard OpenTelemetry environment surface
(`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_*`,
`OTEL_TRACES_SAMPLER`, `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`, and so on) and
never invents a parallel variable for anything OTEL already specifies.
Language implementations delegate env parsing to their OTEL SDK or contrib
packages rather than reimplementing it.

Service identity: `service.name` must resolve from option or environment;
implementations refuse to start production telemetry as `unknown_service`.
Resources are composed from detectors (host, process, environment) with
explicit attributes taking highest precedence, under a single pinned semantic
convention version per release.

## Redaction

Two complementary layers, both language-idiomatic:

1. **Capture-time**: type-level protection so sensitive values render redacted
   wherever they are logged (Go: `slog.LogValuer`; Rust: derive with
   `Display`-only output; Java: annotation processor or wrapper types).
   Protections: `mask` (same-length X string), `redact` (literal `REDACTED`),
   `omit` (field absent). Strictest wins through nesting.
2. **Emit-time**: an attribute-replacer hook applied to every log record on
   every sink, as a catch-all for third-party attributes.

## Testability

Each implementation ships a hermetic test harness built on the OTEL SDK's
in-memory exporters. The harness never mutates process globals, is safe under
parallel tests, and lets consumers assert emitted spans, metrics, and log
records, including correlation between them, in ordinary unit tests.

## Conformance (future)

Cross-language conformance runs each implementation's example app against a
shared OTLP capture harness and diffs normalized payloads: resource attributes,
metric names against the pinned semconv, trace/log identity equality, histogram
bucket agreement. Golden payloads live under `conformance/` and are regenerated
deliberately when the semconv pin moves.
