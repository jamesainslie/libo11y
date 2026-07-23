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
   environment variables are honored, never shadowed by a parallel namespace.
   Stable semantic conventions only.
2. **One identity, three surfaces.** Logs, spans, and outgoing headers all read
   the active span context. No parallel trace-ID state, no desync.
3. **Wrap setup, not instrumentation.** One call builds and wires the
   providers; afterwards users call the vanilla OTEL API and their language's
   standard logging interface. libo11y exports no span or metric wrapper types.
4. **Owned lifecycle.** Initialization returns a handle with an idempotent,
   bounded `Shutdown` that reports per-signal errors. The library never
   panics, never calls exit, and never blocks startup on collector
   connectivity.
5. **Locally testable.** Every guarantee the library makes can be asserted in
   a consumer's own test suite with the bundled hermetic test harness. No
   global state is mutated in tests.
6. **Safe in the dark.** With no configuration at all, applications run
   normally: telemetry degrades gracefully instead of crashing the host.

## The specification

libo11y centralizes a versioned telemetry specification in
[`spec/`](spec/): a tiered resource-attribute taxonomy, structured-logging
rules, per-signal minimums, a registered event catalog, and a sensitivity
classification that drives redaction. It extends OpenTelemetry semantic
conventions (never redefining stable upstream attributes), is validated by
the repository's own policy checks (`make spec-check`: naming, namespace
ownership, sensitivity, cardinality, event, and metric-unit rules), and is
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

## Quick start (Go)

```go
sdk, err := o11y.Setup(ctx, o11y.WithServiceName("checkout"))
if err != nil {
    return err
}
defer sdk.Shutdown(context.Background())

slog.InfoContext(ctx, "ready")          // correlated, exported
tracer := otel.Tracer("checkout")       // vanilla OTEL from here on
```

See [`go/README.md`](go/README.md) for the full Go documentation.

## Versioning

Each language library versions and releases independently with path-prefixed
tags (for example `go/v0.1.0`). There is no lockstep release across languages;
signal maturity differs per OpenTelemetry implementation.

## License

Apache-2.0. See [LICENSE](LICENSE).
