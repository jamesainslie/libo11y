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
- The gateway dashboard: requests by outcome and signal, rejections and dropped records by reason, attributes the policy removed, sink latency and outcomes, the derived metric aggregator, symbolicated frames by result and source map uploads by outcome, filtered by gateway and app.
- Recording rules for each vital's hourly p75 and sample count and for views and errors over 15 minutes, by app.
- Alert rules: poor and regressed vital p75 with a minimum traffic gate, error rate, gateway rejections, rate limiting, sink failures, sink latency, the aggregator series cap and gateway down. Each alert has a runbook section in this README.
- promtool 3.15.1 unit tests of every alert, run through `scripts/ops-promtool.sh`, which installs promtool only when its tarball matches a pinned SHA-256.
- `kustomization.yaml` with one `PrometheusRule` and one ConfigMap per dashboard for Grafana's dashboard sidecar, and `datasources/example.yaml`, an example of Grafana datasource provisioning.
- The catalog fixture uploads a source map and sends a symbolicated error, so the catalog records the gateway's symbolication and upload counters. Replay panels follow once the gateway exports replay metrics.
