# libo11y for TypeScript

The TypeScript implementation of libo11y, as a Bun workspace of
`@libo11y/*` packages. The packages are not published yet. They release
together at one version from a `ts/vX.Y.Z` tag.

## Layout

```
ts/
  packages/spec/   @libo11y/spec: the generated spec constants and tables,
                   the application registry validator, and the libo11y bin
  scripts/         release.ts: sets the version and packs the packages
```

`@libo11y/spec` has two entry points and a bin:

- `@libo11y/spec` holds the attribute keys, enums, event and metric names,
  and sensitivity tables, generated from `spec/registry` by
  `make spec-generate`. It also exports `validateAppRegistry` and
  `compileAppRegistry`. It has no dependencies, so it runs in a browser.
- `@libo11y/spec/yaml` exports `parseAppRegistry` and
  `parseAppRegistryBytes`, which read a registry file the way Go's yaml.v3
  does. It is the only module that depends on a YAML parser.
- The `libo11y` bin runs `libo11y registry check FILE...`, with the same
  output and exit statuses as the Go binary.

## Commands

Run these in `ts/`:

| Command                                 | What it does                                              |
| --------------------------------------- | --------------------------------------------------------- |
| `bun install --frozen-lockfile`         | installs the locked dependencies                          |
| `bun run lint`                          | Biome lint and format check                               |
| `bun run typecheck`                     | tsc over every package and the scripts                    |
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
and release rules.
