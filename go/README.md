# libo11y for Go

One-call OpenTelemetry setup for Go services: traces, metrics, and logs over
OTLP, with W3C context propagation, log/trace correlation, sensitivity
classification on every signal, capture-time redaction, and a hermetic test
harness. Pure OTEL; the library wraps setup, never instrumentation. The
one exception is `o11ysql`, libo11y's own `database/sql` instrumentation,
and [its README](o11ysql/README.md) explains why.

## Installation

```sh
go get github.com/jamesainslie/libo11y/go@v0.2.0
go get github.com/jamesainslie/libo11y/go/o11ygin@v0.2.0       # only for Gin
go get github.com/jamesainslie/libo11y/go/o11yconnect@v0.2.0   # only for Connect
go get github.com/jamesainslie/libo11y/go/o11ysql@v0.2.0       # only for database/sql
```

The Gin, Connect, and database/sql integrations are separate modules
released alongside this one at the same version, so an application
downloads only the integrations it imports. Releases are listed in
[CHANGELOG.md](CHANGELOG.md).

The modules require Go 1.26.0 or later (`golang.org/x/net` v0.60.0, the
first release that fixes its published advisories, declares that floor).
Build with go1.26.9 or later on the 1.26 line, or go1.27.2 or later on the
1.27 line, for the standard-library security fixes; older toolchains still
build the module but `govulncheck` reports the standard-library advisories
listed in the [CHANGELOG](CHANGELOG.md).

## Quick start

```go
package main

import (
    "context"
    "log"
    "log/slog"

    "go.opentelemetry.io/otel"

    o11y "github.com/jamesainslie/libo11y/go"
    "github.com/jamesainslie/libo11y/go/spec"
)

func main() {
    ctx := context.Background()
    sdk, err := o11y.Setup(ctx,
        o11y.WithServiceName("checkout"),
        o11y.WithEnvironment(spec.EnvironmentProduction),
    )
    if err != nil {
        log.Fatal(err)
    }
    defer sdk.Shutdown(context.Background())

    // Vanilla OTEL and log/slog from here on.
    ctx, span := otel.Tracer("checkout").Start(ctx, "startup")
    defer span.End()
    slog.InfoContext(ctx, "ready") // correlated with the span, exported over OTLP

    orders, err := otel.Meter("checkout").Int64Counter("checkout.orders")
    if err != nil {
        slog.ErrorContext(ctx, "creating counter", "error", err)
        return
    }
    orders.Add(ctx, 1)
}
```

[`ExampleNew`](example_test.go) is the same setup as a hermetic, tested
example, and [`examples/httpserver`](examples/httpserver) is a complete
HTTP service with a smoke test.

After `Setup`, your application code uses only the standard interfaces:
`otel.Tracer`, `otel.Meter`, and `log/slog`. libo11y exports no span, metric,
or log wrapper types, so nothing in your codebase depends on it except the
setup call.

## Required environment

`New` and `Setup` refuse to start without a usable service identity:

| Attribute | Set with | Error when missing or invalid |
|---|---|---|
| `service.name` | `WithServiceName`, `OTEL_SERVICE_NAME`, or `service.name` in `OTEL_RESOURCE_ATTRIBUTES` | `ErrNoServiceName` (blank and `unknown_service` count as missing) |
| `deployment.environment.name` | `WithEnvironment`, or `deployment.environment.name` in `OTEL_RESOURCE_ATTRIBUTES` | `ErrNoEnvironment`, or `ErrInvalidEnvironment` for a value outside the allowed set |

The option wins over the variable. Allowed environments are `production`,
`staging`, `development`, and `test`; extend the set with
`WithEnvironmentValues`. `WithoutStrictIdentity` downgrades both checks to
counted violations (`o11y.schema.violations`, signal `resource`) for
migration and tests. `service.version` falls back to `0.0.0-unknown`, with
`o11y.config.service_version_fallback=true` on the startup event, when no
option, variable, or build info supplies it. `service.instance.id` is
derived when absent: a UUIDv5 over the Kubernetes pod identity from the
Downward API attributes, otherwise a random UUIDv4 per process.

## What Setup gives you

- **Providers, wired and installed.** Tracer, meter, and logger providers
  share one resource and are installed as the OTEL globals (with the
  propagator, the OTEL error handler, and the slog default), so
  third-party instrumentation works untouched. `New` builds the same
  pipeline without touching globals, for tests and dependency injection.
- **Standard configuration.** Exporters honor `OTEL_EXPORTER_OTLP_*`,
  `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`, `OTEL_SERVICE_NAME`,
  `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`, and friends.
  `OTEL_PROPAGATORS` selects the propagators by name through
  OpenTelemetry contrib's autoprop package (`tracecontext`, `baggage`,
  `b3`, `b3multi`, `jaeger`, `xray`, `ottrace`, or `none`). Entries are
  trimmed and empty ones dropped; unset or empty keeps W3C Trace Context
  and Baggage, and an unknown name fails `New` and `Setup`. Explicit
  options override the environment; the library defines no environment
  variables of its own. `WithoutOTELEnv` is the one opt-in exception: it
  makes behavior independent of `OTEL_*` variables. Exporters dial lazily
  and never block startup; export failures are non-fatal and rate-limit
  reported, and a failed export during `Shutdown` or `ForceFlush` is
  reported in that call's error.
