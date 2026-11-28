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
- The RUM overview dashboard: views per minute, errors and frustrations per 100 views, Core Web Vitals p75 and rating share, and the busiest views.
- The web vitals dashboard: each vital at p75 over time and by view, device class, browser and country, with the specification's thresholds.
- The errors and frustration dashboard: rates by source and type from the derived metrics, and the error inbox, frustrated elements and sessions from Loki.
- The session explorer: one session's views, events, traces and spans from Loki and Tempo by `session.id` and `o11y.rum.view.id`.
- Builder support for a dashboard's default time range and a panel's `fieldConfig.defaults.custom`. Loki query variables render as the `label_values()` string Grafana's Loki datasource reads, and the JSON keeps `&`, `<` and `>` unescaped.
