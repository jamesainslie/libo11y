# libo11y for Go

One-call OpenTelemetry setup for Go services: traces, metrics, and logs over
OTLP, with W3C context propagation, log/trace correlation, capture-time
redaction, and a hermetic test harness. Pure OTEL; the library wraps setup,
never instrumentation.

```go
import (
    o11y "github.com/jamesainslie/libo11y/go"
)

func main() {
    sdk, err := o11y.Setup(ctx, o11y.WithServiceName("checkout"))
    if err != nil {
        log.Fatal(err)
    }
    defer sdk.Shutdown(context.Background())

    slog.InfoContext(ctx, "ready")          // correlated, exported over OTLP
    tracer := otel.Tracer("checkout")       // vanilla OTEL from here on
    meter := otel.Meter("checkout")
}
```

After `Setup`, your application code uses only the standard interfaces:
`otel.Tracer`, `otel.Meter`, and `log/slog`. libo11y exports no span, metric,
or log wrapper types, so nothing in your codebase depends on it except the
setup call.

## What Setup gives you

- **Providers, wired and installed.** Tracer, meter, and logger providers
  share one resource and are installed as the OTEL globals, so third-party
  instrumentation works untouched. `New` builds the same pipeline without
  touching globals, for tests and dependency injection.
- **Standard configuration.** Exporters honor `OTEL_EXPORTER_OTLP_*`,
  `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`, `OTEL_SERVICE_NAME`,
  `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`, and friends. Explicit
  options override the environment; the library defines no environment
  variables of its own. Exporters dial lazily and never block startup;
  export failures are non-fatal and rate-limit reported.
- **One identity, three surfaces.** Logs read the active span context at
  emission, spans carry it natively, and instrumented clients inject W3C
  `traceparent` on egress. Console log records carry top-level `trace_id`
  and `span_id`; OTLP log records carry native trace context.
- **A real slog pipeline.** `slog` records fan out to a console stream
  (JSON or text) and the OTLP log pipeline. The handler satisfies the full
  `slog.Handler` contract (verified against `testing/slogtest`), including
  `WithGroup`, and correlation attributes never nest inside groups.
- **Service identity, enforced.** `service.name` must come from an option
  or the environment; Setup refuses to ship `unknown_service`. Host and
  process runtime detectors fill in the rest.
- **Runtime metrics** (`go.*`) on by default, exemplars on by default
  (trace-based), histogram buckets adjustable per instrument with
  `WithHistogramBuckets`.
- **Owned lifecycle.** `Shutdown` is idempotent, bounded (5s default when
  the context has no deadline), flushes logs, metrics, then traces, and
  reports per-signal failures via `errors.Join`. The library never panics
  and never calls `os.Exit`.

## Packages

| Package | Purpose |
|---------|---------|
| `o11y` (root) | `Setup`, `New`, the `SDK` handle, options |
| `o11yhttp` | net/http server middleware and client transport (otelhttp, stable HTTP semconv, route-aware span names) |
| `o11ygrpc` | gRPC stats handlers for servers and clients (otelgrpc) |
| `o11ytest` | hermetic in-memory harness for asserting emitted telemetry |
| `redact` | capture-time redaction: `Secret`, `Masked`, tag-driven `Struct` |

## HTTP and gRPC

```go
mux := http.NewServeMux()
mux.HandleFunc("GET /users/{id}", getUser)

handler := o11yhttp.NewHandler(mux, "api",
    o11yhttp.WithIgnorePaths("/healthz", "/debug/*"),
)
client := &http.Client{Transport: o11yhttp.NewTransport(nil)}
```

Server spans are named from the matched route (`GET /users/{id}`), metrics
follow the stable HTTP semantic conventions
(`http.server.request.duration` in seconds), and inbound `traceparent`
headers are adopted as span parents, honoring the caller's sampling
decision. Add `o11yhttp.WithPublicEndpoint()` on internet-facing servers to
link rather than adopt untrusted context.

```go
server := grpc.NewServer(grpc.StatsHandler(o11ygrpc.ServerHandler()))
conn, err := grpc.NewClient(target, grpc.WithStatsHandler(o11ygrpc.ClientHandler()))
```

## Redaction

Two layers, use either or both:

```go
// Capture-time: the type protects itself wherever it is logged.
type Payment struct {
    Card     string `o11y:"mask"`    // XXXXXXXXXXXXXXXX
    CVV      string `o11y:"redact"`  // REDACTED
    PIN      string `o11y:"omit"`    // absent
    Merchant string                  // passthrough
}
slog.InfoContext(ctx, "charge", "payment", redact.Struct(payment))

token := redact.NewSecret(rawToken) // REDACTED via slog, fmt, and JSON
card := redact.Masked(cardNumber)   // XXXX... via slog, fmt, and JSON

// Emit-time: a catch-all applied to every sink.
o11y.WithAttrReplacer(func(groups []string, a slog.Attr) slog.Attr {
    if strings.HasSuffix(a.Key, "_ssn") {
        return slog.String(a.Key, "REDACTED")
    }
    return a
})
```

Unknown `o11y` tag values fail closed to `redact`. The strictest protection
wins through nesting.

## Testing your telemetry

```go
func TestCheckoutEmitsTelemetry(t *testing.T) {
    rec := o11ytest.Start(t)
    svc := NewCheckout(rec.SDK) // inject providers or the Logger

    svc.Handle(ctx, order)

    spans := rec.Spans()
    logs := rec.Logs()
    if logs[0].SpanContext.TraceID() != spans[0].SpanContext().TraceID() {
        t.Error("log not correlated with span")
    }
    if !slices.Contains(rec.MetricNames(), "orders.processed") {
        t.Error("counter missing")
    }
}
```

The harness builds a fully in-memory SDK with `New`: no globals, no
network, no environment access, safe under `t.Parallel()`.

## Design notes

- The OpenTelemetry Go logs SDK is pre-1.0; libo11y keeps those types out
  of its exported API (you interact with `slog.Handler` and the opaque
  `SDK`), so upstream log-SDK changes cannot break your build through this
  library's surface.
- `Setup` may be called once per process; a second call returns
  `ErrAlreadySetup` until the first SDK is shut down. `New` has no such
  guard and never mutates globals.
- Semantic conventions are pinned per release (currently v1.41.0).

See the runnable example in [`examples/httpserver`](examples/httpserver).
