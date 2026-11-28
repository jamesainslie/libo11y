# libo11y

Opinionated, elegant observability libraries built purely on OpenTelemetry.

libo11y gives applications one-call telemetry setup with unified configuration,
W3C context propagation, and log/trace/metric correlation, in the native idiom
of each target language. It wraps OpenTelemetry *setup*, not instrumentation,
with the exceptions that principle 3 lists. After initialization your code
uses the standard OTEL APIs and your language's native logging facade, and
everything is correlated and exported over OTLP.

## Languages

| Language | Status | Location |
|----------|--------|----------|
| Go | Implemented | [`go/`](go/) |
| TypeScript | Implemented for Bun, Node, browsers and Manifest V3 extensions. The browser packages first ship in `ts/v0.2.1` | [`ts/`](ts/) |
| Zig | Implemented for Zig 0.17.1 (`zig/v0.1.0`) | [`zig/`](zig/) |
| Python | Implemented for Python 3.12, 3.13, and 3.14 (`python/v0.1.0`) | [`python/`](python/) |
| C | Implemented for C11 (`c/v0.1.0`, pure C11 ABI backed by `zig/`) | [`c/`](c/) |
| Rust | Implemented for Rust 1.88+ (`rust/v0.1.0`; `libo11y-sqlx` requires 1.94) | [`rust/`](rust/) |
| Java | Planned | [`java/`](java/) |

## Design principles

1. **Pure OTEL.** Traces, metrics, and logs over OTLP. Standard `OTEL_*`
   environment variables are honored, never shadowed by a parallel namespace
   (an explicit, opt-in mode ignores them for hermetic tests). The released
   libraries do not honor every standard variable yet. `OTEL_PROPAGATORS` is
   the main one, so propagators are set in code, and
   [`docs/PARITY.md`](docs/PARITY.md) lists the gaps. Stable
   semantic conventions by default for the instrumentation libo11y wires
   (HTTP spans and metrics, database client spans and
   `db.client.operation.duration`). Not everything emitted is stable: gRPC
   and Connect spans and metrics follow the `rpc.*` conventions (release
   candidate), the database pool metrics (`db.client.connection.*`) and
   the `sqlite` and `other_sql` values of `db.system.name` are
   development, runtime metrics (`go.*`) are not yet stable, resource
   detectors record upstream attributes that are not yet stable
   (`host.*`, `container.id`, `vcs.ref.head.revision`), and the libo11y
   registry's own groups and overlays are marked development.
2. **One identity, three surfaces.** Logs, spans, and outgoing headers all read
   the active span context. No parallel trace-ID state, no desync.
3. **Wrap setup, not instrumentation.** One call builds and wires the
   providers; afterwards users call the vanilla OTEL API and their language's
   standard logging interface. libo11y exports no span or metric wrapper types.
   It writes its own instrumentation only where OpenTelemetry has none to
   wrap. In Go that is the `o11ysql` package, and
   [its README](go/o11ysql/README.md) explains why. In TypeScript it is
   `instrumentServe` and `instrumentFetch`, because upstream's HTTP
   instrumentation does not reach Bun's fetch or fetch-style servers.
   TypeScript also has no standard structured logger, so there the front
   door is the libo11y logger, and `captureConsole` routes `console` calls
   into it.
4. **Owned lifecycle.** Initialization returns a handle with an idempotent,
   bounded `Shutdown` that reports per-signal errors. The library never
   panics, never calls exit, and never blocks startup on collector
   connectivity. [`docs/PARITY.md`](docs/PARITY.md) lists any current release
   that breaks this rule.
5. **Locally testable.** The guarantees a test can observe, which are
   specification conformance, log-to-trace correlation and exemplars, can
   be asserted in a consumer's own test suite with the bundled hermetic
   test harness. One exception: secret attributes on metric measurements
   are dropped without being counted, so the conformance assertion cannot
   report them (inspect the recorded metrics instead). No global state is
   mutated in tests, with one exception in TypeScript. OpenTelemetry JS
   keeps one context manager per process, so when none is registered the
   recorder installs one and removes it when the last recorder shuts down.
6. **Safe in the dark.** With no collector to reach and no `OTEL_*`
   configuration, applications run normally: telemetry degrades instead of
   crashing the host. Setup requires one thing, the service identity, which
   is a service name and a deployment environment. Without it setup returns
   a typed error and installs nothing, and the application decides whether
   to carry on without telemetry.

