# libo11y for C11

libo11y for C11 sets up OpenTelemetry traces, metrics and logs for a C
program in one call. It implements the libo11y design contract
([docs/DESIGN.md](../docs/DESIGN.md)) and specification 1.3.0
([docs/SPEC.md](../docs/SPEC.md), semconv v1.41.0).

The public interface is three ISO C11 headers, `o11y/o11y.h`, `o11y/spec.h`
and `o11y/test.h`, which also compile as C++ inside `extern "C"`. The
libraries behind them are built from libo11y's Zig telemetry engine. They
export all three signals over OTLP/HTTP (`http/protobuf` and `http/json`,
with gzip) and OTLP/gRPC (HTTP/2 cleartext, or TLS with ALPN `h2`, a custom
CA and mutual TLS). They depend on libc and pthreads and on nothing else.

## Requirements

- To use a prebuilt release: a C11 compiler (`gcc` or `clang`) and a POSIX
  libc. On Linux, link `-lpthread -lm`.
- To build from source: Zig `0.17.1`.

## Building and installing

```sh
cd c
zig build -Doptimize=ReleaseSafe --prefix /opt/libo11y
```

Without `--prefix` the files go to `c/zig-out/`.

| File | Purpose |
|---|---|
| `lib/libo11y.a` | The static SDK library |
| `lib/libo11y.so.X.Y.Z` (`libo11y.X.Y.Z.dylib` on macOS) | The shared SDK library, with pre-1.0 minor `SONAME`/`install_name` (`0.Y`), major from `1.0` onward, and relative symlinks (`libo11y.so.0.Y`, `libo11y.so`) |
| `lib/libo11ytest.a` | Companion test harness and in-process OTLP receivers exporting only `o11y_test_*`, linked alongside `libo11y` |
| `bin/libo11y` | The application registry validator, `libo11y registry check FILE...` |
| `include/o11y/o11y.h` | The SDK |
| `include/o11y/spec.h` | Generated constants: attribute keys, closed value sets, event and metric names, the schema URL |
| `include/o11y/test.h` | The test harness |
| `lib/pkgconfig/libo11y.pc`, `libo11ytest.pc` | `pkg-config` metadata, relative to where the tree is unpacked |
| `lib/cmake/libo11y/` | `find_package(libo11y)` files with `libo11y::o11y`, `libo11y::o11y_shared`, `libo11y::o11y_static`, `libo11y::o11ytest`, and `libo11y::o11ytest_static` |

Link directly:

```sh
cc -std=c11 app.c -I/opt/libo11y/include /opt/libo11y/lib/libo11y.a -lpthread -lm -o app
```

With `pkg-config`:

```sh
export PKG_CONFIG_PATH=/opt/libo11y/lib/pkgconfig
cc -std=c11 app.c $(pkg-config --cflags --libs libo11y) -Wl,-rpath,/opt/libo11y/lib -o app
```

When linking `/opt/libo11y/lib/libo11y.a` from a static-only prefix (or directly
without `libo11y.so`/`.dylib` alongside it), pass `--static` so `pkg-config`
includes `Libs.private` (`-lpthread -lm`).

With CMake (`libo11y::o11y` prefers shared on Unix, or choose `libo11y::o11y_shared` / `libo11y::o11y_static`):

```cmake
find_package(libo11y 0.2 REQUIRED)
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
        /* sdk is NULL. Every call below accepts it and does nothing. */
        fprintf(stderr, "telemetry disabled (%s): %s\n", o11y_err_name(err), diag.message);
    }

    o11y_attr_t span_attrs[] = { o11y_kv_str("order.id", "ord-42") };
    o11y_span_start_options_t span_opts = { .attributes = span_attrs, .attributes_len = 1 };
    o11y_span_t *span = o11y_tracer_start(o11y_tracer(sdk, "checkout"), NULL, "checkout.place", &span_opts);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, span);

    /* The record carries the span's trace and span IDs. */
    o11y_log_attr_t log_attrs[] = { o11y_log_kv_str("order.id", "ord-42") };
    o11y_log_info(sdk, ctx, "order placed", log_attrs, 1);

    /* The data point carries an exemplar that points at the span. */
    o11y_instrument_options_t counter_opts = { .unit = "{order}" };
    o11y_counter_i64_t orders = o11y_meter_counter_i64(o11y_meter(sdk, "checkout"), "checkout.orders", &counter_opts);
    o11y_attr_t metric_attrs[] = { o11y_kv_str("payment.method", "card") };
    o11y_counter_i64_add(orders, ctx, 1, metric_attrs, 1);

    o11y_span_end(span);
    o11y_ctx_destroy(ctx);

    o11y_shutdown_report_t report = {0};
    if (o11y_shutdown(sdk, 5000, &report) != O11Y_OK && sdk != NULL) {
        fprintf(stderr, "telemetry was not fully flushed: logs=%s metrics=%s traces=%s\n",
            o11y_err_name(report.logs), o11y_err_name(report.metrics), o11y_err_name(report.traces));
    }
    o11y_destroy(sdk);
    return 0;
}
```

