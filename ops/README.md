# libo11y RUM ops pack

The current release is `ops/v0.1.0`. Its GitHub Release, `libo11y-ops v0.1.0`, attaches the pack as `libo11y-ops-v0.1.0.tar.gz` with `SHA256SUMS`. The changes are in [CHANGELOG.md](CHANGELOG.md).

The ops pack is a generic Grafana and Prometheus pack for libo11y RUM. It holds dashboards for the metrics the `o11yrum-gateway` derives, error and frustration views, a session explorer over Tempo and Loki, a dashboard for the gateway's own telemetry, and Prometheus recording and alert rules.

The dashboards and rules are generated from Go code in this module, so operators import the committed JSON and YAML and never need Go. Every dashboard selects the datasources it uses through the `prometheus`, `loki` and `tempo` variables, so no datasource UID is written into the pack.

The pack covers RUM. Dashboards for core services (RED by route and RPC, dependencies, runtime) and latency SLO burn-rate alerts are planned for `ops/v0.2.0`, and a Grafana app plugin with a session list and a replay player for a later release.

## Requirements

- Grafana 11.0 or later. The dashboards use `schemaVersion` 39, and the integration test runs them on Grafana 13.3.1.
- Prometheus 2.x or 3.x scraping the gateway, with the default OpenTelemetry name translation (dots become underscores, counters gain `_total`, seconds histograms gain `_seconds`). The pack is tested against Prometheus 3.15.1.
- Loki 3.0 or later, receiving logs through its native OTLP endpoint (`/otlp`). Loki then indexes `service.name` as the `service_name` label and keeps log attributes as structured metadata. Do not promote `session.id` or `o11y.rum.view.id` to index labels in `otlp_config`: both are unbounded, and every Loki query in the pack reads them as structured metadata after the stream selector. The pack is tested against Loki 3.7.10 with the default `otlp_config`.
- Tempo with TraceQL (2.4 or later). Declaring `session.id` and `o11y.rum.view.id` as dedicated span attribute columns makes the session explorer faster, and it works without them. The pack is tested against Tempo 3.1.1.
- The gateway's Prometheus reader (`OTEL_METRICS_EXPORTER=prometheus`) for the gateway dashboard and alerts.

## Install

- **Grafana import.** Import each file in `dashboards/` (Dashboards, New, Import), and pick your Prometheus, Loki and Tempo datasources in the variables at the top.
- **Grafana provisioning.** Point a file dashboard provider at a directory holding `dashboards/*.json`, and load the rule files in `alerts/*.rules.yaml` through Prometheus's `rule_files`.
- **Kubernetes.** Apply the kustomization, which needs the Prometheus Operator and Grafana's dashboard sidecar (see [Kubernetes](#kubernetes)). Use the unpacked release archive or the remote base `https://github.com/jamesainslie/libo11y//ops?ref=ops/v0.1.0`.

To check a downloaded archive, run `sha256sum -c SHA256SUMS` (or `shasum -a 256 -c SHA256SUMS`) next to it.

## Dashboards

The generated dashboards are in `dashboards/`. Each is plain Grafana JSON for Grafana 11.0 or later.

| Dashboard | UID | What it shows |
|---|---|---|
| libo11y RUM: overview | `libo11y-rum-overview` | Views per minute, errors and frustrations per 100 views, the p75 and rating share of LCP, INP and CLS, and the busiest views. |
| libo11y RUM: web vitals | `libo11y-rum-vitals` | LCP, INP, CLS, FCP and TTFB at the 75th percentile over time and by view, device class, browser and country. |
| libo11y RUM: errors and frustration | `libo11y-rum-errors` | Error and frustration rates from the derived metrics, and from Loki the error inbox, the most frustrated elements and the sessions behind them. |
| libo11y RUM: session explorer | `libo11y-rum-session-explorer` | One session rebuilt from its Loki events and Tempo traces by `session.id`, and one of its views by `o11y.rum.view.id`. |
| libo11y RUM: gateway | `libo11y-rum-gateway` | The gateway's own telemetry: requests by outcome and signal, rejections and dropped records by reason, attributes the policy removed, sink latency and outcomes, the derived metric aggregator, symbolicated frames and source map uploads. |

The session explorer is a dashboard, not an app. It shows one session at a time, by the `session.id` you paste or follow from the errors dashboard, and it cannot list sessions. Its events come from Loki, so they exist only for sessions the sampler kept. Its traces come from Tempo, and a fetch span's backend children share its trace, so backend spans come with them. "Select this view" on a row of 'Views in this session' fills `view_id` and shows that view's spans and events.

The Prometheus panels count every consented session, because the gateway derives the metrics from view summaries. Error and frustration events reach Loki only for sessions the sampler kept, so the errors dashboard's Loki panels say so in their descriptions.