## The specification

libo11y centralizes a versioned telemetry specification in
[`spec/`](spec/): a tiered resource-attribute taxonomy, structured-logging
rules, per-signal minimums, a registered event catalog, and a sensitivity
classification that drives redaction. It extends OpenTelemetry semantic
conventions (never redefining stable upstream attributes), is validated by
the repository's own policy checks (`make spec-check`: naming, namespace
ownership, sensitivity, cardinality, references, enums, event, and
metric-unit rules, listed by ID in the specification), and is
code-generated into each language: typed attribute keys, closed enums, and
validation tables the runtime and test harness share. See [`docs/SPEC.md`](docs/SPEC.md) for the human-readable
specification and [`docs/taxonomy/`](docs/taxonomy/) for the generated
attribute tables.

The registry generates Go, TypeScript, Rust, Zig, Python, and C outputs:
`go/spec` and `go/internal/spectables`, `@libo11y/spec` in
[`ts/packages/spec`](ts/packages/spec), `rust/libo11y-spec/src/generated`,
`zig/src/spec/generated`, `python/src/libo11y/spec/_generated`, and
[`c/include/o11y/spec.h`](c/include/o11y/spec.h).
Spec 1.1.0 adds the conventions for libo11y RUM, the real-user-monitoring
product, which [`docs/RUM.md`](docs/RUM.md) describes.

## Further reading

See [`docs/DESIGN.md`](docs/DESIGN.md) for the cross-language design
contract, [`docs/SPEC.md`](docs/SPEC.md) for the telemetry specification,
[`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) for naming, versioning, and
configuration conventions, and [`docs/PARITY.md`](docs/PARITY.md) for the
feature-parity matrix across implementations.

## Installation (Go)

```sh
go get github.com/jamesainslie/libo11y/go@v0.4.0
go get github.com/jamesainslie/libo11y/go/o11ygin@v0.4.0       # only for Gin
go get github.com/jamesainslie/libo11y/go/o11yconnect@v0.4.0   # only for Connect
go get github.com/jamesainslie/libo11y/go/o11ysql@v0.4.0       # only for database/sql
```

The Gin, Connect, and database/sql integrations (`go/o11ygin`,
`go/o11yconnect`, `go/o11ysql`) are separate modules released alongside
the main module at the same version. The modules require Go 1.26.0 or
later. Build with the latest patch release of the 1.26 or 1.27 line to
pick up the standard-library security fixes.

The RUM gateway is its own Go module, `go/o11yrum`, with its own version
line. It receives OTLP from browsers, browser extensions and React Native
apps, validates and enriches it, derives the standard RUM metrics, and
forwards it to your collector. Install the command or pull the image:

```sh
go install github.com/jamesainslie/libo11y/go/o11yrum/cmd/o11yrum-gateway@v0.1.0
docker pull ghcr.io/jamesainslie/o11yrum-gateway:0.1.0
```

[`go/o11yrum/README.md`](go/o11yrum/README.md) covers configuration and
deployment.

The latest Go release, `go/v0.4.0`, implements spec 1.3.0 and stamps that
version's schema URL on every resource. The TypeScript packages at
`ts/v0.2.1` implement spec 1.2.0. Spec 1.3.0 support is on `main` and
ships in the next TypeScript release.

## Quick start (Go)

```go
package main

import (
	"context"
	"log"
	"log/slog"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

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
		// Setup installed nothing. The service runs without telemetry.
		log.Printf("telemetry disabled: %v", err)
	} else {
		defer sdk.Shutdown(context.Background())
	}

	// Vanilla OTEL and log/slog from here on.
	ctx, span := otel.Tracer("checkout").Start(ctx, "checkout.place",
		trace.WithAttributes(attribute.String("order.id", "ord-42")),
	)
	defer span.End()

	slog.InfoContext(ctx, "order placed", "order.id", "ord-42") // correlated with the span

	orders, err := otel.Meter("checkout").Int64Counter("checkout.orders",
		metric.WithUnit("{order}"),
	)
	if err == nil {
		orders.Add(ctx, 1, metric.WithAttributes(attribute.String("payment.method", "card")))
	}
}
```

A deployment environment is required. Set it with `WithEnvironment` or
`OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production`; the option
wins over the variable. Allowed values: production, staging, development,
test (extend with `WithEnvironmentValues`).

When the service name or the environment is missing or invalid, `Setup`
returns a typed error and installs nothing. The quick start logs that
error and carries on, because the vanilla OTEL API and `log/slog` still
work without an SDK. A service that would rather not start without
telemetry returns or exits on the error instead.

See [`go/README.md`](go/README.md) for the full Go documentation and
[`go/examples/httpserver`](go/examples/httpserver) for a complete,
tested HTTP service.

## Installation (TypeScript)

```sh
npm install @libo11y/server          # setup, instrumentServe, instrumentFetch
npm install @libo11y/core            # only for forceEmit, wide records and the core types
npm install @libo11y/spec            # only for the spec constants or the libo11y bin on its own
npm install --save-dev @libo11y/test # the hermetic recorder and the OTLP sink
npm install @libo11y/web             # browsers: setup, consent, the offline queue, fetch and XHR spans
npm install @libo11y/webext          # Manifest V3 extensions: the service worker and content scripts
npm install @libo11y/rum             # RUM for browsers and extensions
npm install @libo11y/rum-react       # RUM adapters: React, TanStack Router and Connect
npm install @libo11y/rum-tanstack-router
npm install @libo11y/rum-connect
npm install --save-dev @libo11y/sourcemaps # uploads source maps to the RUM gateway
```

The eleven packages release together at one version, and they are built on
OpenTelemetry JS 3.x. `@libo11y/server` and `@libo11y/test` run on Bun
1.3.13 and Node 24, and so does `@libo11y/sourcemaps`, a build tool.
`@libo11y/web`, `@libo11y/webext` and `@libo11y/rum` run in browsers, and
by default they record nothing until the application grants consent.
`@libo11y/rum`, its adapters and `@libo11y/sourcemaps` are in development and have not
shipped yet.

## Quick start (TypeScript)

```ts
import { metrics, trace } from "@opentelemetry/api";
import { setup } from "@libo11y/server";

