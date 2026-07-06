# libo11y conventions

## Repository layout

```
libo11y/
  docs/          cross-language design contract, spec, and conventions
  spec/          telemetry specification: Weaver registry, policies,
                 schemas, and the pinned upstream semconv snapshot
  go/            Go module (github.com/jamesainslie/libo11y/go)
  rust/          Rust workspace (planned)
  java/          Java/Maven module (planned)
  zig/           Zig package (planned)
```

Each language directory is self-contained: its own build, tests, lint
configuration, changelog, and README. The `spec/` registry is the shared,
language-neutral source of truth; each language generates typed constants
and validation tables from it.

## Specification toolchain

The specification is validated and generated with
[OpenTelemetry Weaver](https://github.com/open-telemetry/weaver), pinned via
mise. Make targets from the repository root:

- `make spec-check` validates the registry against the semconv format and
  the Rego policy suite.
- `make spec-generate` regenerates `go/spec`, `go/internal/spectables`, and
  `docs/taxonomy` from the registry.
- `make spec-drift` fails if generated artifacts are stale (the CI gate).

The official semconv registry is vendored under `spec/vendor/` at a pinned
version, so validation is hermetic and needs no network.

## Versioning and releases

- Independent per-language versioning, path-prefixed tags: `go/v0.1.0`,
  `rust/v0.1.0`.
- Semantic versioning per language ecosystem norms.
- No lockstep releases. A change to shared docs never forces a release.
- Each language keeps a `CHANGELOG.md` in Keep a Changelog format.

## Naming

- The user-facing package/crate/artifact is named `o11y` where the ecosystem
  allows (Go package `o11y`, Rust crate `libo11y`, Java artifact `libo11y`).
- Metric and attribute names come exclusively from OpenTelemetry semantic
  conventions at the pinned version. Libraries add no vendor prefix to
  telemetry they emit on behalf of applications.
- The semconv pin is recorded per language release and upgraded deliberately.
  Current pin: semconv v1.41.0.

## Environment variables

Standard `OTEL_*` variables are the only environment surface. libo11y defines
no `LIBO11Y_*` variables for anything OTEL specifies. If a knob has no OTEL
equivalent it is a code-level option, not an environment variable, until the
OTEL specification catches up.

## Commit messages

`<area>: <type>: <description>` all lowercase, where area is one of `go`,
`rust`, `java`, `zig`, `docs`, `general`, and type follows Conventional
Commits (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`,
`perf`, `revert`).

Example: `go: feat: add o11ytest recorder harness`

## Quality gates per language

- Go: gofmt, go vet, golangci-lint, race detector, `testing/slogtest` handler
  contract, no exported symbol referencing pre-1.0 OTEL log types.
- Rust (planned): clippy pedantic, `unsafe_code = "forbid"`, cargo-deny.
- Java (planned): errorprone, spotless.
- Zig (planned): zig fmt, exhaustive switch on error sets.
