# libo11y

Opinionated, elegant observability libraries built purely on OpenTelemetry.

libo11y gives applications one-call telemetry setup with unified configuration,
W3C context propagation, and log/trace/metric correlation, in the native idiom
of each target language. It wraps OpenTelemetry *setup*, never instrumentation:
after initialization your code uses the standard OTEL APIs and your language's
native logging facade, and everything is correlated and exported over OTLP.

## Languages

| Language | Status | Location |
|----------|--------|----------|
| Go | Implemented | [`go/`](go/) |
| Rust | Planned | [`rust/`](rust/) |
| Java | Planned | [`java/`](java/) |
| Zig | Planned | [`zig/`](zig/) |

## Design principles

1. **Pure OTEL.** Traces, metrics, and logs over OTLP. Standard `OTEL_*`
   environment variables are honored, never shadowed by a parallel namespace
   (an explicit, opt-in mode ignores them for hermetic tests). Stable
   semantic conventions by default for the instrumentation libo11y wires
   (HTTP spans and metrics). Not everything emitted is stable: gRPC spans
   and metrics follow the `rpc.*` conventions (release candidate), runtime
   metrics (`go.*`) are not yet stable, resource detectors record upstream
   attributes that are not yet stable (`host.*`, `container.id`,
   `vcs.ref.head.revision`), and the libo11y registry's own groups and
   overlays are marked development.
2. **One identity, three surfaces.** Logs, spans, and outgoing headers all read
   the active span context. No parallel trace-ID state, no desync.
3. **Wrap setup, not instrumentation.** One call builds and wires the
   providers; afterwards users call the vanilla OTEL API and their language's
   standard logging interface. libo11y exports no span or metric wrapper types.
4. **Owned lifecycle.** Initialization returns a handle with an idempotent,
   bounded `Shutdown` that reports per-signal errors. The library never
   panics, never calls exit, and never blocks startup on collector
   connectivity.
5. **Locally testable.** The library's guarantees can be asserted in a
   consumer's own test suite with the bundled hermetic test harness. One
   exception: secret attributes on metric measurements are dropped without
   being counted, so the conformance assertion cannot report them (inspect
   the recorded metrics instead). No global state is mutated in tests.
6. **Safe in the dark.** With no configuration at all, applications run
   normally: telemetry degrades gracefully instead of crashing the host.

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

## Further reading

See [`docs/DESIGN.md`](docs/DESIGN.md) for the cross-language design
contract, [`docs/SPEC.md`](docs/SPEC.md) for the telemetry specification,
[`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) for naming, versioning, and
configuration conventions, and [`docs/PARITY.md`](docs/PARITY.md) for the
feature-parity matrix across implementations.

## Installation (Go)

No version is tagged yet. Until the first release, `go get` resolves a
pseudo-version from `main`:

```sh
go get github.com/jamesainslie/libo11y/go@main
```

The Gin integration (`go/o11ygin`) requires the first tagged release of the
main module, `go/v0.1.0`, and installs once that tag exists. The modules
require Go 1.26.0 or later. Build with go1.26.9 or later on the 1.26 line
(or go1.27.2 or later on the 1.27 line) to pick up the standard-library
security fixes.

## Quick start (Go)

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
    slog.InfoContext(ctx, "ready") // correlated with the span, exported
}
```

A deployment environment is required. Set it with `WithEnvironment` or
`OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production`; the option
wins over the variable. Allowed values: production, staging, development,
test (extend with `WithEnvironmentValues`).

See [`go/README.md`](go/README.md) for the full Go documentation and
[`go/examples/httpserver`](go/examples/httpserver) for a complete,
tested HTTP service.

## Versioning

Each language library versions and releases independently with path-prefixed
tags (for example `go/v0.1.0`). There is no lockstep release across languages;
signal maturity differs per OpenTelemetry implementation. Nothing is
released yet; the first Go tags will be `go/v0.1.0` and then
`go/o11ygin/v0.1.0`, which requires it. `make release-check` validates that
sequence against a throwaway local remote.

## License

Apache-2.0. See [LICENSE](LICENSE).
