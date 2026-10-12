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

## Three-way reconciliation (logs, traces, metrics)

Every implementation must close the correlation triangle across all three
signals:

- **Log to trace**: every log record emitted inside a span carries the
  span's trace and span IDs, on every sink.
- **Trace to wire**: spans propagate identity via W3C context on ingress
  and egress.
- **Metric to trace**: implementations must emit metric **exemplars**. Any
  measurement taken inside a sampled span stamps that span's trace and span
  IDs onto the metric data point, for both library-emitted instruments
  (HTTP/RPC durations) and application instruments. The default filter is
  trace-based (exemplars only from sampled spans); always-on and always-off
  must be selectable in code and via `OTEL_METRICS_EXEMPLAR_FILTER`.

The result is reconciliation across all three signals, with one
qualification. Logs and spans join on trace ID for every record emitted
inside a span. Metrics join only through exemplars, which exist only on
data points that a measurement inside a sampled span produced: from a
latency histogram bucket to a trace that landed in it, from that trace to
its logs, and from a log line to the metrics through the exemplars its
trace stamped. Unsampled traffic, and measurements taken outside any span,
reconcile to no trace. The test harness must expose recorded exemplars so
applications can assert the triangle in their own suites.

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
  flushes every signal concurrently under that one deadline (so a hung
  exporter on one signal cannot starve the others), and reports per-signal
  failures in an aggregated, inspectable error. A telemetry library must never be the reason its host
  fails; it must also never silently drop buffered telemetry without saying so.

## Specification and enforcement

Every implementation is bound by the libo11y telemetry specification (see
[SPEC.md](SPEC.md)): a versioned, machine-readable registry of resource
attributes, structured-logging rules, per-signal minimums, a registered
event catalog, and a sensitivity classification. The registry extends
OpenTelemetry semantic conventions and is code-generated into each language
so that runtime validators and the test harness share one source of truth.

Enforcement is layered: a generated typed API, registry policy checks,
init-time validation of the required identity tier, an always-on
emit-time sensitivity layer (secret attributes dropped, PII dropped by
default, on every signal, with documented gaps; see Redaction below), and
CI conformance. Required identity is enforced at init; the hot path only
ever classifies, observes, and counts.

## Minimum identity

An implementation MUST refuse to start telemetry without a usable
`service.name` and a valid `deployment.environment.name`, and MUST derive
`service.instance.id` when absent. The full tiered taxonomy and the
SDK-versus-collector division of labor are normative in the specification.

## Configuration

Precedence, strictly: explicit code option, then standard `OTEL_*` environment
variable, then library default.

libo11y honors the standard OpenTelemetry environment surface
(`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_*`,
`OTEL_TRACES_SAMPLER`, `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`, and so on) and
never invents a parallel variable for anything OTEL already specifies.
Language implementations delegate env parsing to their OTEL SDK or contrib
packages rather than reimplementing it.

The one exception is explicit and opt-in: a hermetic mode (Go:
`WithoutOTELEnv`, which the test harness uses) in which no `OTEL_*`
variable affects behavior, configuration comes only from code options and
library defaults, and a signal with nothing injected is disabled rather
than built from the environment. In Go, two experimental switches with no
overriding SDK option (`OTEL_GO_X_PER_SERIES_START_TIMESTAMPS` and
`OTEL_GO_X_DEPRECATED_RUNTIME_METRICS`) still apply, and keys named in
`OTEL_RESOURCE_ATTRIBUTES` that the library resource does not define are
exported with empty values because the OTEL providers always merge the
environment resource.

Service identity: `service.name` must resolve from option or environment;
implementations refuse to start production telemetry as `unknown_service`.
Resources are composed from detectors (host, process, environment) with
explicit attributes taking highest precedence, under a single pinned semantic
convention version per release.

## Redaction

Three complementary layers, all language-idiomatic:

1. **Capture-time**: type-level protection so sensitive values render redacted
   wherever they are logged (Go: `slog.LogValuer`; Rust: derive with
   `Display`-only output; Java: annotation processor or wrapper types).
   Protections: `mask` (same-length X string), `redact` (literal `REDACTED`),
   `omit` (field absent). Strictest wins through nesting. The spec's
   vocabulary maps onto them: `confidential` masks and `secret` redacts.
2. **Emit-time replacer**: an attribute-replacer hook applied to every log
   record on every sink of the language's logging facade (Go: every slog
   sink; records from other log bridges do not pass through it), as a
   catch-all for third-party attributes.
3. **Specification classification**: one sensitivity policy per SDK
   decides, by attribute key, what happens to every attribute the
   specification classifies: secrets are always dropped, and PII is
   dropped (the default), replaced by a keyed HMAC token, or kept, per the
   configured mode. Every signal asks the same policy, so the signals
   cannot drift apart. In Go its enforcement points are the classifying
   wrapper on each slog sink; a processor on the SDK's OTLP logger
   provider, covering every other log bridge; wrappers around the span
   exporter and each injected span processor's end-of-span callback (span,
   event, and link attributes); the resource, classified once at
   construction; and the metric views and exemplar reservoirs of every
   stream of the SDK's own instruments, where PII is dropped even in hash
   mode because a token per value would multiply series cardinality.
   Metrics from metric producers bypass views and are not classified. The policy runs after the
   user replacer, so renaming a key to a classified name cannot bypass it.

Key-based classification is not fail-closed: a value under a key the
specification does not classify passes through, and that gap is the
capture-time layer's job. Log bodies and other free text (span names,
span status descriptions, span event names), instrumentation scope
attributes, metrics from metric producers, members of map-valued span and
metric attributes, attributes a span processor reads at span start, and
baggage are outside the policy; each
implementation documents these gaps with its per-signal guarantees (see
[SPEC.md](SPEC.md), section 5). Baggage egress passes through a filter seam
on every propagator whose default allows every key.

## Testability

Each implementation ships a hermetic test harness built on the OTEL SDK's
in-memory exporters. The harness never mutates process globals, runs in the
hermetic mode above so ambient `OTEL_*` configuration does not change its
behavior, is safe under parallel tests,
and lets consumers assert emitted spans, metrics, and log records,
including correlation between them and conformance to the specification,
in ordinary unit tests.

## Conformance (future)

Cross-language conformance runs each implementation's example app against a
shared OTLP capture harness and diffs normalized payloads: resource attributes,
metric names against the pinned semconv, trace/log identity equality, histogram
bucket agreement. Golden payloads live under `conformance/` and are regenerated
deliberately when the semconv pin moves.
