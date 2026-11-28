# libo11y Zig

OpenTelemetry observability library for Zig 0.17.1 implementing the libo11y
design contract ([docs/DESIGN.md](../docs/DESIGN.md)) and specification 1.3.0
(semconv v1.41.0).

libo11y Zig owns its telemetry pipeline over vendored `opentelemetry-proto`
bindings (`zig-protobuf`) and `tls.zig`, exporting all three OTLP signals
(traces, metrics with exemplars, and logs) over OTLP/HTTP (`http/protobuf`
or `http/json`) and OTLP/gRPC (h2c or TLS with ALPN `h2`), with unified
sensitivity policy enforcement, capture-time redaction, and a hermetic test
harness.

## Requirements

- Zig `0.17.1`

## Installation

Fetch the package into your `build.zig.zon`:

```sh
zig fetch --save git+https://github.com/jamesainslie/libo11y#zig/v0.1.0
```

Wire the modules you need in `build.zig`:

```zig
const std = @import("std");
const libo11y_build = @import("libo11y");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Default modules (`o11y`, `o11ytest`, `o11yhttp`) fetch none of the
    // optional third-party integration dependencies.
    const libo11y = b.dependency("libo11y", .{
        .target = target,
        .optimize = optimize,
        // Opt in only to the integrations you use:
        // .httpz = true,
        // .pg = true,
        // .sqlite = true,
    });

    const exe = b.addExecutable(.{
        .name = "checkout",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "o11y", .module = libo11y.module("o11y") },
                .{ .name = "o11yhttp", .module = libo11y.module("o11yhttp") },
                // Optional modules (require the matching option above):
                // .{ .name = "o11yhttpz", .module = libo11y.module("o11yhttpz") },
                // .{ .name = "o11ypg", .module = libo11y.module("o11ypg") },
                // .{ .name = "o11ysqlite", .module = libo11y.module("o11ysqlite") },
            },
        }),
    });

    // Optional: embed service.version, vcs.ref.head.revision, o11y.build.time,
    // and o11y.build.modified from git at build time.
    libo11y_build.addBuildInfo(b, exe, .{ .service_version = "1.0.0" });

    b.installArtifact(exe);
}
```

### Exported modules

| Module | Purpose | Extra dependencies |
|---|---|---|
| `o11y` | Core SDK: `setup`/`init`, explicit `Context` and `Env`, tracer, meter with exemplars, structured logger and `std.log` bridge, sensitivity policy, `o11y.spec`, `o11y.redact`, `o11y.detached`, `o11y.proc`, events and `o11y.Record`, process metrics, OTLP/HTTP and OTLP/gRPC exporters, `shutdownOnSignals` | `zig-protobuf`, `tls.zig` |
| `o11ytest` | Hermetic recorder (`o11ytest.start`), conformance and correlation assertions, and in-process `HttpReceiver` and `GrpcReceiver` | none beyond `o11y` |
| `o11yhttp` | `std.http.Server` and `std.http.Client` instrumentation | none beyond `o11y` |
| `o11yhttpz` | `karlseguin/http.zig` middleware | `http.zig` (lazy, enabled with `.httpz = true`) |
| `o11ypg` | `karlseguin/pg.zig` pool and connection wrapper with SQL sanitization and pool metrics | `pg.zig` (lazy, enabled with `.pg = true`) |
| `o11ysqlite` | `vrischmann/zig-sqlite` database and statement wrapper with SQL sanitization | `zig-sqlite` (lazy, enabled with `.sqlite = true`) |

Optional integration dependencies are lazy and gated by build options so a
consumer that imports only `o11y`, `o11ytest`, or `o11yhttp` never downloads
`http.zig`, `pg.zig`, or `zig-sqlite`.

## Quick start

