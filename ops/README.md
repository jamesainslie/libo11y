# libo11y RUM ops pack

Status: in development. Nothing is released yet, and the first release will be `ops/v0.1.0`.

The ops pack is a generic Grafana and Prometheus pack for libo11y RUM. It will hold dashboards for the metrics the `o11yrum-gateway` derives, error and frustration views, a session explorer over Tempo and Loki, the gateway's own telemetry, and Prometheus recording and alert rules.

The dashboards and rules are generated from Go code in this module, so operators import the committed JSON and YAML and never need Go. Every dashboard selects its datasources through the `prometheus`, `loki` and `tempo` variables, so no datasource UID is written into the pack.

## Dashboards

The generated dashboards are in `dashboards/`. Each is plain Grafana JSON for Grafana 11.0 or later.

| Dashboard | UID | What it shows |
|---|---|---|
| libo11y RUM: overview | `libo11y-rum-overview` | Views, errors and frustrations per 100 views, the p75 and rating share of LCP, INP and CLS, and the busiest views. |
| libo11y RUM: web vitals | `libo11y-rum-vitals` | LCP, INP, CLS, FCP and TTFB at the 75th percentile over time and by view, device class, browser and country. |
| libo11y RUM: errors and frustration | `libo11y-rum-errors` | Error and frustration rates from the derived metrics, and from Loki the error inbox, the most frustrated elements and the sessions behind them. |
| libo11y RUM: session explorer | `libo11y-rum-session-explorer` | One session rebuilt from its Loki events and Tempo traces by `session.id`, and one of its views by `o11y.rum.view.id`. |

The Prometheus panels count every consented session, because the gateway derives the metrics from view summaries. Error and frustration events reach Loki only for sessions the sampler kept, so the Loki panels say so in their descriptions.

### Variables

- `prometheus`, `loki` and `tempo` pick the datasources. No datasource UID is written into a dashboard.
- `app` filters by `service_name` on every panel. The derived metrics carry `service.name` as the `service_name` label, and Loki indexes it as its only stream label. The session explorer reads its app list from Loki.
- `platform` and `view` filter by `o11y_rum_platform` and `o11y_rum_view_name`. The web vitals dashboard adds `device`, `browser`, `country` and `connection`.
- `session_id` and `view_id` are text boxes on the session explorer. Its queries read them as Loki structured metadata after the stream selector, and as span attributes in Tempo.

Labels the specification makes required on a metric (`service.name`, `o11y.rum.platform`) use `.+` as the All value. Optional labels (device class, browser family, effective connection, country, and the view name) use `.*`, so a series without the label still counts when its variable is at All.

## How the pack is tested

- A catalog test builds `o11yrum-gateway` from this checkout, sends it one fixture RUM session, scrapes its Prometheus endpoint and compares every metric family and label name with `internal/catalog/testdata/exported.txt`. Refresh that file with `go test ./internal/catalog/ -run TestGatewayExports -update`, never by hand.
- A lint package parses every PromQL expression with the Prometheus parser and checks each metric and label against that catalog. LogQL and TraceQL queries are checked for structure: `session_id` and `o11y_rum_view_id` are Loki structured metadata, so they appear only after the stream selector and never as stream labels.
- A drift test fails when the committed artifacts differ from what the generator produces. Run `make ops-generate` from the repository root to regenerate them.

Run every check with `make ops-check` from the repository root.
