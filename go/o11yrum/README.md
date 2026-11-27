# o11yrum

o11yrum is the libo11y RUM gateway. It receives OTLP traces, logs and app
metrics from browsers, browser extensions and React Native apps, checks
and validates them against the libo11y specification, and forwards them to
your backend. The design is in
[the RUM design document](../../docs/design/2026-11-27-libo11y-rum-design.md).

In development; not yet released.

## Running the gateway

From `go/o11yrum`:

```sh
go install ./cmd/o11yrum-gateway
o11yrum-gateway -check-config -config gateway.yaml
o11yrum-gateway -config gateway.yaml
```

[`cmd/o11yrum-gateway/testdata/gateway.yaml`](cmd/o11yrum-gateway/testdata/gateway.yaml)
is a complete configuration. `environment` is required and takes
`production`, `staging`, `development` or `test`. Without
`sinks.otlp.endpoint`, batches go to `OTEL_EXPORTER_OTLP_ENDPOINT` with
`OTEL_EXPORTER_OTLP_HEADERS`, which must use the `http/protobuf` protocol.
The gateway's own telemetry follows the standard `OTEL_*` variables.

The config endpoint shares the ingest rate limit, so a page load that
fetches its configuration spends one request of the client's budget.

## Derived metrics

The gateway derives the standard RUM metrics from view summaries,
evaluates each app's `metrics` definitions, and re-aggregates the app
metrics browsers post to `/_o11y/v1/metrics`. The command exports them
with its own metrics, through the reader `OTEL_METRICS_EXPORTER` selects.
Its producer is registered as `o11yrum` and as the fallback, so leave
`OTEL_METRICS_PRODUCERS` unset, or include `o11yrum` in it. The command
refuses to start when the variable is set without it.

## App metric labels

An app metric point keeps only the labels the specification classifies
bounded or enum, such as `o11y.rum.platform` and `os.name`. Every other
label is dropped, and the point is still counted. An app lists its own
label keys in `app_metric_labels` to keep them:

```yaml
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    app_metric_labels: [shop.checkout.step, shop.plan]
```

List only keys with a bounded set of values, because each distinct value
becomes its own series. A point may carry at most 16 labels, a key may be
at most 256 bytes, and longer values are cut to 256 bytes. Keys the
specification classifies PII, secret or unbounded, such as `session.id`,
are always dropped, whatever the app's `pii` mode, and a configuration
that lists one fails to load.
