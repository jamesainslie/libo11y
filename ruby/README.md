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
| `Libo11y::Rack::Middleware` | Rack 3 middleware (Rails, Sinatra, Hanami); route templates (`set_route`, Sinatra/Rails keys), `http.server.request.duration` with exemplars, `public_endpoint`, `ignore_paths`, `filter`, `server_timing`, `canonical_line` |
| `Libo11y::HttpClient` | Instrumented `Net::HTTP` client (no global monkey-patching); W3C injection, URL credential stripping, `propagate_fn`, `peer_service`, `http.client.request.duration` with exemplars |
| `Libo11y::DB::Client` | Parent-gated DB client spans, SQL literal sanitization (`postgresql`, `sqlite`, `mysql`, `mariadb`), `db.client.operation.duration` with exemplars |
| `Libo11y::Detached` | 32 KiB text `Carrier`, egress-filtered baggage, `capture`, `restore_baggage`, `start_linked` |
| `Libo11y::Proc` | `TRACEPARENT`/`TRACESTATE` env carriers (never baggage) and framed map `inject_frame`/`extract_frame` |
| `Libo11y::Redact` | `Secret`, `Masked`, and `Fields` mixin (`mask`, `redact`, `omit`, `confidential`, `secret`) |
| `Libo11y::Testing` | Hermetic `Recorder` (`assert_conforms!`, `assert_correlated!`, `assert_triangle!`) and in-process `OtlpHttpReceiver`. The receiver serves through WEBrick, which the gem does not depend on, so add `gem "webrick"` to your test group to use it |

## Per-signal guarantees and caveats

- **Traces:** `PolicySpanExporter` and `PolicySpanProcessor` classify span, event, and link attributes before leaving the process.
- **Metrics:** `PolicyMeterProvider` classifies synchronous and observable measurement attributes before SDK recording (covering derived Views and exemplars). PII is always dropped on metrics even in `PIIMode::HASH`. Trace-based exemplars are on by default.
- **Logs:** `StructuredLogger` (`::Logger` subclass) applies capture-time redaction, user `attr_replacer`, and `SensitivityPolicy` (depth 16, cycle detection, 2048-node budget) to console JSON, OTLP logs, and extra sinks. Direct OTel Logs API calls are classified by `PolicyLogRecordProcessor`.
- **Policy scope (shared across all languages):** Key-based classification does not inspect log message bodies, span names, span status descriptions, instrumentation scope attributes, map-valued span/metric members, attributes read at `on_start`, or baggage. Use `Libo11y::Redact` for values under unclassified keys.
- **Protocol support:** OTLP over `http/protobuf` is supported (gRPC and Prometheus exporters raise `Libo11y::UnsupportedProtocol`).