const telemetry = await setup({
  serviceName: "checkout",
  environment: "production",
});

try {
  // Vanilla @opentelemetry/api and telemetry.logger from here on.
  const tracer = trace.getTracer("checkout");
  const orders = metrics.getMeter("checkout").createCounter("checkout.orders", {
    unit: "{order}",
  });

  tracer.startActiveSpan("checkout.place", { attributes: { "order.id": "ord-42" } }, (span) => {
    try {
      telemetry.logger.info("order placed", { "order.id": "ord-42" }); // correlated with the span
      orders.add(1, { "payment.method": "card" }); // attaches trace exemplar
    } finally {
      span.end();
    }
  });
} finally {
  await telemetry.shutdown();
}
```

`setup` reads the rest of its configuration from `OTEL_*`, as Go's
`Setup` does, and installs the providers globally, so code that uses the
vanilla `@opentelemetry/api` is exported too. `telemetry.shutdown()` is
the same bounded, idempotent shutdown that `shutdownOnSignals` calls.

`setup` rejects with an `O11yError` when the service name or the
environment is missing, and when a standard variable selects something the
packages do not support, such as the `grpc` protocol. A top-level `await`
then ends the process, so catch the error if the service should start
without telemetry. See
[`ts/README.md`](ts/README.md) for the packages,
[`ts/packages/server`](ts/packages/server) for the server documentation,
and [`ts/packages/web`](ts/packages/web) and
[`ts/packages/webext`](ts/packages/webext) for browsers and extensions.

## Installation (Zig)

```sh
zig fetch --save git+https://github.com/jamesainslie/libo11y#zig/v0.1.0
```

Requires Zig 0.17.1. The package exports `o11y`, `o11ytest`, and `o11yhttp`
by default, plus option-gated integrations `o11yhttpz` (`.httpz = true`),
`o11ypg` (`.pg = true`), and `o11ysqlite` (`.sqlite = true`) whose
third-party libraries are lazy and fetched only when enabled. It implements
spec 1.2.0.

## Quick start (Zig)

```zig
const std = @import("std");
const o11y = @import("o11y");

pub const std_options = o11y.std_options;

