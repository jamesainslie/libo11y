# libo11y for TypeScript

The TypeScript implementation of libo11y, as a Bun workspace of eight
`@libo11y/*` packages. `@libo11y/server`, `@libo11y/test` and
`@libo11y/sourcemaps` run on Bun 1.3.13 and Node 24. `@libo11y/web`, `@libo11y/webext` and `@libo11y/rum` run
in browsers and Manifest V3 extensions. `@libo11y/spec` and `@libo11y/core` run in
both. The packages are built on
OpenTelemetry JS 3.x (`@opentelemetry/api` 1.10.0, the SDK packages at
3.1.1, and upstream's OTLP exporter base and serializers at 0.301.1 over
libo11y's own HTTP transport). They release together at one
version from a `ts/vX.Y.Z` tag, and [CHANGELOG.md](CHANGELOG.md) lists
each release.

| Package                                      | What it holds                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@libo11y/spec`](packages/spec)             | the spec constants and tables generated from `spec/registry`, the application registry validator, and the `libo11y` bin. It also runs in browsers                                                            |
| [`@libo11y/core`](packages/core)             | the platform-neutral core: configuration, identity, the sensitivity policy, the logger, events, exemplars and the signal pipelines                                                                           |
| [`@libo11y/server`](packages/server)         | the Bun and Node platform: `setup`, the `AsyncLocalStorage` context manager, resource detection, OTLP exporters, runtime metrics, `instrumentServe` and `instrumentFetch`                                    |
| [`@libo11y/test`](packages/test)             | the hermetic recorder, its assertions, and an in-process OTLP/HTTP sink                                                                                                                                      |
| [`@libo11y/web`](packages/web)               | the browser platform: `setup` with a pluggable context manager, the browser resource, the OTLP/HTTP JSON transport with an IndexedDB retry queue, the consent gate, and `fetch`, XHR and document-load spans |
| [`@libo11y/webext`](packages/webext)         | the Manifest V3 extension platform: `setupWorker` for the service worker, `setupContentScript` for content scripts and extension pages, and traced runtime messaging                                         |
| [`@libo11y/rum`](packages/rum)               | browser RUM over `@libo11y/web`: `setupRum`, sessions shared across tabs, session sampling with a retention buffer, and per-view summaries. In development                                                   |
| [`@libo11y/sourcemaps`](packages/sourcemaps) | the `libo11y-sourcemaps` command and `uploadSourceMaps`, which upload source maps to the RUM gateway (`go/o11yrum`) for symbolication. In development                                                        |

`@libo11y/web` and `@libo11y/webext` first ship in `ts/v0.2.1`. `@libo11y/rum`
and `@libo11y/sourcemaps` have not shipped yet.
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

For a browser application or a Manifest V3 extension, install the browser
platform instead:

```sh
npm install @libo11y/web      # pages
npm install @libo11y/webext   # Manifest V3 service workers, content scripts and extension pages
npm install @libo11y/rum      # RUM over @libo11y/web (in development)
```

The [web README](packages/web/README.md) and the
[webext README](packages/webext/README.md) cover consent, endpoints and
CORS, and offline delivery. The [rum README](packages/rum/README.md)
covers sessions, sampling and retention.

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
  packages/spec/       @libo11y/spec
  packages/core/       @libo11y/core
  packages/server/     @libo11y/server
  packages/test/       @libo11y/test
  packages/web/        @libo11y/web, with its Playwright specs and fixture server in browser/
  packages/webext/     @libo11y/webext, with its Playwright specs and test extension in browser/
  packages/rum/        @libo11y/rum, with its Playwright specs and fixtures in browser/
  packages/sourcemaps/ @libo11y/sourcemaps, with the gateway end-to-end journey in src/e2e/
  examples/            bun-server and node-server, private workspace apps
  scripts/             release.ts sets the version and packs the packages; size.ts checks the bundle size budgets
  size-budget.json     the browser bundle size budgets
  playwright.config.ts the browser test configuration
```

## Commands

Run these in `ts/`:

| Command                                 | What it does                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`         | installs the locked dependencies                                                                                                                          |
| `bun run lint`                          | Biome lint and format check                                                                                                                               |
| `bun run typecheck`                     | tsc over every package, the examples, the scripts and the browser specs                                                                                   |
| `bun run build`                         | ESM JavaScript and declarations in each package's `dist/`                                                                                                 |
| `bun run api:check`                     | fails when the build's API differs from `api/*.api.md`                                                                                                    |
| `bun run api`                           | rewrites the API reports after a deliberate API change                                                                                                    |
| `bun run test:bun`, `bun run test:node` | every unit suite under Bun, then under Node                                                                                                               |
| `bun run test:browser`                  | the browser suites under Playwright 1.64.1, with two workers: `web` and `webext` in headless Chromium, and `rum-chromium`, `rum-firefox` and `rum-webkit` |
| `bun scripts/size.ts --check`           | the browser bundle size budgets in `size-budget.json`                                                                                                     |

The browser specs are `packages/*/browser/**/*.pw.ts`, a suffix that
neither `bun test` nor the Node glob picks up. Their global setup bundles
the page fixtures and the test extension with `Bun.build`. The fixture
server and OTLP sink in `packages/web/browser/harness/server.ts` serve the
pages at `http://127.0.0.1:47311`, and `http://localhost:47311` is the
second origin for the cross-origin tests. `LIBO11Y_BROWSER_PORT` changes
the port. Install Playwright's browsers once with
`bun x --no-install playwright install chromium firefox webkit`. Where only
Chromium runs, pass `--project=web --project=webext --project=rum-chromium`.

From the repository root, `make ts-check` runs every command except
`test:browser` and the size check, `make ts-browser-test` runs
`test:browser`, and `make ts-size` runs the size check.
`make release-check` also packs the packages and installs them into a
throwaway consumer. There it imports the server packages under Node and
Bun, and it bundles every entry point of `@libo11y/web`,
`@libo11y/webext` and `@libo11y/rum` with `bun build --target=browser`
(`scripts/ts-browser-bundle-check.sh`). The bundle check fails when any
module in the graph is a Node builtin or a Bun polyfill for one.

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
