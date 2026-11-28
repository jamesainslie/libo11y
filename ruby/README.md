# libo11y (Ruby)

Opinionated, elegant observability for Ruby built purely on OpenTelemetry (`opentelemetry-sdk`, `opentelemetry-metrics-sdk`, `opentelemetry-logs-sdk`). Requires Ruby 3.3 or later.

## Installation

Add to your `Gemfile`:

```ruby
gem "libo11y"
```

## Quick start

```ruby
require "libo11y"

Libo11y.setup(
  service_name: "checkout",
  version: "1.2.0",
  environment: Libo11y::Spec::Environment::PRODUCTION
) do |tel|
  tracer = OpenTelemetry.tracer_provider.tracer("checkout")
  tracer.in_span("startup") do
    tel.logger.info("ready", { "checkout.items" => 3 }) # correlated with active span
  end
end
```

`Libo11y.setup` installs the global tracer, meter, and logger providers, installs the W3C TraceContext + Baggage propagator wrapped in the baggage egress filter, and runs the startup canary (`o11y.telemetry.configured`). Passing a block guarantees bounded concurrent shutdown across all three signals when the block exits.

`tel.shutdown(timeout: 5)` runs once and returns a `ShutdownReport`. `report.ok?` is false, and `report.errors` names the signal, when a signal fails, misses the deadline, or has its final export rejected by the collector. Each such signal also gets an `o11y.telemetry.dropped` event on the console and the extra sinks. `tel.force_flush` returns `false` on the same failures.

Use `Libo11y.init(...)` for non-global handles in tests and dependency injection.

### Graceful shutdown on signals

```ruby
report = Libo11y.shutdown_on_signals(tel, before_shutdown: -> { server.stop })
```

### Registry CLI

```sh
bundle exec libo11y registry check o11y-registry.yaml
```

## Integrations

| Module | Notes |
|---|---|
| `Libo11y::Rack::Middleware` | Rack 3 middleware (Rails, Sinatra, Hanami); route templates (`set_route`, Sinatra/Rails keys), `http.server.request.duration` with exemplars, `public_endpoint`, `ignore_paths`, `filter`, `server_timing` (HTML responses), `canonical_line` (needs `telemetry:`). A method outside the standard set is recorded as `_OTHER` |
| `Libo11y::HttpClient` | Instrumented `Net::HTTP` client (no global monkey-patching); W3C injection, URL credential stripping, `propagate_fn`, `peer_service`, `http.client.request.duration` with exemplars |
| `Libo11y::DB::Client` | Parent-gated DB client spans named after the operation and table, `db.client.operation.duration` with exemplars, and sanitized `db.query.text` for `postgresql`, `sqlite`, `mysql` and `mariadb` only, capped at 4096 bytes (`query_text: false` turns it off). A failed call sets `error.type` to the SQLSTATE or the error class and never records the driver's message |
| `Libo11y::Detached` | `Carrier` with the URL-encoded text form every libo11y implementation reads (at most 32 KiB, the trace state and then the baggage dropped to fit), egress-filtered baggage, `capture`, `restore_baggage`, and `start_linked`, which starts a linked root span and merges the carrier's baggage into the caller's |
| `Libo11y::Proc` | `TRACEPARENT`/`TRACESTATE` env carriers (never baggage) and framed map `inject_frame`/`extract_frame`. Pass `Libo11y::Proc.child_env` as the environment argument of `Process.spawn`: it adds the current trace and removes a stale one the child would inherit |
| `Libo11y::Redact` | `Secret`, `Masked`, and `Fields` mixin (`mask`, `redact`, `omit`, `confidential`, `secret`) |
| `Libo11y::Testing` | Hermetic `Recorder` (`assert_conforms!`, `assert_correlated!`, `assert_triangle!`) and in-process `OtlpHttpReceiver`. The receiver serves through WEBrick, which the gem does not depend on, so add `gem "webrick"` to your test group to use it |

## Per-signal guarantees and caveats

- **Traces:** `PolicySpanExporter` and `PolicySpanProcessor` classify span, event, and link attributes before leaving the process. An injected span processor receives a redacted view at `on_finish` (`attributes`, `events`, `links`, `to_span_data`) and the live span at `on_start`.
- **Metrics:** `PolicyMeterProvider` classifies the attributes of synchronous measurements and of observable instruments (`add_attributes`, `observe`) before SDK recording (covering derived Views and exemplars). PII is always dropped on metrics even in `PIIMode::HASH`. Trace-based exemplars are on by default.
- **Logs:** `tel.logger` is a `::Logger`. Its `level`, first set by the `log_level` option (`Logger::INFO` by default), gates the console, OTLP and the extra sinks alike. `Libo11y.force_emit { ... }` and `tel.event` pass it. `StructuredLogger` applies capture-time redaction, user `attr_replacer`, and `SensitivityPolicy` once per record, and writes the same classified attributes to console JSON, OTLP logs, and extra sinks. Nested values are walked to a depth of 16 within a budget of 2048 nodes, and what the walk did not examine, a cycle included, is dropped. A record from the OpenTelemetry Logs API is classified by the first processor on the logger provider, before any injected processor sees it.
- **Policy scope (shared across all languages):** Key-based classification does not inspect log message bodies, span names, span status descriptions, instrumentation scope attributes, map-valued span/metric members, attributes read at `on_start`, or baggage. Use `Libo11y::Redact` for values under unclassified keys.
- **Environment:** With `env: Libo11y::HERMETIC` or an explicit `env`, libo11y passes every setting it can to the SDK, so the process environment does not set limits, batch settings or certificate verification. Two variables remain that the upstream metrics SDK reads directly: `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` and `OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION`.
- **Protocol support:** OTLP over `http/protobuf` is supported (gRPC and Prometheus exporters raise `Libo11y::UnsupportedProtocol`).