### Variables

- `prometheus`, `loki` and `tempo` pick the datasources. No datasource UID is written into a dashboard.
- `app` filters by `service_name` on every Prometheus and Loki panel. The derived metrics carry `service.name` as the `service_name` label, and Loki indexes it as its only stream label. On the errors dashboard and the session explorer, which read Loki, `app` lists the apps that post RUM (`o11y_rum_views_total`) and All selects exactly those, so a Loki panel never reads every stream in Loki. The list covers the dashboard's time range, so it needs the gateway's derived metrics in Prometheus for that range: with no views there, it is empty and the Loki panels show nothing. Keep Prometheus at least as long as Loki to explore old sessions. The session explorer's Tempo panels select by `session.id` alone.
- `platform` filters by `o11y_rum_platform` on the overview and the errors dashboard. `view` filters by `o11y_rum_view_name` on the web vitals and errors dashboards. Both apply only to Prometheus panels whose metric carries the label. The overview's vitals and long animation frame panels ignore `platform` and say so in their descriptions. The errors dashboard's Loki panels ignore both.
- The web vitals dashboard also has `device`, `browser`, `country` and `connection`.
- `session_id` and `view_id` are text boxes on the session explorer. Its queries read them as Loki structured metadata after the stream selector, and as span attributes in Tempo.
- The gateway dashboard has `gateway`, which picks scrape jobs that export `o11yrum_batches_total`, and its own `app`, which filters by the gateway's `o11yrum_app` label. Sink and aggregator panels carry no app label, so they ignore `app` and say so. Requests the gateway refuses before it knows their app, rate limited ones included, count under app `unknown`.

Labels the specification makes required on a metric (`service.name`, `o11y.rum.platform`) use `.+` as the All value. Optional labels (device class, browser family, effective connection, country, and the view name) use `.*`, so a series without the label still counts when its variable is at All.

## Recording rules

`alerts/libo11y-rum.rules.yaml` starts with the group `libo11y-rum-recording`, evaluated every minute. The alerts read these series, so a check against the same hour a week ago stays cheap. The dashboards query the raw series and work without them.

| Series | What it holds |
|---|---|
| `service_name:<vital>:p75_rate1h` | The p75 of each vital over the last hour, by app. `<vital>` is the histogram family, such as `o11y_rum_vital_lcp_seconds`. |
| `service_name:<vital>_count:increase1h` | The vital's samples over the last hour, by app. |
| `service_name:o11y_rum_views:increase15m` | Views over the last 15 minutes, by app. |
| `service_name:o11y_rum_errors:increase15m` | Errors over the last 15 minutes, by app. |

## Alerts

The RUM alerts are in `alerts/libo11y-rum.rules.yaml` and the gateway alerts in `alerts/libo11y-rum-gateway.rules.yaml`. The numbers below are the defaults from `thresholds.yaml`. Every alert has a `severity` label (`critical`, `warning` or `info`) and the annotations `summary`, `description`, `runbook_url` (the heading below) and `dashboard` (the path of the dashboard to open). The annotations never include the alert's value, so the promtool unit tests in `alerts/tests/` compare them exactly. The value is on the linked dashboard.

The vital alerts carry a `vital` label naming the vital. They fire only when the app sent at least 200 samples of that vital in the last hour (`min_views_per_hour`), so a quiet app or a quiet hour does not page anyone over a handful of slow devices.

### O11yRUMVitalPoor

A vital's p75 over the last hour has been above the specification's poor bound for 30 minutes: LCP 4 s, INP 0.5 s, CLS 0.25, FCP 3 s, TTFB 1.8 s. Severity `warning`. Dashboard: web vitals.

1. Open the web vitals dashboard for the app and find the view, device class, browser or country that moved. A single slow view usually points at a page change, every view at a backend or CDN change.
2. Compare the start of the rise with recent releases of the app and its backends.
3. For LCP, FCP and TTFB, check `TTFB p75 by view` first: a slow server response delays everything after it.

### O11yRUMVitalRegression

A vital's p75 over the last hour is more than 1.25 times its p75 in the same hour a week ago, and above the good bound, for an hour. Both hours need at least 200 samples. Comparing with the same hour a week ago allows for daily and weekly traffic patterns. Severity `warning`. Dashboard: web vitals.

1. Set the web vitals dashboard to the last 8 days and find when the p75 moved.
2. Check releases of the app, its third-party scripts and its backends around that time.
3. Check whether the traffic mix changed, such as more mobile devices or a new country, using the device class, browser and country panels.

### O11yRUMErrorRateHigh

The app reported more than 0.1 errors per view over the last 15 minutes, with at least 50 views, for 15 minutes. Severity `warning`. Dashboard: errors and frustration.