pub fn main(init: std.process.Init) !void {
    const sdk = o11y.setup(init.gpa, init.io, .{
        .env = .{ .map = init.environ_map },
        .service_name = "checkout",
        .environment = o11y.spec.Environment.production.asStr(),
    }) catch |err| {
        std.log.err("telemetry disabled: {s}", .{@errorName(err)});
        return;
    };
    defer sdk.deinit();
    defer _ = sdk.shutdown(null);

    var span = sdk.tracer("checkout").start(.background, "checkout.place", .{
        .attributes = &.{o11y.kv("order.id", "ord-42")},
    });
    defer span.end();
    const ctx = o11y.Context.background.withSpan(&span);

    sdk.logger().info(ctx, "order placed", .{ .@"order.id" = "ord-42" }); // correlated with the span

    const orders = sdk.meter("checkout").counter(i64, "checkout.orders", .{ .unit = "{order}" });
    orders.add(ctx, 1, &.{o11y.kv("payment.method", "card")}); // attaches trace exemplar
}
```

libo11y Zig takes `o11y.Context` and `o11y.Env` explicitly (`.hermetic` by
default), owns its OTLP/HTTP and OTLP/gRPC pipeline over vendored
`opentelemetry-proto` bindings, and runs the same sensitivity policy,
exemplars, and conformance suite as Go and TypeScript. See
[`zig/README.md`](zig/README.md) for the full Zig documentation.

## Installation (Python)

```sh
pip install libo11y                    # core, logging, asgi, wsgi, sqlite3 dbapi, detached, proc, redact, spec
pip install "libo11y[httpx]"           # sync and async httpx transports
pip install "libo11y[requests]"        # requests.HTTPAdapter (no global patching)
pip install "libo11y[grpc]"            # grpcio sync/aio interceptors + OTLP/gRPC exporter
pip install "libo11y[connect]"         # connectrpc async/sync interceptors
pip install "libo11y[psycopg]"         # psycopg 3 + psycopg_pool metrics
pip install "libo11y[test]"            # pytest plugin (o11y_recorder fixture) + in-process OTLP receivers
```

Requires Python 3.12 or later (tested on CPython 3.12, 3.13, and 3.14 on Linux
and macOS). One PyPI distribution (`libo11y`) built on OpenTelemetry Python
SDK 1.45 ships the core SDK, generated specification tables, sensitivity
policy, `@redacted` capture-time redaction, detached and child-process
propagation, and ASGI, WSGI, and SQLite DB-API instrumentation, with optional
extras for third-party libraries. It implements spec 1.2.0.

## Quick start (Python)

```python
import logging
from opentelemetry import metrics, trace
import libo11y
from libo11y.spec import Environment

with libo11y.setup(
    service_name="checkout",
    environment=Environment.PRODUCTION,
):
    # Vanilla OTEL and stdlib logging from here on.
    tracer = trace.get_tracer("checkout")
    orders = metrics.get_meter("checkout").create_counter("checkout.orders", unit="{order}")
    logger = logging.getLogger("checkout")

    with tracer.start_as_current_span("checkout.place", attributes={"order.id": "ord-42"}):
        logger.info("order placed", extra={"order.id": "ord-42"})  # correlated with the span
        orders.add(1, {"payment.method": "card"})  # attaches trace exemplar
```

`libo11y.setup` installs the tracer, meter, and logger providers globally,
attaches a structured `logging.Handler` to the root logger (JSON console and
OTLP export), wraps the W3C TraceContext and Baggage propagator in the baggage
egress filter, and runs the startup canary. Leaving the `with` block runs
bounded concurrent shutdown across all three signals. Use `libo11y.init` for
global-free handles in tests and dependency injection. See
[`python/README.md`](python/README.md) for the full Python documentation.

## Installation (C)

```sh
cd c && zig build -Doptimize=ReleaseSafe
cc -std=c11 app.c -Ic/zig-out/include c/zig-out/lib/libo11y.a -lpthread -lm -o app
```

Requires Zig 0.17.1 to build from source, and any C11 compiler (`gcc`, `clang`)
with POSIX libc to link. The build installs `libo11y.a` / `libo11y.so`
(production SDK), `libo11ytest.a` (self-contained hermetic test harness and
in-process OTLP receivers), `bin/libo11y` (`libo11y registry check`), the C11
headers (`o11y/o11y.h`, `o11y/spec.h`, `o11y/test.h`), `pkg-config`
(`libo11y.pc`), and CMake (`libo11yConfig.cmake`). It implements spec 1.2.0.

## Quick start (C)

```c
#include <stdio.h>
#include "o11y/o11y.h"

