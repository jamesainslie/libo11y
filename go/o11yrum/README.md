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
