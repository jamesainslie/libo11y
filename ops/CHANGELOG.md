# Changelog

All notable changes to the libo11y RUM ops pack are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this module adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-27

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
- The gateway dashboard: requests by outcome and signal, rejections and dropped records by reason, attributes the policy removed, sink latency and outcomes, the derived metric aggregator, symbolicated frames by result and source map uploads by outcome, filtered by gateway and app.
- Recording rules for each vital's hourly p75 and sample count and for views and errors over 15 minutes, by app.
- Alert rules: poor and regressed vital p75 with a minimum traffic gate, error rate, gateway rejections, rate limiting, sink failures, sink latency, the aggregator series cap and gateway down. Each alert has a runbook section in `README.md`.
- promtool 3.15.1 unit tests of every alert, run through `scripts/ops-promtool.sh`, which installs promtool only when its tarball matches a pinned SHA-256.
- `kustomization.yaml` with one `PrometheusRule` and one ConfigMap per dashboard for Grafana's dashboard sidecar, and `datasources/example.yaml`, an example of Grafana datasource provisioning.
- The catalog fixture uploads a source map and sends a symbolicated error, so the catalog records the gateway's symbolication and upload counters. Replay panels follow once the gateway exports replay metrics.
- `opsgen` parses every generated rule with the Prometheus parser and refuses thresholds that produce PromQL Prometheus would not load. The query lint accepts `up`, which Prometheus writes for every scrape target.
- `make ops-promtool-test` tests the promtool installer, and CI caches the promtool download.
- An integration test, `make ops-integration`, that CI runs. It starts Loki, Tempo, Prometheus, Grafana and an OpenTelemetry Collector in Docker Compose behind the gateway built from the checkout. It sends three sessions of fixture traffic and runs every panel query through Grafana's query API, and it checks that the panels the fixture covers show data. It also checks that Prometheus loads every rule, that Loki never indexes `session_id` or `o11y_rum_view_id`, and, in headless Chrome, that the session explorer's view link and Loki app variable work.
- The release archive `libo11y-ops-vX.Y.Z.tar.gz` with `SHA256SUMS`, attached to the GitHub Release for each `ops/vX.Y.Z` tag. `scripts/ops-release-check.sh` validates a release and builds the archive, and `make ops-release-check` runs it.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/ops/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/ops/v0.1.0