int main(void) {
    o11y_options_t opts = o11y_options_default();
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_PRODUCTION;

    o11y_sdk_t *sdk = NULL;
    o11y_diagnostic_t diag = {0};
    o11y_err_t err = o11y_setup(&opts, &sdk, &diag);
    if (err != O11Y_OK) {
        fprintf(stderr, "telemetry disabled (%s): %s\n", o11y_err_name(err), diag.message);
        return 0; /* run safely without telemetry */
    }

    o11y_attr_t span_attrs[] = { o11y_kv_str("order.id", "ord-42") };
    o11y_span_start_options_t span_opts = { .attributes = span_attrs, .attributes_len = 1 };
    o11y_span_t *span = o11y_tracer_start(o11y_tracer(sdk, "checkout"), NULL, "checkout.place", &span_opts);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, span);

    o11y_log_attr_t log_attrs[] = { o11y_log_kv_str("order.id", "ord-42") };
    o11y_log_info(sdk, ctx, "order placed", log_attrs, 1); /* correlated with the span */

    o11y_instrument_options_t counter_opts = { .unit = "{order}" };
    o11y_counter_i64_t orders = o11y_meter_counter_i64(o11y_meter(sdk, "checkout"), "checkout.orders", &counter_opts);
    o11y_attr_t metric_attrs[] = { o11y_kv_str("payment.method", "card") };
    o11y_counter_i64_add(orders, ctx, 1, metric_attrs, 1); /* attaches trace exemplar */

    o11y_ctx_destroy(ctx);
    o11y_span_end(span);

    o11y_shutdown_report_t report = {0};
    (void)o11y_shutdown(sdk, 5000, &report);
    o11y_destroy(sdk);
    return 0;
}
```

libo11y C exposes an ISO C11 ABI (`extern "C"` safe for C++) over the Zig
OTLP/HTTP and OTLP/gRPC engine, with zero external runtime dependencies beyond
libc and pthreads. See [`c/README.md`](c/README.md) for the full C
documentation and [`c/examples/quickstart.c`](c/examples/quickstart.c) for a
complete runnable program.

## Installation (Rust)

```sh
cargo add libo11y                        # core SDK, tracing layers, redact, detached, proc
cargo add libo11y-http --features axum   # Tower HTTP server/client layers (+ axum MatchedPath)
cargo add libo11y-reqwest                # reqwest-middleware client instrumentation
cargo add libo11y-tonic                  # tonic gRPC server/client layers
cargo add libo11y-connect                # Connect RPC server/client instrumentation
cargo add libo11y-sqlx                   # sqlx instrumentation (requires Rust 1.94)
cargo add --dev libo11y-test             # hermetic Recorder and in-process OTLP receivers
cargo install libo11y-cli                # `libo11y registry check` binary
```

The eleven crates (`libo11y`, `libo11y-spec`, `libo11y-redact`, `libo11y-macros`,
`libo11y-test`, `libo11y-http`, `libo11y-reqwest`, `libo11y-tonic`,
`libo11y-connect`, `libo11y-sqlx`, and `libo11y-cli`) release in lockstep from
a `rust/vX.Y.Z` tag and implement spec 1.2.0. Workspace MSRV is Rust 1.88
(edition 2024); `libo11y-sqlx` requires Rust 1.94.

## Quick start (Rust)

```rust
use libo11y::opentelemetry::KeyValue;
use libo11y::{Environment, Sdk};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sdk = Sdk::builder()
        .service_name("checkout")
        .environment(Environment::Production)
        .setup()?;

    // Standard tracing and OpenTelemetry APIs from here on.
    let orders = sdk
        .meter("checkout")
        .u64_counter("checkout.orders")
        .with_unit("{order}")
        .build();

    tracing::info_span!("checkout.place", order.id = "ord-42").in_scope(|| {
        tracing::info!(order.id = "ord-42", "order placed"); // correlated with the span
        orders.add(1, &[KeyValue::new("payment.method", "card")]); // attaches trace exemplar
    });

    sdk.shutdown()?;
    Ok(())
}
```

`Builder::setup` installs the OpenTelemetry globals and a swappable `tracing`
subscriber (use `Builder::build` for a global-free handle and
`Sdk::tracing_layer` to compose into your own subscriber). See
[`rust/README.md`](rust/README.md) for the full Rust documentation and
[`rust/examples/httpserver`](rust/examples/httpserver) for a complete, tested
HTTP service.

## Versioning

Each language library versions and releases independently with path-prefixed
tags (for example `go/v0.1.0`). There is no lockstep release across languages;
signal maturity differs per OpenTelemetry implementation. The first Go
release is `go/v0.1.0`, with `go/o11ygin/v0.1.0` tagged on the same commit.
From `go/v0.2.0`, each release also tags `go/o11yconnect/vX.Y.Z` and
`go/o11ysql/vX.Y.Z` on that commit. Each Go release is listed in
[`go/CHANGELOG.md`](go/CHANGELOG.md) and on the GitHub releases page.
`make release-check` validates the tag sequence against a throwaway local
remote before a release. The RUM gateway module releases on its own line
as `go/o11yrum/vX.Y.Z`, listed in
[`go/o11yrum/CHANGELOG.md`](go/o11yrum/CHANGELOG.md), and each release
publishes the `ghcr.io/jamesainslie/o11yrum-gateway` image with attested
build provenance.

The TypeScript packages release in lockstep. One `ts/vX.Y.Z` tag publishes
`@libo11y/spec`, `@libo11y/core`, `@libo11y/server`, `@libo11y/test`,
`@libo11y/web` and `@libo11y/webext` to npm at version X.Y.Z, with
provenance, through npm trusted publishing. The first version on npm is
0.1.1, and `@libo11y/web` and `@libo11y/webext` join at 0.2.1. Each
TypeScript release is listed in [`ts/CHANGELOG.md`](ts/CHANGELOG.md).
Trusted publishing cannot create a package on npm, so a release leaves a
package that is new to npm out of npm. The GitHub Release for the tag
attaches every packed tarball, and its notes give the `npm install` URL
for each package that is not on npm yet. A maintainer publishes the first
version of such a package by hand, and later releases publish it with
the rest.
`make release-check` also packs the packages and installs them into a
throwaway consumer under Node and Bun, and it bundles the browser packages
for the browser.

The Zig package releases from a `zig/vX.Y.Z` tag, starting at `zig/v0.1.0`,
and is distributed through the root `build.zig` and `build.zig.zon` shim so
consumers fetch `git+https://github.com/jamesainslie/libo11y#zig/vX.Y.Z`.
Each Zig release is listed in [`zig/CHANGELOG.md`](zig/CHANGELOG.md) and
published as a GitHub Release titled `libo11y-zig vX.Y.Z`.
`make release-check` (and `make zig-release-check`) validates a consumer
tarball build against an in-process OTLP receiver.