```zig
const std = @import("std");
const o11y = @import("o11y");
const build_info_mod = @import("o11y_build_info");

// Route std.log calls into the libo11y log pipeline.
pub const std_options = o11y.std_options;

pub fn main(init: std.process.Init) !void {
    var diag: o11y.Diagnostic = .{};
    const sdk = o11y.setup(init.gpa, init.io, .{
        .env = .{ .map = init.environ_map },
        .service_name = "checkout",
        .environment = o11y.spec.Environment.production.asStr(),
        .build_info = o11y.buildInfo(build_info_mod),
        .diagnostic = &diag,
    }) catch |err| {
        std.log.err("telemetry disabled ({s}): {s}", .{ @errorName(err), diag.message() });
        return;
    };
    defer sdk.deinit();

    // Start a span and pass the derived Context explicitly.
    var sp = sdk.tracer("checkout").start(.background, "charge-card", .{
        .attributes = &.{
            o11y.kv("http.request.method", "POST"),
        },
    });
    const ctx = o11y.Context.background.withSpan(&sp);

    // Record a metric with automatic trace exemplar attachment.
    const requests = sdk.meter("checkout").counter(i64, "checkout.requests", .{
        .unit = "{request}",
    });
    requests.add(ctx, 1, &.{ o11y.kv("http.request.method", "POST") });

    // Structured logger correlates every record with ctx's active span.
    sdk.logger().info(ctx, "order placed", .{ .order_id = "ord-42" });

    // Optional: correlate std.log inside a synchronous scope (never across await).
    {
        var scope = o11y.bindThread(ctx);
        defer scope.end();
        std.log.info("processing payment", .{});
    }

    sp.end();

    // Bounded, idempotent concurrent shutdown (default 5 s timeout).
    const report = sdk.shutdown(null);
    if (!report.ok()) {
        std.log.warn("telemetry shutdown reported signal errors", .{});
    }
}
```

### Explicit environment and hermetic mode

libo11y never reads ambient process environment variables on its own. Pass
`.env = .{ .map = init.environ_map }` from `main` to honor standard `OTEL_*`
variables, or leave `.env = .hermetic` (the default) so configuration comes
solely from code options and library defaults.

When `service_name` or `deployment.environment.name` is missing or invalid
(and `strict_identity` is `true`), `o11y.setup` and `o11y.init` install
nothing and return a closed `o11y.SetupError` (`NoServiceName`,
`NoEnvironment`, `InvalidEnvironment`, `AlreadySetup`, `PIIHashKey`,
`InvalidAppRegistry`, `CanaryRejected`, `UnsupportedProtocol`, `Exporter`,
`OutOfMemory`). Pass `.diagnostic = &diag` to capture Go's human-readable
error message without heap allocation.

### Testing with `o11ytest`

```zig
const std = @import("std");
const o11y = @import("o11y");
const o11ytest = @import("o11ytest");

test "order flow is correlated and conforms" {
    const rec = try o11ytest.start(std.testing.allocator, std.testing.io, .{});
    defer rec.deinit();

    var sp = rec.tracer("checkout").start(.background, "checkout", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.logger().info(ctx, "order accepted", .{ .order_id = "ord-1" });
    sp.end();

    _ = try rec.expectSpan("checkout");
    _ = try rec.expectLog("order accepted");
    try rec.expectCorrelated();
    try rec.expectConforms();
}
```

`o11ytest` also provides `HttpReceiver` (protobuf, OTLP/JSON, gzip, plain
and TLS/mTLS) and `GrpcReceiver` (h2c and TLS/mTLS with ALPN `h2`) for
end-to-end wire verification.

## Per-signal guarantees

Every signal consults the same sensitivity policy built from `o11y.spec`
and any configured `app_registries`. Secret attributes are always dropped.
PII attributes are dropped by default (`.drop`), replaced with a keyed
HMAC-SHA256 token (`.hash`, requiring a `pii_hash_key` of at least 32 bytes),
or kept (`.keep`). Policy violations increment the `o11y.schema.violations`
self-metric.

- **Resource:** Classified once at SDK construction. Tier-0 identity
  (`service.name`, closed-set `deployment.environment.name`, `service.version`
  falling back to `0.0.0-unknown`) is enforced unless `strict_identity = false`.
  `service.instance.id` is derived deterministically from Kubernetes pod
  identity when present or generated as UUIDv4 otherwise. Every resource
  carries `o11y.spec.schema_url`.
- **Traces:** `Span` is a small value handle; `end()` is idempotent and
  runs the policy over span, event, and link attributes before handing the
  redacted span to processors' `onEnd` callbacks. Batch span queues drop new
  spans when full and count drops.