[`examples/quickstart.c`](examples/quickstart.c) is a complete program that
the test suite builds and runs.

## Errors, ownership and threads

The comment at the top of `o11y/o11y.h` states the rules in full. In short:

- A function that can fail returns `o11y_err_t` and writes its result
  through an out-parameter. `o11y_setup` and `o11y_init` also fill an
  `o11y_diagnostic_t` with the reason. The functions on the hot path return
  `void` or a handle, never fail the host, and do nothing when given `NULL`.
- The caller owns every handle and releases it with the function its
  declaration names. A `char *` returned through an out-parameter is freed
  with `o11y_string_free`. A `const char *` return value is borrowed.
- A context (`o11y_ctx_t`) is immutable and owns copies of what it carries,
  so it stays valid after its parent context is destroyed and after its span
  ends. `NULL` is the background context.
- libo11y copies what it keeps from its arguments. The exceptions are
  callbacks and their userdata, which must stay valid until `o11y_destroy`
  and must not re-enter `o11y_shutdown`, `o11y_destroy`, or metric/log paths
  listed as non-reentrant in `o11y/o11y.h`.
- Every function may be called from any thread, and an SDK and what it hands
  out may be used from several threads at once. `o11y_span_end` and the
  destroy functions free their handle, so nothing else may use it after.
  Hermetic handles (`o11y_record_create`, `o11y_test_start`, and
  `O11Y_ENV_HERMETIC` SDKs) never alter POSIX signal handlers. Non-hermetic
  handles wait for internal worker threads to finish on last destroy and restore
  only signal handlers installed by libo11y that the host has not changed.
- libo11y never aborts, exits or raises a signal on bad input.

## Configuration

Initialize option structs with `o11y_options_default()` (and
`o11y_test_options_default()` for tests). Both carry `struct_size` as their
first field, so zero-initialized or layout-mismatched structs are rejected
with `O11Y_ERR_INVALID_ARGUMENT` rather than silently disabling checks.
Precedence is the option set in code, then the standard `OTEL_*` variable,
then the library default. `OTEL_SDK_DISABLED=true` is the one variable that
beats options. libo11y defines no environment variables of its own.

`env_mode` chooses where the `OTEL_*` variables come from:

| Mode | Source |
|---|---|
| `O11Y_ENV_PROCESS` (default) | Only `OTEL_*` variables from the process environment (`environ` on Linux/BSD, `_NSGetEnviron()` on macOS), snapshotted once at setup without retaining host env |
| `O11Y_ENV_PAIRS` | `env_pairs`, an array of key and value |
| `O11Y_ENV_ENTRIES` | `env_entries`, an array of `"KEY=VALUE"` strings |
| `O11Y_ENV_HERMETIC` | Nothing. Only options and library defaults apply, and a signal with no exporter configured is off |

The variables honoured are `OTEL_SDK_DISABLED`, `OTEL_PROPAGATORS`,
`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`,
`OTEL_{TRACES,METRICS,LOGS}_EXPORTER`, `OTEL_EXPORTER_OTLP_*` (protocol,
endpoint, headers, timeout, compression, the TLS certificate variables and
metrics temporality, each with its per-signal form), `OTEL_TRACES_SAMPLER`
with `OTEL_TRACES_SAMPLER_ARG`, `OTEL_METRICS_EXEMPLAR_FILTER`, `OTEL_BSP_*`,
`OTEL_BLRP_*` and `OTEL_METRIC_EXPORT_*`. An exporter other than `otlp` or
`none`, such as `prometheus`, fails setup with `O11Y_ERR_EXPORTER`, an
unknown protocol fails with `O11Y_ERR_UNSUPPORTED_PROTOCOL`, and an unknown
propagator in `OTEL_PROPAGATORS` fails with `O11Y_ERR_UNSUPPORTED_PROPAGATOR`.

`o11y_setup` takes a process-wide guard, so a second call fails with
`O11Y_ERR_ALREADY_SETUP` until the first SDK shuts down. It also sends the
`o11y.telemetry.configured` event through the log pipeline, and a sink that
rejects it fails setup with `O11Y_ERR_CANARY_REJECTED`. `o11y_init` does
neither and builds as many independent SDKs as the program asks for.

