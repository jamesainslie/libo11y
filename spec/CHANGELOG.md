# Changelog

All notable changes to the libo11y specification are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the specification adheres to [Semantic Versioning](https://semver.org/).
Each released version is tagged `spec/vX.Y.Z` and its schema file is served
at its schema URL.

## [Unreleased]

### Added

- `o11y.log.source` (`logger`, `console`), which marks log records an
  implementation captured from console output. It is referenced from the
  log record group as conditionally required on captured records.

## [1.1.0] - 2026-11-18

Tagged `spec/v1.1.0`. Its schema file is served at
`https://schemas.o11y.ing/libo11y/1.1.0`.

### Added

- RUM conventions under `o11y.rum.*`: the platform-neutral
  attributes, the browser group, the `view`, `action` and `app_load` span
  shapes, the RUM metrics and the RUM events. See `docs/RUM.md`.
- The application attribute registry (`libo11y.app-registry/v1`) and its
  rules.
- A manifest version history and one schema file per version.
- A TypeScript codegen target (`ts/packages/spec`).
- The rules `libo11y_rename_needs_transform`, `libo11y_rum_span_kind` and
  `libo11y_group_duplicate`.

### Changed

- `make spec-check` validates the manifest version history.
- The manifest's `schema_url` may not carry a query or a fragment.

## [1.0.0] - 2026-10-12

First released version, tagged `spec/v1.0.0`.