1. Open the errors dashboard and look at `Errors per 100 views by source`. A rise in `network` or `resource` points at a backend or CDN, `uncaught` and `unhandled_rejection` at the app's code.
2. Open the error inbox to find the fingerprint that grew, and the sessions behind it in the session explorer.
3. Compare the start with the app's latest release.

### O11yRUMGatewayRejections

More than 5% of the requests to one gateway were rejected over the last 10 minutes, for reasons other than rate limiting and sink failures, for 15 minutes. The gateway must take at least 0.05 requests a second. The gateway refuses these requests with a 4xx status, so their telemetry never reaches the sinks. Severity `warning`. Dashboard: gateway.

The alert is per gateway, not per app. The gateway learns a request's app only after it decodes the body, so it counts every request refused before that (for `client_address`, `method`, `content_type`, `content_encoding`, `too_large`, `decompressed_too_large`, `decode`, `mixed_service`, `missing_service` or `unknown_service`) under app `unknown`. Only `disabled`, `origin` and `client_token` rejections name the app.

1. Open `Rejections by reason` on the gateway dashboard. `origin` means the page's origin is missing from the app's `origins`, or the request had no `Origin` header and the app does not allow that. `client_token` means a token mismatch, `unknown_service` a `service.name` the gateway has no app for, and `disabled` an app switched off in the configuration.
2. For `decode`, `too_large`, `decompressed_too_large`, `content_type` or `content_encoding`, check which client library version the app ships.
3. Check whether the gateway's configuration changed recently.

### O11yRUMGatewayRateLimited

More than 20% of the requests to one gateway were refused by its per-client rate limit over the last 10 minutes, for 15 minutes. The gateway must take at least 0.05 requests a second. The rate limit runs before the gateway reads the body, so these requests count under app `unknown`, and the alert is per gateway. Severity `info`. Dashboard: gateway.

1. Check whether the traffic is real: a launch or a campaign raises the request rate for every client.
2. Check for a client in a loop, such as a page that reloads itself or retries without backing off.
3. If the traffic is real, raise the rate limit in the gateway's configuration.

### O11yRUMGatewaySinkFailing

More than 1% of the requests to a gateway failed in a sink over the last 5 minutes, for 5 minutes. The gateway must take at least 0.05 requests a second. The gateway answers them with 503 and a Retry-After header, so a short outage loses little, but a sink that stays down loses telemetry. Severity `critical`. Dashboard: gateway.

1. Open `Sink exports by outcome` to see which sink fails.
2. Check the backend behind that sink, such as the collector, and the network path to it.
3. Read the gateway's logs for the export error.

### O11yRUMGatewaySinkSlow

The p99 of one export to a sink has been above 2 s for 10 minutes. Slow exports hold requests open and can turn into sink failures. Severity `warning`. Dashboard: gateway.

1. Open `Sink latency` to see which sink is slow and whether the median moved too.
2. Check the load and latency of the backend behind the sink.
3. Check whether the request rate rose at the same time.

### O11yRUMAggregatorNearCap

A derived metric has held more than 1800 attribute sets for 30 minutes. Each app may hold `aggregation.max_series_per_metric` (default 2000) attribute sets in one metric. Past that, new attribute sets go to the overflow series, marked `otel.metric.overflow=true`, and lose their labels. The gauge sums every app, so with several apps it can fire before any one app reaches the cap. Severity `warning`. Dashboard: gateway.

1. Open `Aggregator series by metric` to see which metric grows.
2. Check the view names the app reports. A view name that holds an ID instead of a route template is the usual cause.
3. If the cardinality is real, raise `aggregation.max_series_per_metric`, and the warning level in `thresholds.yaml` with it.

### O11yRUMGatewayDown

Prometheus has failed to scrape a gateway for 5 minutes. The alert sees only gateways Prometheus scrapes: `up` exists only for scrape targets, so a gateway that pushes its metrics over OTLP needs its own absence check. Severity `critical`. Dashboard: gateway.

1. Check the gateway's pods or processes, and their restarts.
2. Check that the gateway still exports to Prometheus: `OTEL_METRICS_EXPORTER` must select the Prometheus reader.
3. Check the ServiceMonitor or scrape configuration, and the network path from Prometheus.

## Thresholds

`thresholds.yaml` holds every threshold, minimum traffic and the gateway selector the rules use. The vital bounds default to the specification's rating table. To use your own values, copy the file, change it, and generate the pack:

```sh
go run github.com/jamesainslie/libo11y/ops/cmd/opsgen@ops/v0.1.0 -thresholds my-thresholds.yaml -out my-pack/
```