- **A kill switch from outside.** `OTEL_SDK_DISABLED=true` (in any case)
  is the one variable that beats code options. Nothing is exported on
  any signal, even through exporters, readers, and processors injected
  with options, and runtime metrics do not start. The tracer provider is
  the OpenTelemetry no-op provider, so no span is recorded, but context
  still propagates, the console and extra log sinks keep writing, logs
  stay correlated with an inbound trace, and identity is validated as
  usual, so application code does not change. The startup summary
  reports `traces`, `metrics`, and `logs` as `none`. `MeterProvider()`
  stays a real provider with no readers, so instruments can be created and
  nothing is collected. The SDK still owns what options injected and shuts
  each part down once: an injected metric reader when `New` builds the
  SDK, the rest in `Shutdown`. A value that is neither `true` nor `false`
  is reported once through the error handler. `WithoutOTELEnv` ignores the
  variable.
- **One identity, three surfaces.** Logs read the active span context at
  emission, spans carry it natively, and instrumented clients inject W3C
  `traceparent` on egress. Console log records carry top-level `trace_id`
  and `span_id`; OTLP log records carry native trace context.
- **A real slog pipeline.** `slog` records fan out to a console stream
  (JSON or text), the OTLP log pipeline, and any extra handlers. The
  handler satisfies the full `slog.Handler` contract (verified against
  `testing/slogtest`), including `WithGroup`, and correlation attributes
  never nest inside groups.
