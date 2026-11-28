# libo11y RUM ops pack

Status: in development. Nothing is released yet, and the first release will be `ops/v0.1.0`.

The ops pack is a generic Grafana and Prometheus pack for libo11y RUM. It will hold dashboards for the metrics the `o11yrum-gateway` derives, error and frustration views, a session explorer over Tempo and Loki, the gateway's own telemetry, and Prometheus recording and alert rules.

The dashboards and rules are generated from Go code in this module, so operators import the committed JSON and YAML and never need Go. Every dashboard selects its datasources through the `prometheus`, `loki` and `tempo` variables, so no datasource UID is written into the pack.

## How the pack is tested

- A catalog test builds `o11yrum-gateway` from this checkout, sends it one fixture RUM session, scrapes its Prometheus endpoint and compares every metric family and label name with `internal/catalog/testdata/exported.txt`. Refresh that file with `go test ./internal/catalog/ -run TestGatewayExports -update`, never by hand.
- A lint package parses every PromQL expression with the Prometheus parser and checks each metric and label against that catalog. LogQL and TraceQL queries are checked for structure: `session_id` and `o11y_rum_view_id` are Loki structured metadata, so they appear only after the stream selector and never as stream labels.
- A drift test fails when the committed artifacts differ from what the generator produces. Run `make ops-generate` from the repository root to regenerate them.

Run every check with `make ops-check` from the repository root.