- **Metrics:** Attributes are classified at record time and on observable
  callback results, covering every derived view stream and every exemplar.
  PII is always dropped on metrics and exemplars even in `.hash` mode,
  because per-value tokens multiply series cardinality. Exemplars use
  trace-based filtering by default (`.trace_based`, `.always_on`,
  `.always_off`) and attach the active span's trace and span IDs from the
  explicit `o11y.Context`. Instruments cap cardinality at 2000 series and
  route excess measurements to an overflow series marked
  `otel.metric.overflow=true`. Default runtime metrics collect semantic
  convention process metrics (`process.cpu.time`, `process.memory.usage`,
  `process.memory.virtual`, `process.thread.count`,
  `process.unix.file_descriptor.count`) on Linux and macOS; set
  `.runtime_metrics = false` to disable.
- **Logs:** The structured logger fans out to the console leg (JSON or text)
  and the OTLP log leg, plus any `extra_log_sinks`. The user `attr_replacer`
  runs before the sensitivity policy so renamed keys cannot bypass
  classification. Nested maps and lists are walked on dotted keys and fail
  closed past depth 16, on a cycle, or past a 2048-node budget.
  `o11y.forceEmit(ctx)` bypasses level gates for audit records and registered
  events. Batch log queues drop the oldest record when full.
- **Capture-time redaction:** `o11y.redact.Secret(T)` renders `"REDACTED"`,
  `o11y.redact.Masked(T)` renders a same-length run of `'X'`, and
  `o11y.redact.Struct(T)` applies comptime field tags (`mask`, `confidential`,
  `redact`, `secret`, `omit`; unknown tags are a compile error) consistently
  across `std.fmt`, `std.json`, and the logger.

## Documented gaps and caveats

- **Policy coverage gaps (matching Go):** Key-based classification does not
  inspect free text (log bodies, span names, span status descriptions, span
  event names), instrumentation scope attributes, members of map-valued span
  or metric attributes, attributes read by a span processor at `onStart`, or
  baggage. Use `o11y.redact` for sensitive values under unclassified keys and
  `baggage_egress_allow` to restrict outbound baggage keys.
- **`o11y.bindThread` and evented `std.Io`:** `o11y.bindThread(ctx)` stores
  the span context in thread-local storage so `std.log` calls inside the
  scope carry trace identity. Under an evented `std.Io` where fibers can
  suspend and resume across OS threads, never hold a `ThreadScope` across an
  await or suspension point; prefer `sdk.logger()` with explicit `ctx`
  instead.
- **`OTEL_PROPAGATORS`:** Not read from the environment in `zig/v0.1.0`;
  configure custom propagators through `Options.propagators`.
- **No gRPC server/client instrumentation:** OTLP/gRPC export is built in,
  but there is no gRPC server or client middleware module because Zig has no
  mature gRPC framework.
- **Application registry YAML parser deviations from Go's `yaml.v3`:** The
  strict YAML parser matches Go's `gopkg.in/yaml.v3` across all conformance
  cases with three documented differences:
  1. A byte order mark inside the input is treated as content rather than
     sometimes skipped at a line start after a 512-byte chunk boundary.
  2. Any disallowed character is reported as a syntax error wherever it
     appears, even if it lies past a point where `yaml.v3`'s chunked reader
     would report another error first.
  3. Merges and aliases nested deeper than roughly 120 levels fail with a
     syntax error to avoid overflowing a bounded stack.

## Development and testing

Run from the repository root:

```sh
make zig-check               # zig fmt --check, Debug + ReleaseSafe tests, hygiene gate
make zig-integrations-check  # enables -Dhttpz=true -Dpg=true -Dsqlite=true (Debug + ReleaseSafe)
make zig-release-check       # consumer tarball smoke test against in-process OTLP receiver
```

Set `O11YPG_TEST_DSN` (for example
`postgres://postgres:postgres@127.0.0.1:5432/libo11y_test`) to run live
PostgreSQL tests in `o11ypg` during `make zig-integrations-check`.

The conformance suite reads the repository's `conformance/` directory by
default; point it elsewhere with `zig build test -Dconformance-dir=<path>`.
