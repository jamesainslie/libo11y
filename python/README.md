# libo11y (Python)

Opinionated, elegant observability for Python built purely on OpenTelemetry (`opentelemetry-sdk==1.45.*`). Requires CPython 3.12, 3.13, or 3.14.

One PyPI distribution (`libo11y`) ships the core SDK, generated specification tables, sensitivity policy, redaction helpers, detached/process propagation, and ASGI/WSGI/SQLite instrumentation. Optional third-party integrations install as extras.

## Installation

```sh
pip install libo11y                    # core, logging, asgi, wsgi, sqlite3 dbapi, detached, proc, redact, spec
pip install "libo11y[httpx]"           # sync and async httpx transports
pip install "libo11y[requests]"        # requests.HTTPAdapter (no global patching)
pip install "libo11y[grpc]"            # grpcio sync/aio interceptors + OTLP/gRPC exporter
pip install "libo11y[connect]"         # connectrpc async/sync interceptors
pip install "libo11y[psycopg]"         # psycopg 3 + psycopg_pool metrics
pip install "libo11y[test]"            # pytest plugin (o11y_recorder fixture) + in-process OTLP receivers
```

With `uv`:

```sh
uv add libo11y
```

## Quick start

```python
import logging
from opentelemetry import trace
import libo11y
from libo11y.spec import Environment

with libo11y.setup(
    service_name="checkout",
    version="1.2.0",
    environment=Environment.PRODUCTION,
) as tel:
    tracer = trace.get_tracer("checkout")
    logger = logging.getLogger("checkout")
    with tracer.start_as_current_span("startup"):
        logger.info("ready", extra={"checkout.items": 3})  # correlated with the span
```

`setup()` installs the tracer, meter, and logger providers globally, wires a structured `logging.Handler` on the root logger (JSON console + OTLP log export), installs the W3C TraceContext + Baggage propagator wrapped in the baggage egress filter, and runs the startup canary (`o11y.telemetry.configured`). Leaving the `with` block runs bounded concurrent shutdown across all three signals.

For explicit non-global SDKs (tests, multi-tenant processes, embedded libraries), use `libo11y.init(...)` instead: it installs no globals, runs no canary, and exposes `tel.tracer_provider`, `tel.meter_provider`, `tel.logger_provider`, `tel.propagator`, and `tel.logging_handler()`.

### Graceful shutdown on signals

```python
report = libo11y.shutdown_on_signals(tel, before_shutdown=server.stop)
# Or inside asyncio:
report = await libo11y.ashutdown_on_signals(tel, before_shutdown=server.aclose)
```

### Build info

Python packages carry no embedded VCS revision. Capture git metadata at image build time:

```sh
python -m libo11y.buildinfo buildinfo.json
```

Then pass `build_info="buildinfo.json"` (or `distribution="my-package"` to read `service.version` from `importlib.metadata`) to `setup()` / `init()`.

## Integrations

| Module | Extra | Notes |
|---|---|---|
| `libo11y.asgi` | none | ASGI 3 middleware; route templates for Starlette, FastAPI, Django; `http.server.request.duration` with exemplars; `public_endpoint`, `ignore_paths`, `filter`, `canonical_line`, `server_timing` |
| `libo11y.wsgi` | none | WSGI middleware; route templates for Flask and Django; same feature set |
| `libo11y.httpx` | `httpx` | `SyncTransport` / `AsyncTransport` wrapping inner transports; `http.client.request.duration` with exemplars; strips URL credentials |
| `libo11y.requests` | `requests` | `HTTPAdapter` / `mount(session)`; never patches `requests` globally so OTLP/HTTP export is never instrumented |
| `libo11y.grpc` | `grpc` | Sync and `grpc.aio` server/client interceptors; `rpc.server.duration`, `rpc.client.duration`, `public_endpoint`, `ignore_health_checks` |
| `libo11y.connect` | `connect` | Async and sync `connectrpc` interceptors (`MetadataInterceptor`); canonical log line matching `go/o11yconnect` |
| `libo11y.dbapi` | none / `psycopg` | DB-API 2 connection/cursor wrapper; client spans only under an active parent span; SQL literal sanitization for PostgreSQL, SQLite, MySQL, MariaDB; `db.client.operation.duration` with exemplars; `register_pool_metrics` for `psycopg_pool` |
| `libo11y.detached` | none | `copy_context`, 32 KiB text `Carrier`, `capture`, `start_linked` |
| `libo11y.proc` | none | `TRACEPARENT`/`TRACESTATE` env carriers (never baggage) and framed map inject/extract |
| `libo11y.redact` | none | `Secret[T]`, `Masked[T]`, `@redacted` dataclass decorator (unknown `Annotated` tags fail at class definition time with `TypeError`) |
| `libo11y.testing` | `test` | Hermetic `Recorder`, `o11y_recorder` pytest fixture, `assert_conforms()`, in-process `OTLPHTTPReceiver` and `OTLPGRPCReceiver` |