Setup refuses to start without a `service.name` and a valid
`deployment.environment.name` (`production`, `staging`, `development`,
`test`, or a value listed in `extra_environments`). Setting
`strict_identity = false` counts each unmet requirement on
`o11y.schema.violations` and starts anyway, for migration.

`o11y_shutdown` flushes the three signals concurrently under one deadline
(5000 ms when `timeout_ms` is 0), runs once so later and concurrent callers
receive the same report, and reports one error per signal.
`o11y_force_flush` flushes logs, metrics and traces sequentially under one
shared deadline (5000 ms when `timeout_ms` is 0). Passing `NULL` to either
returns `O11Y_OK` with an all-OK report. `o11y_shutdown_on_signals` waits for
SIGINT or SIGTERM, restores the default handling, runs an optional callback
and shuts down under one shared deadline.

## Propagation

Every function that needs the current span takes a `const o11y_ctx_t *`.
There is no thread-local or global context.

- `o11y_inject` and `o11y_extract` write to and read from an
  `o11y_carrier_t`, a pair of get and set callbacks over HTTP headers or any
  other string pairs. They use the SDK's propagators, never a process global.
- The default propagators are W3C Trace Context and W3C Baggage.
  `OTEL_PROPAGATORS` selects `tracecontext`, `baggage` and `none`, and
  `o11y_options_t.propagators` (when `propagators_len > 0`) overrides it with
  a list of `O11Y_PROPAGATOR_TRACE_CONTEXT`, `O11Y_PROPAGATOR_BAGGAGE` and
  custom propagators made of C callbacks. To add a legacy header format, list
  the two W3C kinds beside the custom one.
- `baggage_egress_allow` filters the baggage keys that inject writes,
  whatever the propagators are. It never alters extraction.
- `o11y_detached_capture`, `o11y_detached_marshal`, `o11y_detached_unmarshal`
  and `o11y_detached_start_linked` carry a trace across a job queue as text
  of at most 32 KiB and start a root span linked to the captured one.
- `o11y_proc_env_entries` and `o11y_proc_extract_env` carry a trace to a
  child process through `TRACEPARENT` and `TRACESTATE`. Baggage never
  travels through the environment.

## Testing with `libo11ytest`

`libo11ytest.a` is a companion archive that exports only `o11y_test_*`, so it
links cleanly with either `libo11y.a` or `libo11y.so`/`.dylib` with no
duplicate symbols. When linking static archives directly, list `libo11ytest.a`
before `libo11y.a` (`-lo11ytest -lo11y`). `libo11y` exports internal `o11y__*` helper symbols reserved for `libo11ytest.a`
to share signal refcounts, check ABI layout, and release observable callbacks on
recorder teardown). Include `"o11y/test.h"`, or use `pkg-config --cflags --libs
libo11ytest` or CMake's `libo11y::o11ytest` (or `libo11y::o11ytest_static` for
static core linking).

- `o11y_test_start` creates a hermetic recorder. It reads no environment
  variable and touches no POSIX signal handlers or network I/O, so recorders
  run in parallel. `o11y_test_sdk` returns its SDK, which the recorder owns.
- The recorder exposes the captured spans, log records, console output,
  metrics, exemplars and `o11y.schema.violations` counts.
- `o11y_test_check_conforms`, `o11y_test_check_correlated` and
  `o11y_test_check_triangle` return a report of problems, which is empty
  when the telemetry meets the specification, when every record inside a
  span carries its IDs, and when a metric's exemplars point at recorded
  spans.
- `o11y_test_http_receiver_t` and `o11y_test_grpc_receiver_t` are in-process
  OTLP receivers for wire tests, with scripted replies and TLS or mutual TLS
  from built-in loopback certificates.

## Per-signal guarantees

One sensitivity policy per SDK classifies attributes by key, from the
tables generated into `o11y/spec.h` and from any application registry in
`o11y_options_t.app_registries`. A secret attribute is always dropped. A PII
attribute is dropped under `O11Y_PII_DROP`, the default. Under
`O11Y_PII_HASH` it is replaced by a keyed HMAC-SHA256 token, which needs a
`pii_hash_key` of at least 32 bytes. Under `O11Y_PII_ALLOW` it is kept. No
environment variable selects `O11Y_PII_ALLOW`. Each drop or rewrite on logs,
spans and the resource is counted on the `o11y.schema.violations` metric.

- Resource. The policy classifies the resource once at setup. The resource
  carries `telemetry.sdk.language = "c"`, the schema URL `O11Y_SCHEMA_URL`,
  and a `service.instance.id` derived from the Kubernetes pod identity in
  `OTEL_RESOURCE_ATTRIBUTES` when it is present, or a random UUIDv4.
- Traces. The policy runs over span, event and link attributes once, when
  the span ends and before export.