`min_views_per_hour` sets two gates: the vital alerts need that many samples of the vital an hour, and the error rate alert needs a quarter of it in views over 15 minutes, never less than one view. `opsgen` parses every rule it generates and refuses thresholds that produce PromQL Prometheus would not load.

`gateway_selector` is the label matcher every gateway alert uses. The default, `job=~"(.*/)?o11yrum-gateway"`, matches a job named `o11yrum-gateway` and a namespaced job such as `monitoring/o11yrum-gateway`, the name a PodMonitor gives.

## Kubernetes

`kustomization.yaml` packages the pack for a cluster that runs the Prometheus Operator and Grafana's dashboard sidecar:

- `kubernetes/prometheusrule.yaml` is one `PrometheusRule` with the same groups as the rule files.
- Each dashboard becomes a ConfigMap labelled `grafana_dashboard: "1"`, the label the sidecar watches by default.

Every object carries `app.kubernetes.io/part-of: libo11y`. The PrometheusRule is named `libo11y-rum`, and each ConfigMap is named after its dashboard's UID with no hash suffix. The pack sets no namespace and no operator-specific labels. Add them in your own overlay. With kube-prometheus-stack, whose Prometheus selects rules by its `release` label:

```yaml
# overlays/kube-prometheus-stack/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: monitoring
resources:
  - https://github.com/jamesainslie/libo11y//ops?ref=ops/v0.1.0
labels:
  - pairs:
      release: kube-prometheus-stack
    includeSelectors: false
```

`datasources/example.yaml` shows Grafana datasource provisioning for Prometheus, Loki and Tempo, with Tempo's link from traces to logs. The dashboards pick datasources through their variables, so its UIDs are a convenience, not a requirement.

## How the pack is tested

- A catalog test builds `o11yrum-gateway` from this checkout, sends it one fixture RUM session, uploads a source map and sends a symbolicated error, scrapes its Prometheus endpoint and compares every metric family and label name with `internal/catalog/testdata/exported.txt`. Refresh that file with `go test ./internal/catalog/ -run TestGatewayExports -update`, never by hand.
- A lint package parses every PromQL expression with the Prometheus parser and checks each metric and label against that catalog. LogQL and TraceQL queries are checked for structure: `session_id` and `o11y_rum_view_id` are Loki structured metadata, so they appear only after the stream selector and never as stream labels.
- A drift test fails when the committed artifacts differ from what the generator produces. Run `make ops-generate` from the repository root to regenerate them.
- promtool 3.15.1 checks the rule files and runs the unit tests in `alerts/tests/`, which are written by hand and work out each expected p75 in a comment. `scripts/ops-promtool.sh` downloads promtool on first use and refuses a tarball whose SHA-256 differs from the pinned one. It has pins for Linux and macOS on amd64 and arm64, caches the binary under `${XDG_CACHE_HOME:-~/.cache}/libo11y/`, and takes `OPS_PROMTOOL_BASE_URL` for a mirror, whose tarball must still match the pin.
- `kubectl kustomize ops` renders the kustomization.
- `make ops-integration`, which CI runs in the `ops-integration` job, starts Loki 3.7.10, Tempo 3.1.1, Prometheus 3.15.1, Grafana 13.3.1 and an OpenTelemetry Collector in Docker Compose (`test/compose.yaml`), behind the gateway built from this checkout. Grafana provisions `datasources/example.yaml` and `dashboards/`, and Prometheus loads `alerts/`. The test sends three fixture sessions and runs every panel query through Grafana's query API. It requires data in the panels the fixture covers and checks that Loki never indexes `session_id` or `o11y_rum_view_id` and that Prometheus loads every rule with health `ok`. In headless Chrome it checks that the explorer's view link percent-encodes the view ID once and that its app variable lists the app. It needs Docker and Chrome or Chromium, starts five containers with memory limits, and always tears them down.

Run every check with `make ops-check` from the repository root. It needs `kubectl`, and the first time it downloads promtool it needs network access, `curl`, `tar`, and `sha256sum` or `shasum`. `make ops-promtool-test` tests the promtool installer itself.

## The release archive

Each `ops/vX.Y.Z` tag publishes the GitHub Release `libo11y-ops vX.Y.Z`, never marked Latest, with `libo11y-ops-vX.Y.Z.tar.gz` and `SHA256SUMS`. The archive unpacks into `libo11y-ops-vX.Y.Z/` with `dashboards/`, `alerts/` (the rule files and their promtool tests), `kubernetes/`, `datasources/`, `kustomization.yaml`, `thresholds.yaml`, this README, the changelog and the repository's `LICENSE`. It leaves out the Go module that generates the pack and the integration environment in `test/`. `scripts/ops-release-check.sh` builds it and checks it before a release (`make ops-release-check`), and the release workflow attaches the same archive.
