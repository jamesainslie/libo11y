# Changelog

All notable changes to the libo11y specification are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the specification adheres to [Semantic Versioning](https://semver.org/).
Each released version is tagged `spec/vX.Y.Z` and its schema file is served
at its schema URL.

## [Unreleased]

Spec 1.3.0, the RUM view summary. The schema URL is
`https://schemas.o11y.ing/libo11y/1.3.0`.

### Added

- The event `o11y.rum.view.summary` and its attribute group
  `registry.o11y.rum.summary`: the summary's index within its view, the
  time on the view, request and long animation frame counts, one count per
  `o11y.rum.error.source` and `o11y.rum.frustration.type` value, and one
  value per web vital. Counts are deltas, and an absent count means zero.
- The statement that the gateway derives the nine RUM metrics from view
  summaries and that clients do not export them, with the mapping from
  summary attributes to metrics. Each RUM metric brief says so.
- The vital rating thresholds the gateway rates each web vital against.
  Clients do not send a rating.
- The rule that each vital is reported once per view, in the first summary
  sent after it is known, and how that differs from CrUX.
- The start and end of view and action spans, in the span shape briefs.
- `o11y.rum.app.update_id`, the over-the-air update a mobile app runs.
- `o11y.rum.span.shape`, required on the view, action and `app_load` span
  shapes, so a span names the shape it follows.
- `service.name` as a required attribute of the nine RUM metrics, because
  one gateway derives them for many apps.
- The classification of the semconv attribute `os.name` as `public` and
  `bounded`, for the operating system the gateway parses from the user
  agent.
- The rule `libo11y_rum_summary_coverage`, which keeps the summary's
  per-source and per-type counts in step with their enums.

## [1.2.0] - 2026-11-24

Tagged `spec/v1.2.0`. Its schema file is served at
`https://schemas.o11y.ing/libo11y/1.2.0`.

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
