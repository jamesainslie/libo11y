# Changelog

All notable changes to the libo11y RUM ops pack are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this module adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The ops module skeleton.
- A deterministic Grafana dashboard builder (`internal/dash`).
- `opsgen`, which generates the pack from Go code and `thresholds.yaml`, with `-thresholds` for an operator's own values and `-check` for drift.
- `thresholds.yaml`, the alert thresholds, whose vital bounds match the specification's rating table.
- A metric catalog captured from the real `o11yrum-gateway` after one fixture RUM session, and lint that checks every PromQL query against it and every LogQL and TraceQL query for structure.
