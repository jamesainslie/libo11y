# Changelog

All notable changes to the libo11y specification are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the specification adheres to [Semantic Versioning](https://semver.org/).
Each released version is tagged `spec/vX.Y.Z` and its schema file is served
at its schema URL.

## [Unreleased]

### Added

- Spec 1.1.0. RUM conventions under `o11y.rum.*`: the platform-neutral
  attributes, the browser group, the `view`, `action` and `app_load` span
  shapes, the RUM metrics and the RUM events. See `docs/RUM.md`.
- The application attribute registry (`libo11y.app-registry/v1`) and its
  rules.
- A manifest version history and one schema file per version.
- A TypeScript codegen target (`ts/packages/spec`).
- The rules `libo11y_rename_needs_transform` and `libo11y_rum_span_kind`.

## [1.0.0] - 2026-10-12

First released version, tagged `spec/v1.0.0`.
