# Changelog

All notable changes to `github.com/jamesainslie/libo11y/go/o11yrum` and the
`o11yrum-gateway` command are documented here. o11yrum versions
independently of the other Go modules. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the module
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-27

The first release. It requires `github.com/jamesainslie/libo11y/go`
v0.3.0 or later.

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
  `service.name`, without the resource. A point keeps only the labels the
  specification classifies bounded or enum, plus the keys its app lists in
  `app_metric_labels`. Keys the specification classifies PII, secret or
  unbounded are always dropped, and a configuration that lists one is
  refused. Each app's metrics are its own. A point may carry at most 16
  labels with keys of at most 256 bytes, longer values are cut to 256
  bytes, and a histogram may have at most 64 bounds.
- The `aggregation` configuration section: `max_series_per_metric`
  (default 2000 for each app, with an overflow series per app past it) and
  `max_metrics_per_app` (default 200).
- The self-telemetry gauge `o11yrum.aggregator.series`.
- The `o11yrum-gateway` command exports the derived metrics with its own,
  through the metric reader `OTEL_METRICS_EXPORTER` selects. It registers
  its producer as `o11yrum` and as the fallback producer, and refuses to
  start when `OTEL_METRICS_PRODUCERS` is set without `o11yrum`.
- Object stores for source maps: the `ObjectStore` interface,
  `NewFileStore`, `WithObjectStore`, the `object_store` configuration
  section, and the `s3store` package, which authenticates with the AWS
  SDK's default credential chain (EKS Pod Identity, IRSA, instance roles
  or the environment). The `o11yrum-gateway` command builds the S3 store
  from the configuration.
- `POST /_o11y/v1/sourcemaps`: bearer-token source map uploads per app
  (`apps[].sourcemaps.upload_token_file`, `sourcemaps.max_upload_bytes`,
  default 32 MiB), keyed by namespace, `service.version`,
  `o11y.rum.app.update_id` and script path. Maps are parsed before they
  are stored and are never served back. Failed authentications spend the
  client's rate limit.
- Symbolication of JavaScript stacks in `o11y.rum.error` records, records
  with `exception.stacktrace` and span `exception` events, through an LRU
  cache of parsed maps with a time to live and a negative cache
  (`symbolication`), and a store read budget per batch, before
  export and metric derivation. Every such record gets
  `o11y.rum.error.fingerprint` from its resolved frames. V8, Gecko and
  WebKit stack formats are parsed.
- Self-telemetry: `o11yrum.sourcemaps.uploads` by outcome and
  `o11yrum.symbolication.frames` by result.
- `/readyz` answers 503 from the moment the `o11yrum-gateway` command
  begins shutting down. The new top-level `shutdown_delay` setting
  (default 0) keeps the gateway serving for that long, with `/readyz`
  failing, before it stops accepting connections and drains.
- `o11yrum-gateway -version` reports the module version Go records in the
  binary when no version was linked in, so `go install
  github.com/jamesainslie/libo11y/go/o11yrum/cmd/o11yrum-gateway@v0.1.0`
  reports `v0.1.0`.
- The container image `ghcr.io/jamesainslie/o11yrum-gateway`: a static
  binary on distroless for `linux/amd64` and `linux/arm64`, running as
  user 65532 with nothing to write at runtime unless a `filesystem` object
  store is configured, published by the release
  workflow with attested build provenance.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/go/o11yrum/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/go/o11yrum/v0.1.0
