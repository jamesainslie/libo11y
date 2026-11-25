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
| TypeScript | Implemented for Bun, Node, browsers and Manifest V3 extensions. The browser packages first ship in `ts/v0.2.0` | [`ts/`](ts/) |
| Rust | Planned | [`rust/`](rust/) |
| Java | Planned | [`java/`](java/) |
| Zig | Planned | [`zig/`](zig/) |

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
   connectivity. [`docs/PARITY.md`](docs/PARITY.md) lists the known defects
   of the current releases against this rule.
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

The registry generates TypeScript as well as Go. The TypeScript output is
the package `@libo11y/spec` in [`ts/packages/spec`](ts/packages/spec).
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
go get github.com/jamesainslie/libo11y/go@v0.2.0
go get github.com/jamesainslie/libo11y/go/o11ygin@v0.2.0       # only for Gin
go get github.com/jamesainslie/libo11y/go/o11yconnect@v0.2.0   # only for Connect
go get github.com/jamesainslie/libo11y/go/o11ysql@v0.2.0       # only for database/sql
```

The Gin, Connect, and database/sql integrations (`go/o11ygin`,
`go/o11yconnect`, `go/o11ysql`) are separate modules released alongside
the main module at the same version. The modules require Go 1.26.0 or
later. Build with the latest patch release of the 1.26 or 1.27 line to
pick up the standard-library security fixes.

The latest Go release, `go/v0.2.0`, implements spec 1.1.0 and stamps that
version's schema URL on every resource. Spec 1.2.0 support is on `main`
and ships in the next Go release. The TypeScript packages implement spec
1.2.0.

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
		// Setup installed nothing. The service runs without telemetry.
		log.Printf("telemetry disabled: %v", err)
	} else {
		defer sdk.Shutdown(context.Background())
	}

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
```

The six packages release together at one version, and they are built on
OpenTelemetry JS 3.x. `@libo11y/server` and `@libo11y/test` run on Bun
1.3.13 and Node 24. `@libo11y/web` and `@libo11y/webext` run in browsers,
and by default they record nothing until the application grants consent.

## Quick start (TypeScript)

```ts
import { instrumentServe, setup, shutdownOnSignals } from "@libo11y/server";

const telemetry = await setup({ serviceName: "checkout", environment: "production" });

const server = Bun.serve({
  port: 8080,
  fetch: instrumentServe(
    async () => {
      telemetry.logger.info("checkout started"); // correlated with the request's span
      return new Response("ok");
    },
    { route: () => "/checkout" },
  ),
});

// On SIGINT or SIGTERM, stop the server, then flush and shut the telemetry down.
await shutdownOnSignals(telemetry, { beforeShutdown: () => server.stop() });
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

## Versioning

Each language library versions and releases independently with path-prefixed
tags (for example `go/v0.1.0`). There is no lockstep release across languages;
signal maturity differs per OpenTelemetry implementation. The first Go
release is `go/v0.1.0`, with `go/o11ygin/v0.1.0` tagged on the same commit.
From `go/v0.2.0`, each release also tags `go/o11yconnect/vX.Y.Z` and
`go/o11ysql/vX.Y.Z` on that commit. Each Go release is listed in
[`go/CHANGELOG.md`](go/CHANGELOG.md) and on the GitHub releases page.
`make release-check` validates the tag sequence against a throwaway local
remote before a release.

The TypeScript packages release in lockstep. One `ts/vX.Y.Z` tag publishes
`@libo11y/spec`, `@libo11y/core`, `@libo11y/server`, `@libo11y/test`,
`@libo11y/web` and `@libo11y/webext` to npm at version X.Y.Z, with
provenance, through npm trusted publishing. The first version on npm is
0.1.1, and `@libo11y/web` and `@libo11y/webext` join at 0.2.0. Each
TypeScript release is listed in [`ts/CHANGELOG.md`](ts/CHANGELOG.md).
`make release-check` also packs the packages and installs them into a
throwaway consumer under Node and Bun, and it bundles the browser packages
for the browser.

## License

Apache-2.0. See [LICENSE](LICENSE).
