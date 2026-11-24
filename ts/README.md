# libo11y for TypeScript

The TypeScript implementation of libo11y, as a Bun workspace of four
`@libo11y/*` packages for Bun 1.3.13 and Node 24. The packages are built on
OpenTelemetry JS 3.x (`@opentelemetry/api` 1.10.0, the SDK packages at
3.1.1 and the OTLP exporters at 0.301.1). They release together at one
version from a `ts/vX.Y.Z` tag, and [CHANGELOG.md](CHANGELOG.md) lists
each release.

| Package                              | What it holds                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@libo11y/spec`](packages/spec)     | the spec constants and tables generated from `spec/registry`, the application registry validator, and the `libo11y` bin. It also runs in browsers                         |
| [`@libo11y/core`](packages/core)     | the platform-neutral core: configuration, identity, the sensitivity policy, the logger, events, exemplars and the signal pipelines                                        |
| [`@libo11y/server`](packages/server) | the Bun and Node platform: `setup`, the `AsyncLocalStorage` context manager, resource detection, OTLP exporters, runtime metrics, `instrumentServe` and `instrumentFetch` |
| [`@libo11y/test`](packages/test)     | the hermetic recorder, its assertions, and an in-process OTLP/HTTP sink                                                                                                   |

A browser platform is planned for `ts/v0.2.0`.
[docs/PARITY.md](../docs/PARITY.md) compares every capability with Go.

## Install

```sh
npm install @libo11y/server
npm install --save-dev @libo11y/test
```

`@libo11y/server` depends on `@libo11y/core` and `@libo11y/spec`, and it
re-exports the core types an application needs most. Add `@libo11y/core`
as a direct dependency to import `forceEmit`, `startRecord`,
`currentRecord` or the other core types.

## Quick start

```ts
import { instrumentServe, setup, shutdownOnSignals } from "@libo11y/server";

const telemetry = await setup({ serviceName: "checkout", environment: "production" });
telemetry.logger.info("ready");

const server = Bun.serve({
  port: 8080,
  fetch: instrumentServe(async () => new Response("ok"), { route: () => "/" }),
});

await shutdownOnSignals(telemetry, { beforeShutdown: () => server.stop() });
```

The [server README](packages/server/README.md) covers the rest, and
[`examples/`](examples) holds a `Bun.serve` app and a `node:http` app, each
tested end to end against the OTLP sink.

## Layout

```
ts/
  packages/spec/     @libo11y/spec
  packages/core/     @libo11y/core
  packages/server/   @libo11y/server
  packages/test/     @libo11y/test
  examples/          bun-server and node-server, private workspace apps
  scripts/           release.ts: sets the version and packs the packages
```

## Commands

Run these in `ts/`:

| Command                                 | What it does                                              |
| --------------------------------------- | --------------------------------------------------------- |
| `bun install --frozen-lockfile`         | installs the locked dependencies                          |
| `bun run lint`                          | Biome lint and format check                               |
| `bun run typecheck`                     | tsc over every package, the examples and the scripts      |
| `bun run build`                         | ESM JavaScript and declarations in each package's `dist/` |
| `bun run api:check`                     | fails when the build's API differs from `api/*.api.md`    |
| `bun run api`                           | rewrites the API reports after a deliberate API change    |
| `bun run test:bun`, `bun run test:node` | every suite under Bun, then under Node                    |

From the repository root, `make ts-check` runs all of these, and
`make release-check` also packs the packages and installs them into a
throwaway consumer.

## Conventions

- Tests use `node:test` and `node:assert/strict`, so they run under Bun
  and Node unchanged.
- Imports use `.ts` specifiers, and source uses only erasable TypeScript
  syntax, so Node runs it through type stripping.
- Add a dependency only with
  `bun add --exact --minimum-release-age=1209600 <pkg>@<version>`.
- Behaviour shared with Go must match it byte for byte. The cases in
  `conformance/` prove it.

See [docs/CONVENTIONS.md](../docs/CONVENTIONS.md) for the full toolchain
and the release procedure.