## Per-signal guarantees

- **Traces:** `SensitivityPolicy` wraps the span exporter to classify span, event, and link attributes before leaving the process. Secret attributes are always dropped; PII is dropped by default, HMAC-SHA256 tokenized under `PIIMode.HASH` (key >= 32 bytes), or kept under `PIIMode.KEEP`.
- **Metrics:** `PolicyMeterProvider` classifies attributes before SDK recording (covering derived Views and exemplars). PII is always dropped on metrics even under `PIIMode.HASH`. Per-instrument cardinality is capped at 2000 series. Trace-based exemplars are enabled by default.
- **Logs:** Standard `logging` records pass through the user `attr_replacer` and then `SensitivityPolicy` on both console and OTLP legs, with nested walk depth limit 16, cycle detection, and 2048-node budget failing closed. Direct OTel `_logs` API records are classified by `PolicyLogRecordProcessor`.
- **Resource:** Classified once at construction against the same policy. Tier-0 identity (`service.name`, `deployment.environment.name`, `service.version`, `service.instance.id`) and `spec.SCHEMA_URL` are stamped on the resource.
- **Runtime metrics:** On by default (`runtime_metrics=False` disables). Reports `cpython.gc.*` and `process.*` (`cpu.time`, `memory.usage`, `thread.count`, `unix.file_descriptor.count`) using only stdlib (`gc`, `resource`, `threading`, `/proc`).

## Documented gaps and caveats

- **Policy scope (shared with Go, TypeScript, and Zig):** Key-based classification does not inspect log message bodies, span names, span status descriptions, span event names, instrumentation scope attributes, map-valued members on spans/metrics, attributes read at `on_start`, or baggage. Use `libo11y.redact` (`Secret`, `Masked`, `@redacted`) for capture-time protection of sensitive values under unclassified keys.
- **Shutdown threads past deadline:** Python cannot cancel a blocked OS thread. If a signal exporter misses the `shutdown_timeout` (default 5 seconds), `shutdown()` returns immediately with a timeout error in `ShutdownReport` while the flush continues on a daemon thread (the interpreter exits without waiting for it).
- **Hermetic mode upstream SDK reads:** Passing `env=libo11y.HERMETIC` passes every configurable setting explicitly so ambient `OTEL_*` variables cannot leak into tests. Two reads inside `opentelemetry-sdk==1.45.*` cannot be overridden via arguments:
  1. `LoggerProvider` reads `OTEL_SDK_DISABLED`; a hermetic SDK detects if `OTEL_SDK_DISABLED=true` disabled its logger provider and raises `O11yError` rather than silently dropping logs.
  2. OTLP exporters read `OTEL_PYTHON_SDK_INTERNAL_METRICS_ENABLED`, which only adds SDK self-metrics and changes no application telemetry.
- **Private logs SDK:** `opentelemetry.sdk._logs` is private in OTel Python 1.45.x. All usage is isolated behind `libo11y._internal.logs_bridge` and `opentelemetry-sdk` is pinned to `==1.45.*`.
