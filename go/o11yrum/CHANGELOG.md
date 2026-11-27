# Changelog

All notable changes to `github.com/jamesainslie/libo11y/go/o11yrum` and the
`o11yrum-gateway` command are documented here. o11yrum versions
independently of the other Go modules. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the module
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The `o11yrum` module: `NewHandler`, the configuration file format, edge
  checks and validation of OTLP traces and logs, and the `Sink` interface.
- Enrichment of every accepted batch: browser family, `os.name` and device
  class from the user agent and its client hints, the country from a
  header believed only from listed proxy hops (`edge.country`), and clock
  skew correction from the client's `sent_at` query parameter
  (`edge.clock_skew_threshold`, default 1s).
- `NewOTLPSink` and `sinks.otlp`: the built-in sink that posts batches to
  an OTLP/HTTP collector as protobuf, gzip by default.
- Self-telemetry through the SDK given to `WithSDK`: `o11yrum.batches`,
  `o11yrum.records.dropped`, `o11yrum.attributes.removed` and
  `o11yrum.sink.duration`.
- Remote configuration at `GET /_o11y/v1/config?service=<service.name>`,
  served from each app's `remote_config_file` with an ETag, or from a
  `ConfigProvider` given to `WithConfigProvider`.
- The `o11yrum-gateway` command: one YAML configuration file, its own
  telemetry through the libo11y core and the standard `OTEL_*` variables,
  `/healthz` and `/readyz`, `-check-config`, and graceful shutdown.
- `MetricProducer` and `WithMetricProducer`: the gateway derives the nine
  standard RUM metrics from `o11y.rum.view.summary` events once the sinks
  accept the batch, rates each vital against the specification's
  thresholds, labels every point with the app's `service.name`, and exposes
  the cumulative results to any OpenTelemetry metric reader.
- Operator-defined metrics in the app configuration (`metrics`): counters
  and histograms over one event, filtered by `where` and grouped only by
  attributes the specification classifies bounded or enum.
- `POST /_o11y/v1/metrics`: app metrics sent as delta sums and delta
  explicit-bucket histograms are re-aggregated under the app's
  `service.name`, without the resource or any unbounded attribute. Each
  app's metrics are its own. A point may carry at most 16 labels with keys
  of at most 256 bytes, longer values are cut to 256 bytes, and a
  histogram may have at most 64 bounds.
- The `aggregation` configuration section: `max_series_per_metric`
  (default 2000 for each app, with an overflow series per app past it) and
  `max_metrics_per_app` (default 200).
- The self-telemetry gauge `o11yrum.aggregator.series`.