The Python distribution (`libo11y`) releases from a `python/vX.Y.Z` tag,
starting at `python/v0.1.0`, publishing sdist and wheel to PyPI with PEP 740
attestations through PyPI trusted publishing (OIDC). Each Python release is
listed in [`python/CHANGELOG.md`](python/CHANGELOG.md) and published as a
GitHub Release titled `libo11y-python vX.Y.Z`. `make release-check` (and
`make python-release-check`) builds the wheel and sdist, verifies packaged
contents, and runs a consumer smoke test against an in-process OTLP receiver.

The C11 library releases from a `c/vX.Y.Z` tag, starting at `c/v0.1.0`,
and records its changes in [`c/CHANGELOG.md`](c/CHANGELOG.md). Each C release
is published as a GitHub Release titled `libo11y-c vX.Y.Z` with prebuilt
library archives, headers, `pkg-config` and CMake packaging, and the
`libo11y` CLI. `make release-check` (and `make c-release-check`) validates a
clean install prefix and links an external C11 consumer against an in-process
OTLP receiver.

The Rust crates release in lockstep. One `rust/vX.Y.Z` tag publishes all eleven
crates (`libo11y-spec`, `libo11y-macros`, `libo11y-redact`, `libo11y`,
`libo11y-test`, `libo11y-http`, `libo11y-reqwest`, `libo11y-tonic`,
`libo11y-connect`, `libo11y-sqlx`, and `libo11y-cli`) to crates.io in
dependency order through crates.io trusted publishing, runs a live consumer
smoke build against the registry, and creates a GitHub Release titled
`libo11y Rust vX.Y.Z`. Each Rust release is listed in
[`rust/CHANGELOG.md`](rust/CHANGELOG.md). `make release-check` (and
`make rust-release-check`) validates lockstep versions, crates.io metadata,
and package contents before tagging.

## License

Apache-2.0. See [LICENSE](LICENSE).