- **Sensitivity classification on every signal.** Attributes the
  specification or an application registry (`WithAppRegistry`) classifies
  `secret` are dropped and `pii` attributes are dropped by default, on
  logs, spans, metrics from the SDK's instruments, and the resource. See
  [Sensitivity and redaction](#sensitivity-and-redaction) for the exact
  per-signal guarantees and the gaps.
- **Service identity, enforced.** See [Required environment](#required-environment).
  Host, process runtime, container, and build-info detectors fill in the
  rest: the binary's VCS stamp (`vcs.ref.head.revision`,
  `o11y.build.time`, `o11y.build.modified`) and main module version are
  recorded automatically (`WithoutBuildInfo` to opt out).
- **A verified start.** `Setup` forces one startup event,
  `o11y.telemetry.configured`, through the entire log pipeline before
  installing any global; a sink that rejects it synchronously (the console
  writer, an extra handler) fails Setup instead of dropping records silently
  in production. The OTLP sink batches asynchronously, so this does not
  verify collector connectivity. The event carries the resolved
  configuration as `o11y.config.*` attributes (`traces`, `metrics`, `logs`,
  `console`, `level`, `sampler`, `propagators` (the propagators' fields in
  their configured order, `none` for the none propagator, or `custom` for
  propagators that name no fields), `runtime_metrics`, and,
  when set, `service_version_fallback` and the `endpoint`,
  `traces_endpoint`, `metrics_endpoint`, and `logs_endpoint` values from
  `OTEL_EXPORTER_OTLP_*`). Endpoints are sanitized: userinfo, query, and
  fragment are removed, and a value with an ambiguous `@` is withheld as
  `unparseable`. URL paths are kept, so do not put credentials in an
  endpoint path. The same line is available from `sdk.EffectiveConfig()`,
  and `WithoutStartupSummary` disables the event. Only `Setup` emits it;
  `New` runs no canary.
- **Runtime metrics** (`go.*`) on by default, histogram buckets adjustable
  per instrument with `WithHistogramBuckets`.
- **Signal reconciliation.** Logs and spans join on trace and span ID.
  Metrics join through exemplars, which are on by default (trace-based):
  a measurement inside a sampled span stamps that span's trace and span
  IDs onto the data point, including the middleware's own
  `http.server.request.duration`. Measurements outside a sampled span
  carry no exemplar, so a metric reconciles to a trace only through the
  data points that sampled requests produced. Tune with
  `WithExemplarFilter` or `OTEL_METRICS_EXEMPLAR_FILTER`, and assert the
  triangle in your own tests with `o11ytest.Recorder.Exemplars`.
- **Owned lifecycle.** `Shutdown` flushes and stops logs, metrics, and
  traces concurrently under one deadline (5s when the context has none), so
  a hung exporter on one signal cannot starve the others, and reports
  per-signal failures via `errors.Join`. It is idempotent: the first call
  runs the shutdown and every later call returns its result; a concurrent
  caller stops waiting when its own context ends. A signal that fails to
  flush emits an `o11y.telemetry.dropped` event to the surviving sinks
  (console and extra handlers). The library never panics and never calls
  `os.Exit`.

## Options

| Option | Effect |
|---|---|
| `WithServiceName`, `WithServiceVersion`, `WithServiceNamespace` | `service.name`, `service.version`, `service.namespace` |
| `WithEnvironment`, `WithEnvironmentValues` | `deployment.environment.name` and extra allowed values |
| `WithoutStrictIdentity` | missing or invalid identity becomes a counted violation instead of an error |
| `WithResourceAttributes` | extra resource attributes, highest precedence (still classified) |
| `WithoutBuildInfo` | disable the build-info detector |
| `WithLogLevel` | minimum level for all sinks (default Info; pass a `slog.LevelVar` to change it at runtime) |
| `WithConsoleWriter`, `WithConsoleFormat`, `WithoutConsoleLog` | console sink destination (default stdout), `ConsoleJSON` or `ConsoleText`, or off |
| `WithExtraLogHandler` | another `slog.Handler` sink; receives flattened, correlated, classified records synchronously |
| `WithoutLogExport` | disable the OTLP log pipeline; `SDK.LoggerProvider` then returns a no-op provider |
| `WithLogExporter` | inject a log exporter instead of building one from the environment; records are still batched. It re-enables log export after `WithoutLogExport`; `WithLogExporter(nil)` disables log export. If a later `WithoutLogExport` disables export, the injected exporter is never used and the SDK never shuts it down |
| `WithAttrReplacer` | user replacer applied to every attribute on every slog sink (console, OTLP slog leg, extra handlers), before classification; not applied to other bridges on `SDK.LoggerProvider` |
| `WithoutSlogDefault` | `Setup` leaves the slog default alone |
| `WithPIIMode` | `PIIDrop` (default), `PIIHash`, or `PIIAllow` |
| `WithPIIHashKey` | HMAC key for `PIIHash`, at least 32 bytes, otherwise `ErrPIIHashKey` |
| `WithTraceSampler` | sampler (default from `OTEL_TRACES_SAMPLER`, else `parentbased_always_on`) |
| `WithTraceExporter` | inject a span exporter; spans are batched and redacted |
| `WithSpanProcessor` | set the span processor (the SDK holds one; a later call replaces an earlier one); `OnEnd` sees redacted spans, `OnStart` the live span. Alone, it owns the export path (no exporter is built from the environment); with `WithTraceExporter`, both run |
| `WithPropagators` | propagators (default from `OTEL_PROPAGATORS`, else the W3C Trace Context and Baggage composite); the baggage egress filter still wraps either |
| `WithMetricReader` | inject a metric reader instead of building one from the environment |
| `WithViews`, `WithHistogramBuckets` | metric views and bucket boundaries; every instrument stream still applies the sensitivity policy |
| `WithExemplarFilter` | exemplar filter (default trace-based) |
| `WithoutRuntimeMetrics` | disable `go.*` runtime metrics |
| `WithoutStartupSummary` | `Setup` emits no startup event |
| `WithErrorHandler` | asynchronous error handler (installed by `Setup` only; it is process-global) |
| `WithoutOTELEnv` | no `OTEL_*` variable affects behavior (see below) |
| `WithAppRegistry` | load an application attribute registry from an `fs.FS`; its keys are classified like spec keys; an invalid registry fails `New` and `Setup` with `ErrInvalidAppRegistry` |

`WithoutOTELEnv` takes configuration only from options and library
defaults. The resource takes no values from `OTEL_RESOURCE_ATTRIBUTES` or
`OTEL_SERVICE_NAME`; sampler, span and log record limits, batching, the
cardinality limit, and the exemplar filter use the SDK defaults; the
propagator ignores `OTEL_PROPAGATORS`; `OTEL_SDK_DISABLED` has no effect; and a
signal with nothing injected is disabled instead of built from the
environment (traces are still sampled for in-process processors, metrics
have no reader, logs are not exported). Two experimental switches have no
overriding option in OpenTelemetry Go v1.47.0 and still apply:
`OTEL_GO_X_PER_SERIES_START_TIMESTAMPS` and
`OTEL_GO_X_DEPRECATED_RUNTIME_METRICS`. The SDK constructors still parse
some variables, and report malformed values to the global OTEL error
handler. Because the OTEL providers always merge the environment resource
underneath the one they are given, every key named in
`OTEL_RESOURCE_ATTRIBUTES` (or set by `OTEL_SERVICE_NAME`) that the library
resource does not itself define is shadowed: it is exported with an empty
value, so a collector processor that inserts only absent keys (the
resource processor's `insert` action) sees it as present. A key the library
resource does define keeps the library's value.

Typed errors: `ErrAlreadySetup`, `ErrNoServiceName`, `ErrNoEnvironment`,
`ErrInvalidEnvironment` (wrapped with the value and the allowed set),
`ErrPIIHashKey`, and `ErrInvalidAppRegistry`. Exporter construction errors
are wrapped.

## Packages

| Package | Purpose |
|---------|---------|
| `o11y` (root) | `Setup`, `New`, the `SDK` handle, options, `SDK.Event`, `Record`, `ForceEmit`, `Capture`, `Carrier`, `StartLinked` |
| `spec` | generated from the specification registry: typed attribute keys, closed enums (`spec.EnvironmentProduction`, ...), event names, metric names (`spec.MetricSchemaViolations`, ...), and `SchemaURL`, `SpecVersion`, `SemconvVersion` |
| `o11yhttp` | net/http server middleware and client transport (otelhttp, stable HTTP semconv, route-aware span names, canonical log line) |
| `o11ygrpc` | gRPC stats handlers for servers and clients (otelgrpc) |
| `o11ygin` | Gin middleware (separate module, so non-Gin users skip its dependencies) |
| `o11yconnect` | Connect server and client interceptors (otelconnect); separate module |
| `o11ysql` | database/sql connector wrapper with semconv db spans, durations, and pool metrics; separate module |
| `o11yproc` | trace context for child processes and framed sockets |
| `o11ytest` | hermetic in-memory harness for asserting emitted telemetry and conformance |
| `redact` | capture-time redaction: `Secret`, `Masked`, tag-driven `Struct` |
| `cmd/libo11y` | `libo11y registry check`, which validates an application attribute registry |

The `SDK` handle exposes `TracerProvider`, `MeterProvider`,
`LoggerProvider` (for log bridges other than slog, such as otelzap or
otellogr; their records are classified like slog records), `Propagator`,
`Resource`, `Handler`, `Logger`, `EffectiveConfig`, `Capture`,
`StartLinked`, `ForceFlush`, `Shutdown`, and `ShutdownOnSignals`.

A nil `*SDK`, which `New` and `Setup` return with an error, and the zero
value are inert handles. Every method is safe to call and exports
nothing: `Shutdown` and `ForceFlush` return nil, the providers are the
OpenTelemetry no-op providers, `Handler` returns a text handler that
writes records at Info and above to standard error and `Logger` a logger
over it, so the host still sees its logs (the handler is safe to wrap and install with
`slog.SetDefault`, which `slog.Default().Handler()` is not), and
`ShutdownOnSignals` still waits for a signal. A host that would rather run
without telemetry than fail can log the error and carry on:

```go
sdk, err := o11y.Setup(ctx, opts...)
if err != nil {
    log.Printf("telemetry disabled: %v", err)
}
defer sdk.Shutdown(context.Background())
```

The instrumentation packages treat `WithSDK(nil)` as no SDK given and
use the process globals.

## HTTP, gRPC, and Connect

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
decision. Unknown request methods are normalized to `_OTHER` (with
`http.request.method_original`), as otelhttp does. A panicking handler marks
the server span Error and keeps propagating. Options: `WithSDK` (bind to an
SDK built with `New`), `WithFilter`, `WithIgnorePaths`,
`WithSpanNameFormatter`, `WithPublicEndpoint` (on internet-facing servers,
link rather than adopt untrusted inbound context), and `WithCanonicalLine`.

```go
server := grpc.NewServer(grpc.StatsHandler(o11ygrpc.ServerHandler(
    o11ygrpc.WithPublicEndpoint(),
    o11ygrpc.WithIgnoreHealthChecks(),
)))
conn, err := grpc.NewClient(target, grpc.WithStatsHandler(o11ygrpc.ClientHandler()))
```

`o11ygrpc` options: `WithSDK`, `WithPublicEndpoint` (server only: each
inbound RPC starts a new trace linked to the caller's span; inbound baggage
is still adopted), and `WithIgnoreHealthChecks` (excludes `grpc.health.v1`
probes from tracing and metrics on the server, the client, or both;
propagation is unaffected).

Gin (module `github.com/jamesainslie/libo11y/go/o11ygin`):

```go
router := gin.New()
router.Use(o11ygin.Middleware("api", o11ygin.WithIgnorePaths("/healthz")), gin.Recovery())
```

Register the middleware before `gin.Recovery()`, so the 500 that Recovery
writes for a panic is recorded on the span and its metrics (`gin.Default()`
installs Recovery first, so build the router with `gin.New()`). `o11ygin`
offers `WithSDK`, `WithFilter`, `WithIgnorePaths`, and
`WithSpanNameFormatter` (which receives the `gin.Context`). otelgin has no
public-endpoint mechanism and no canonical log line, so `WithPublicEndpoint`
and `WithCanonicalLine` have no Gin counterpart.

Connect (module `github.com/jamesainslie/libo11y/go/o11yconnect`):

```go
interceptor, err := o11yconnect.ServerInterceptor(
    o11yconnect.WithIgnoreHealthChecks(),
    o11yconnect.WithCanonicalLine(), o11yconnect.WithSDK(sdk),
)
if err != nil {
    return err
}
path, handler := greetv1connect.NewGreetServiceHandler(svc, connect.WithInterceptors(interceptor))
```

`o11yconnect` wraps `connectrpc.com/otelconnect` and supports connect-go v1.
Server spans adopt the caller's trace context, while otelconnect's own
default is to link it. `WithPublicEndpoint` links it instead. Behind HTTP
instrumentation that has already started a span, such as
`o11yhttp.NewHandler`, the RPC span is a child of that span and the outer
layer decides trust, so declare the endpoint public there too.
`rpc.system.name` follows the wire protocol of each request. It is
`connectrpc` for the Connect protocol and `grpc` for gRPC and gRPC-Web. A
handler that panics leaves its server span with status Error, and the
panic keeps propagating. `WithIgnoreHealthChecks` excludes
`grpc.health.v1` procedures from tracing and metrics, and otelconnect then
propagates no context for them. `ClientInterceptor` instruments clients.

`WithCanonicalLine` makes `ServerInterceptor` emit `o11y.request.summary`
once per RPC, even when the handler panics. It needs `WithSDK`, and
`ServerInterceptor` returns an error without it. The event carries
`http.request.method`, `http.response.status_code`, the outcome and
duration, `rpc.system.name`, `rpc.method`, and `rpc.response.status_code`,
plus what the handler adds to the RPC's `Record`. On a unary RPC in the
Connect protocol, `http.response.status_code` is the status the protocol
maps the error code to, such as 404 for `not_found`. Streaming RPCs, and
RPCs in gRPC and gRPC-Web, which carry errors in the body or trailers,
report 200. A panic reports 500, and a not-modified error reports 304
only on a GET. Behind
`o11yhttp.WithCanonicalLine`, turn the canonical line on in one layer
only, because each layer emits its own summary.

## Events, wide events, and audit records

`SDK.Event` emits a contract-bearing event: a log record carrying
`event.name`, force-emitted so it is exempt from level gating, correlated to
the active span, and classified like any record. It accepts any name; the
names registered in the specification carry a contract. Delivery is best
effort (`Event` has no error return; under `Setup`, a rejecting sink is
caught once, by the startup canary, which `New` does not run). The library sets `event.name` itself and removes any
caller-supplied one, and duplicate attribute keys keep the last value.

```go
sdk.Event(ctx, spec.EventRequestSummary,
    slog.String("http.request.method", "GET"),
    slog.String(string(spec.OutcomeKey), string(spec.OutcomeSuccess)),
)
```

A `Record` accumulates attributes over a request into one wide event (a
canonical log line). `o11yhttp.WithCanonicalLine()` (which requires
`WithSDK`) starts one per request and emits it as `o11y.request.summary`
with method, route, status, duration, and outcome, even if the handler
panics; requests excluded by filters emit none. Handlers enrich it:

```go
o11y.RecordFromContext(r.Context()).Set(slog.String("cart.id", id))
o11y.RecordFromContext(r.Context()).Add("db.queries", 1)
```

`StartRecord`, `Record.Max`, and `Record.EmitEvent` cover other request
shapes. A record emitted through plain slog with an `event.name` attribute
is not an event: it stays subject to the level gate.

Records that must always be emitted regardless of the configured level
(audit trails, security events) use a force-emit context; classification,
redaction, and correlation still apply:

```go
slog.InfoContext(o11y.ForceEmit(ctx), "role changed",
    "actor", actorID, "subject", subjectID, "role", role)
```

For the common daemon shape, `ShutdownOnSignals` blocks until SIGINT or
SIGTERM (or until its context ends), then flushes with the usual bounded
deadline; a second signal terminates immediately:

```go
go server.Run()
return sdk.ShutdownOnSignals(ctx)
```

## Databases

```go
db, err := o11ysql.Open("sqlite", "file:app.db")
```

`o11ysql` (module `github.com/jamesainslie/libo11y/go/o11ysql`) wraps any
`database/sql` driver. A statement run under an existing span gets a
client span named like `SELECT users`, with `db.system.name`,
`db.operation.name`, and `db.collection.name` when the statement names one
table. Transactions get `BEGIN`, `COMMIT`, and `ROLLBACK` spans. Statements
outside any span create no span, and pings never create one, so pool
maintenance never starts a trace. The wrapper starts the client span after
the driver call returns and backdates it to the call's start, so spans the
driver makes are children of the caller's span.

`db.query.text` carries the statement with every literal replaced by `?`
and every comment removed. It is cut to at most 4096 bytes on a UTF-8
character boundary, so a bulk insert or a migration cannot produce an
attribute too large to export. It is recorded only for `postgresql`,
`sqlite`, `mysql`, and `mariadb`, which have a matching SQL lexer. Every
other system, including the default `other_sql` and
`microsoft.sql_server`, gets spans and durations named by operation and
collection but no query text. `Open` infers the system from the driver
name: `postgres`, `pgx`, and `pgx/v5` give `postgresql`, `sqlite` and
`sqlite3` give `sqlite`, `mysql` gives `mysql`, and `sqlserver` and
`mssql` give `microsoft.sql_server`. `WithSystem` overrides the inference,
and `WithoutQueryText` turns the text off.

Every statement is measured on `db.client.operation.duration`, with an
exemplar pointing at its span when it has one. The duration covers the
driver call, not the iteration of returned rows. Its `db.collection.name`
label has one value per table, so an application that builds table names
at run time, such as one table per tenant, gets unbounded metric series.
Errors set the span status and `error.type` without recording the
message, because database errors often quote statement values.

`Open` registers `db.client.connection.count` (by state, `idle` or `used`)
and `db.client.connection.max` from `sql.DB.Stats`, and unregisters them
when the `*sql.DB` is closed. `db.client.connection.max` is left out while
the pool has no limit (`SetMaxOpenConns` unset or 0). The pool name
defaults to the system name.
Pools with the same name are summed, so give each pool a distinct
`WithPoolName`. When you build the connector yourself, open the database
with `sql.OpenDB(o11ysql.Wrap(connector))` and register the pool metrics
with `RegisterPoolMetrics(db)`. `RegisterPoolMetrics` starts from the
options given to `Wrap`, such as `WithSDK` and `WithSystem`, and applies
its own on top. Call `Unregister` on the registration when the database is
closed. A driver without the Go 1.8 context interfaces for transactions
and prepared statements fails with `ErrLegacyDriver`. A connection without
`driver.ExecerContext` or `driver.QueryerContext` runs each statement
through a prepared statement instead.

`sql.Conn.Raw` passes its function the `o11ysql` connection, not the
driver's own. Driver-specific methods, such as pgx's `CopyFrom` or a
SQLite backup, are not reachable through a wrapped database.
[`o11ysql/README.md`](o11ysql/README.md) explains why `o11ysql` is
libo11y's own code rather than a wrapper around `XSAM/otelsql`.

## Detached work and child processes

Work that outlives the request, such as a job or a queued email, stores a
`Carrier` with it and starts its own trace linked to the request:

```go
job.Trace = o11y.Capture(ctx) // a column, a JSON field, or a message header

// later, in the worker:
ctx, span := o11y.StartLinked(ctx, job.Trace, "send-email")
defer span.End()
```

A `Carrier` holds the W3C traceparent, the tracestate, and the baggage the
propagator would send out of the process. After `Setup` that baggage has
passed the SDK's egress filter. The text includes those baggage values,
so storing or logging a `Carrier` stores or logs them. It stores as text
(`MarshalText`) or as a SQL text column (`Value`, `Scan`), and the zero
`Carrier` stores as `NULL`. The text never exceeds 32 KiB. A captured
context that would exceed it drops its tracestate, then its baggage, and
always keeps the link. `UnmarshalText` keeps the valid baggage members and
drops the invalid ones. Text over 32 KiB, or without a valid traceparent,
fails with `ErrInvalidCarrier`.

`StartLinked` starts a new root span with one link to the captured span. It
merges the carrier's baggage onto the baggage already in the context, and
the carrier's value wins on a shared key. A zero `Carrier` starts an
unlinked root span. With an SDK built by `New`, use `sdk.Capture` and
`sdk.StartLinked`.

```go
cmd := exec.CommandContext(ctx, "worker")
cmd.Env = append(os.Environ(), o11yproc.Env(ctx)...)
```

Inside a valid span, `o11yproc.Env(ctx)` always returns both `TRACEPARENT`
and `TRACESTATE`, with `TRACESTATE` empty when the context has none.
Appended after `os.Environ()`, the two entries override the values this
process inherited. Outside any span `Env` returns nil, and the child
inherits this process's environment. In the child,
`o11yproc.FromEnv(ctx)` adopts the parent's span context. Baggage does not
travel through the environment, because other tools on the host can read
it. `o11yproc.Inject` and `o11yproc.Extract` carry trace context and
baggage in the `map[string]string` of a framed socket message. By default
they use the global propagator and do nothing before `Setup`. With an SDK
built by `New`, pass `o11yproc.WithSDK(sdk)` to either one so it uses that
SDK's propagator and its baggage egress filter.

## Sensitivity and redaction

### Specification classification (emit-time, automatic)

Every attribute the specification defines carries a sensitivity class
(`public`, `internal`, `pii`, or `secret`; see
[`docs/taxonomy`](../docs/taxonomy)). Today the `pii` keys are `host.ip`,
`host.mac`, `process.command_line`, `process.command_args`, and
`device.id`, and the `secret` keys are the credential headers
`http.request.header.authorization`,
`http.request.header.proxy-authorization`, `http.request.header.cookie`,
and `http.response.header.set-cookie`. One policy per SDK applies the
classification on every signal:

| Surface | Secret | PII under `PIIDrop` (default) | PII under `PIIHash` | PII under `PIIAllow` |
|---|---|---|---|---|
| slog console and extra sinks | dropped | dropped | HMAC token | kept |
| OTLP logs, slog and any bridge on the SDK's LoggerProvider | dropped | dropped | HMAC token | kept |
| span attributes, span events, span links (exporters and injected processors' `OnEnd`) | dropped | dropped | HMAC token | kept |
| resource (all signals) | dropped | dropped | HMAC token | kept |
| metric data point attributes and exemplar filtered attributes, on streams from the SDK's own instruments | dropped | dropped | dropped (hashing would multiply cardinality) | kept |
| metrics from metric producers (`OTEL_METRICS_PRODUCERS`, or a reader built with `sdkmetric.WithProducer`, such as the Prometheus bridge) | not classified | not classified | not classified | not classified |
| baggage | not classified | not classified | not classified | not classified |

- Classification is by key. On logs a grouped attribute is judged on its
  dotted key (`slog.Group("host", slog.String("ip", v))` is `host.ip`), and
  Go maps, slices of maps, and pointers logged as one value are walked on
  every sink and bridge so their members are judged the same way. The walk
  fails closed: it stops at the first reference back into the current path
  (a cycle), past 16 levels, or after 2048 nodes, and drops what remains
  instead of forwarding it unexamined.
- `PIIHash` replaces a value with `hmac-sha256:` followed by 32 hex
  digits: HMAC-SHA256 keyed by `WithPIIHashKey`, truncated to 128 bits,
  over one canonical rendering shared by every signal, so a value
  tokenizes identically on a log, a span, and the resource. Keep the key
  stable; rotating it breaks joins. A composite value too large or deep to
  render in full hashes its truncated rendering. The slog path and the
  bridge path truncate maps, slices, and scalar slices at the same point,
  so they agree on those. A Go value with levels a bridge flattens away,
  such as pointers, can truncate at a different point and get a different
  token.
- `WithAttrReplacer` runs on every slog sink before classification, so
  renaming a key to a classified name cannot bypass the policy (renaming a
  classified key to an unclassified one is the replacer's own decision).
  Other bridges on `SDK.LoggerProvider` are classified but never see the
  replacer.
- Every drop or rewrite on logs, spans, and the resource is counted on the
  `o11y.schema.violations` metric (attributes `o11y.signal` and
  `o11y.rule`, `secret_attribute` or `pii_attribute`). Metric-side drops are
  not counted; the filter runs on the measurement hot path.
- A PII or secret key from `OTEL_RESOURCE_ATTRIBUTES` that the policy
  drops is exported with an empty value, the only way to win the merge the
  OTEL providers perform with the environment resource.

Not covered, by design or by OpenTelemetry Go's structure:

- values logged under unclassified keys (protect those with `redact`);
- log record bodies (messages) and other free text: span names, span
  status descriptions, and span event names;
- instrumentation scope attributes;
- metrics from metric producers (`OTEL_METRICS_PRODUCERS` through
  autoexport, or a reader passed to `WithMetricReader` that was built with
  `sdkmetric.WithProducer`, such as the Prometheus bridge): producer
  metrics bypass the SDK's views, so the policy never sees them;
- members of `attribute.MAP`-valued span and metric attributes (judged on
  their own key only; log records do walk map members);
- attributes an injected span processor reads in `OnStart` (it sees the
  live span);
- baggage: the egress filter wraps every propagator, including one from
  `WithPropagators`, but its predicate allows every key;
- an instrument's experimental advisory attribute keys, which are no longer
  honored because every instrument stream carries the policy's attribute
  filter.

### Application attribute registry

`WithAppRegistry(fsys, path)` loads the application's own attribute
registry, a YAML file in the format of
[`docs/SPEC.md`](../docs/SPEC.md) section 5a, when the SDK is built.
The policy above then classifies its keys like spec keys. A key registered
`pii` is dropped, hashed, or kept according to `WithPIIMode`, and a key
registered `secret` is always dropped. A registry that breaks a rule fails
`New` and `Setup` with `ErrInvalidAppRegistry`, and a file that cannot be
read or parsed fails them with the read or parse error. Give the option
once per registry. Two registries that declare the same namespace are an
error. Only sensitivity applies at runtime, so types, cardinality budgets,
and enum values are left to `libo11y registry check`, which validates the
file in CI.

```go
//go:embed o11y-registry.yaml
var registryFS embed.FS

sdk, err := o11y.Setup(ctx,
    o11y.WithServiceName("checkout"),
    o11y.WithEnvironment(spec.EnvironmentProduction),
    o11y.WithAppRegistry(registryFS, "o11y-registry.yaml"),
)
```

### Capture-time protection (the `redact` package)

```go
type Payment struct {
    Card     string `o11y:"mask"`    // XXXXXXXXXXXXXXXX
    CVV      string `o11y:"redact"`  // REDACTED
    PIN      string `o11y:"omit"`    // absent
    Merchant string                  // passthrough
}
slog.InfoContext(ctx, "charge", "payment", redact.Struct(payment))
fmt.Printf("%v", redact.Struct(payment)) // {Card:XXXX... CVV:REDACTED Merchant:...}

token := redact.NewSecret(rawToken) // REDACTED via slog, fmt, and JSON
card := redact.Masked(cardNumber)   // XXXX... via slog, fmt, and JSON
```

The tags also accept the specification's vocabulary: `o11y:"confidential"`
masks and `o11y:"secret"` redacts. Unknown tag values fail closed to
`redact`, and the strictest protection wins through nesting. A tagged field
carries its protection with the value, which key-based classification
cannot do.

`redact.Struct` renders:

- slices and arrays as groups keyed by index, and maps as groups sorted by
  key text;
- a map under a mask floor, a map whose key type may carry protection, or a
  map with two keys of equal text, by position. A masked
  `map[string]int{"al": 1, "bob": 22}` renders as
  `{"0":{"key":"XX","value":"X"},"1":{"key":"XXX","value":"XX"}}`. Keys are masked, or
  `REDACTED` when the key's type has tagged fields, a `LogValuer`, or
  dynamic components. Positions follow the sorted raw key text, so entry
  order reveals how the keys sort;
- text-marshaling and `fmt.Stringer` values whose type cannot carry
  protection (`time.Time`, `net.IP`, `netip.Addr`) as their text, masked
  under a mask floor; other such types are walked, and a panicking
  `String` or `MarshalText` renders `REDACTED`;
- errors as their `Error()` text (masked under a mask floor) when nothing
  reachable from them may carry protection, otherwise `REDACTED`;
- nil values as nil, and cyclic structures or structures deeper than 32
  levels as `REDACTED`.

The value `redact.Struct` returns guards fmt and JSON as well as slog. Every
fmt verb, `String`, and `GoString` render the protected form as
`{Field:value Field:value}`, with nested structs in nested braces.
`json.Marshal` renders it as an object whose fields are the protected
values, with omitted fields absent and nested structs as nested objects.
All three surfaces render the same protected value, so they agree on what
is masked, redacted, or omitted.

### Emit-time replacer

```go
o11y.WithAttrReplacer(func(groups []string, a slog.Attr) slog.Attr {
    if strings.HasSuffix(a.Key, "_ssn") {
        return slog.String(a.Key, "REDACTED")
    }
    return a
})
```

The replacer is a log-only catch-all applied uniformly to every slog sink
(console, the OTLP slog leg, and extra handlers). Records from other
bridges on `SDK.LoggerProvider` do not pass through it.

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
    exemplars := rec.Exemplars("orders.processed")
    if len(exemplars) == 0 || exemplars[0].TraceID != spans[0].SpanContext().TraceID() {
        t.Error("metric not reconcilable to trace")
    }
    rec.AssertCorrelated(t)
    rec.AssertConforms(t)
}
```

`o11ytest.Start` builds a fully in-memory SDK with `New` and
`WithoutOTELEnv`: no globals, no network, safe under `t.Parallel()`, and no
`OTEL_*` variable affects behavior apart from the two experimental
`OTEL_GO_X_*` switches listed above (runtime metrics are off in the
harness, so only the start-timestamp switch can apply). The resource still
carries host and process detector values, and keys named in
`OTEL_RESOURCE_ATTRIBUTES` that the harness resource does not define appear
with empty values.

- `AssertCorrelated` fails unless every log record emitted inside a span
  carries that span's trace identity.
- `AssertConforms` fails when the code under test put a secret-classified
  attribute on a log record or span (detected through
  `o11y.schema.violations`, since the recorded telemetry is already
  redacted), when a recorded event lacks an attribute its registered
  contract requires, when a secret-classified attribute is visible in
  recorded logs or spans, or when a tier-0 attribute is missing from the
  resource. Grouped log attributes are checked under their dotted keys.
  Secret attributes on metric measurements are dropped uncounted, so they
  are not reported. The in-the-clear check reads only the specification,
  so a key that only an application registry classifies `secret` is
  reported through the violation count alone. Call it from the test body,
  before cleanup shuts the harness down.

## Design notes

- The OpenTelemetry Go log API and SDK are on the stable v1 line
  (v1.47.0). `SDK.LoggerProvider` and `WithLogExporter` expose those types;
  everything else you interact with is `slog.Handler` and the opaque `SDK`.
- `Setup` may be called once per process; a second call returns
  `ErrAlreadySetup` until the first SDK is shut down. `New` has no such
  guard and never mutates globals.
- Semantic conventions are pinned per release (currently v1.41.0), and
  every resource carries the spec schema URL
  `https://schemas.o11y.ing/libo11y/1.1.0` (`spec.SchemaURL`). The
  repository holds one schema file per spec version under `spec/schemas`,
  and `spec/schemas/1.1.0` is the current one.

See the runnable example in [`examples/httpserver`](examples/httpserver).
