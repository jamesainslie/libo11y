# libo11y for C11

Opinionated, elegant observability for C11 applications built on OpenTelemetry,
implementing the libo11y design contract ([docs/DESIGN.md](../docs/DESIGN.md))
and specification 1.2.0 (semconv v1.41.0).

`libo11y` C exposes a pure ISO C11 public ABI (`o11y/o11y.h`, `o11y/spec.h`,
`o11y/test.h`, C++ `extern "C"` safe) backed by libo11y's Zig telemetry engine.
It exports all three OTLP signals (traces, metrics with exemplars, and logs)
over OTLP/HTTP (`http/protobuf`, `http/json`, gzip) and OTLP/gRPC (HTTP/2 h2c
and TLS with ALPN `h2`, custom CA, and mutual TLS) with **zero external runtime
dependencies** beyond libc and pthreads.

## Requirements

- **Consuming prebuilt artifacts**: any C11 compiler (`gcc`, `clang`) and POSIX libc (`-lpthread -lm` on Linux).
- **Building from source**: Zig `0.17.1` (cross-compiles `.a` and `.so`/`.dylib` for any target).

## Building & Installing

```sh
cd c
zig build -Doptimize=ReleaseSafe
```

This installs the C11 artifacts under `c/zig-out/`:

| Artifact | Purpose |
|---|---|
| `lib/libo11y.a` / `lib/libo11y.so` | Production C11 SDK library (`o11y_*` ABI) |
| `lib/libo11ytest.a` | Self-contained hermetic test harness + in-process OTLP HTTP/gRPC receivers (`o11y_*` + `o11y_test_*`) |
| `bin/libo11y` | Application attribute registry validator CLI (`libo11y registry check FILE...`) |
| `include/o11y/spec.h` | Spec-generated C11 constants (attribute keys, closed enums, events, metrics, schema URL) |
| `include/o11y/o11y.h` | Core C11 SDK header |
| `include/o11y/test.h` | Hermetic test harness & OTLP wire receiver header |
| `lib/pkgconfig/libo11y.pc` | `pkg-config` metadata |
| `lib/cmake/libo11y/libo11yConfig.cmake` | CMake `find_package(libo11y)` config (`libo11y::o11y`, `libo11y::o11ytest`) |

Link from `gcc` or `clang`:

```sh
cc -std=c11 app.c -I/path/to/prefix/include /path/to/prefix/lib/libo11y.a -lpthread -lm -o app
```

Or with CMake:

```cmake
find_package(libo11y REQUIRED)
target_link_libraries(my_app PRIVATE libo11y::o11y)
```

## Quick start

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

    o11y_tracer_t *tracer = o11y_tracer(sdk, "checkout");
    o11y_span_t *span = o11y_tracer_start(tracer, NULL, "POST /checkout", NULL);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, span);

    /* Correlated structured log carrying the active trace_id and span_id. */
    o11y_log_attr_t attrs[] = {
        o11y_log_kv_str("order.id", "ord-42"),
        o11y_log_kv_secret("payment.card_cvv"),
    };
    o11y_log_info(sdk, ctx, "order accepted", attrs, 2);

    /* Metric with automatic trace-based exemplar attachment. */
    o11y_counter_i64_t reqs = o11y_meter_counter_i64(o11y_meter(sdk, "checkout"), "checkout.requests", NULL);
    o11y_counter_i64_add(reqs, ctx, 1, NULL, 0);

    o11y_ctx_destroy(ctx);
    o11y_span_end(span);

    o11y_shutdown_report_t report = {0};
    (void)o11y_shutdown(sdk, 5000, &report);
    o11y_destroy(sdk);
    return 0;
}
```

See [`examples/quickstart.c`](examples/quickstart.c) for a complete runnable program.

## Testing with `libo11ytest`

Link tests against `libo11ytest.a` and include `"o11y/test.h"`:

- `o11y_test_start` creates a hermetic recorder (`O11Y_ENV_HERMETIC`, no global mutations, parallel-safe).
- Inspect captured spans, logs, console JSON, OTLP logs, metrics, exemplars, and `o11y.schema.violations`.
- Assert the contract directly with `o11y_test_check_conforms`, `o11y_test_check_correlated`, and `o11y_test_check_triangle`.
- Run wire-level OTLP tests against `o11y_test_http_receiver_t` and `o11y_test_grpc_receiver_t` (including TLS/mTLS with built-in loopback test certs).

## Validating application attribute registries

```sh
./zig-out/bin/libo11y registry check o11y-registry.yaml
```

Exit codes match Go and TypeScript: `0` valid, `1` policy violation, `2` usage/read/parse error.

## Running the test suite

```sh
make c-check
```

This checks formatting and hygiene on the ABI sources, builds and executes all
C11 unit, conformance (shared `conformance/vectors/` and `conformance/appregistry/`),
OTLP/HTTP + OTLP/gRPC wire, CLI, and standalone `cc` static-link tests in both
`Debug` and `ReleaseSafe`.