- Metrics. The policy classifies each measurement's attributes when it is
  recorded, and the values an observable callback reports. PII is dropped on
  metrics and exemplars even under `O11Y_PII_HASH`, because a token per
  value would multiply series. Exemplars are on by default for measurements
  taken inside a sampled span. Each instrument holds at most 2000 series and
  sends the rest to a series marked `otel.metric.overflow=true`. Runtime
  metrics are the semantic-convention process metrics
  (`process.cpu.time`, `process.memory.usage`, `process.memory.virtual`,
  `process.thread.count`, `process.unix.file_descriptor.count`) on Linux
  and macOS, and `runtime_metrics = false` turns them off.
- Logs. A record goes to the console (JSON or text), to OTLP and to any
  `extra_log_sinks`, each with the trace and span IDs of its context. The
  `attr_replacer_fn` callback runs before the policy (renaming keys or
  deep-copying replacement values through `o11y_attr_replacement_set_key` and
  `o11y_attr_replacement_set_value`), so renaming a key to a classified name
  cannot bypass it. Nested maps and arrays are walked on their dotted keys, and
  what lies past depth 16, on a cycle, or past 2048 nodes fails closed. A
  context from `o11y_ctx_with_force_emit` bypasses the level gate, as
  `o11y_event` does.
- Capture-time redaction. C has no reflection, so the caller redacts a
  value where it is logged. `o11y_log_kv_secret` logs the literal
  `REDACTED`, `o11y_log_kv_masked` logs one `X` for each code point, and
  `o11y_redact_secret` and `o11y_redact_mask` give the same text for other
  uses.

## What the policy does not cover

Classification is by key and is not fail-closed. It does not cover:

- a value under a key that neither the specification nor a loaded
  application registry classifies. Redact it at capture with the functions
  above;
- log record bodies and other free text: span names, span status
  descriptions and span event names;
- instrumentation scope attributes;
- baggage, which crosses process boundaries unclassified. Use
  `baggage_egress_allow` to restrict the keys that leave;
- the value a custom propagator writes to a carrier.

Three gaps of the Go implementation do not arise here. C span and metric
attributes (`o11y_attr_t`) have no map values, while nested log maps and arrays
are walked and bounded. No span processor can be injected, so nothing reads
span attributes before redaction. No metric producer can feed a reader
directly, so every metric passes the policy.

## Validating application attribute registries

```sh
/opt/libo11y/bin/libo11y registry check o11y-registry.yaml
```

The output streams and exit status match Go, TypeScript and Rust: `0` when
every file is valid (or for `-h`, `--help`, `help` on `stdout`), `1` when a
file breaks a policy rule (violations written to `stdout`), and `2` on
`stderr` for a usage error or a file that cannot be read or parsed.

## Versions and compatibility

`O11Y_VERSION` and `O11Y_VERSION_MAJOR`, `_MINOR` and `_PATCH` in
`o11y/o11y.h` give the version of the headers, and `o11y_version()` gives
the version of the linked library. They are equal in a correct install.

Until 1.0, a minor release may change the API and the layout of the option
structs (`struct_size` checks the layout at runtime), so the shared library
SONAME/install_name includes the minor version (`libo11y.so.0.Y` /
`@rpath/libo11y.0.Y.dylib`). Rebuild against the new headers when the minor
version changes. A patch release changes neither. The CMake version file
follows the same rule (`find_package(libo11y 0.2)` accepts any 0.2.x and
refuses 0.1.0 or 0.3.0; from 1.0 onward it uses `SameMajorVersion`) and checks
`CMAKE_SIZEOF_VOID_P` for pointer-width compatibility.

## Running the test suite

```sh
make c-check
```

From the repository root, this checks formatting and hygiene on the Zig
sources of the ABI layer, builds the libraries, runs the C11 unit,
concurrency, conformance, wire and CLI suites in `Debug` and `ReleaseSafe`,
checks ELF `SONAME`/`GNU_STACK`/exported `o11y_*` symbols (or Mach-O
`install_name` and exported `_o11y_*` symbols), and compiles and runs the quickstart statically, dynamically,
and as C++17. The conformance suite reads `conformance/vectors/` and
`conformance/appregistry/`. The run also includes:

- the ABI layout test, which translates the headers and compares every
  struct and enum with its mirror in `src/c_types.zig`;
- the C11 suites and quickstart compiled by the host C compiler with
  `-fsanitize=address,undefined` against the `Debug` archives `libo11ytest.a`
  and `libo11y.a` (`make c-sanitize` runs this part alone). The libraries
  allocate with `malloc`, so leaks, double frees, and C header/caller UB fail
  the run (the Zig engine inside the archives is checked by Zig's Debug safety
  checks rather than host compiler sanitizer instrumentation).
