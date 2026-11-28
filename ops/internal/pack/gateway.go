package pack

import (
	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// gatewayUID is the gateway dashboard's UID. The overview links to it,
// and every gateway alert names it.
const gatewayUID = "libo11y-rum-gateway"

// The gateway dashboard's selectors. selGateway follows the gateway
// picker on every series; selGatewayApp adds the app picker on the
// families that carry o11yrum_app.
const (
	selGateway    = `job=~"$gateway"`
	selGatewayApp = selGateway + `, o11yrum_app=~"$app"`
)

// gatewayDashboard shows the gateway's own telemetry: the requests it
// takes and refuses, what validation and the attribute policy remove, its
// sinks, the derived metric aggregator, and symbolication.
func gatewayDashboard(t thresholds.Thresholds) dash.Dashboard {
	batches := `o11yrum_batches_total{` + selGatewayApp + `}`
	rejected := `o11yrum_batches_total{` + selGatewayApp + `, o11yrum_outcome="rejected"}`
	sinkBuckets := `o11yrum_sink_duration_seconds_bucket{` + selGateway + `}`
	rate := func(series string) string { return `rate(` + series + `[$__rate_interval])` }
	byRate := func(by, series string) string { return `sum by (` + by + `) (` + rate(series) + `)` }
	sinkQuantile := func(q string) string {
		return `histogram_quantile(` + q + `, sum by (le, o11yrum_sink) (` + rate(sinkBuckets) + `))`
	}
	amber, red := t.GatewayRejectionRatio, 2*t.GatewayRejectionRatio
	sinkSlow := t.SinkP99Seconds

	row1 := []dash.Panel{
		{
			Type: "stat", Title: "Requests per second", W: 6, H: 4, Datasource: &dash.Prometheus,
			Description: "OTLP requests the gateway handled per second, averaged over the time range, whatever their outcome.",
			Targets:     []dash.Target{dash.PromRange("A", `sum(`+rate(batches)+`)`, "")},
			Unit:        "reqps", Options: statOptions("mean"),
		},
		{
			Type: "stat", Title: "Rejected share", W: 6, H: 4, Datasource: &dash.Prometheus,
			Description: "The share of requests the gateway refused over the time range, for any reason. Rejections by reason below tells a misconfigured origin from rate limiting or a failing sink. Requests refused before the gateway knows their app count under app unknown, so pick All to see every rejection.",
			Targets:     []dash.Target{promValue(`sum(increase(`+rejected+`[$__range])) / sum(increase(`+batches+`[$__range]))`, "")},
			Unit:        "percentunit",
			Thresholds:  []dash.Step{{Color: "green"}, {Color: "orange", Value: &amber}, {Color: "red", Value: &red}},
			Options:     statOptions("lastNotNull"),
		},
		{
			Type: "stat", Title: "Sink p99", W: 6, H: 4, Datasource: &dash.Prometheus,
			Description: "The 99th percentile of one export to a sink over the time range, across every sink. The app picker does not apply: sink exports carry no app label.",
			Targets:     []dash.Target{promValue(`histogram_quantile(0.99, sum by (le) (increase(`+sinkBuckets+`[$__range])))`, "")},
			Unit:        "s",
			Thresholds:  []dash.Step{{Color: "green"}, {Color: "red", Value: &sinkSlow}},
			Options:     statOptions("lastNotNull"),
		},
		{
			Type: "stat", Title: "Aggregator series", W: 6, H: 4, Datasource: &dash.Prometheus,
			Description: "Attribute sets the derived metric aggregator holds now, across every metric and app. The app picker does not apply.",
			Targets:     []dash.Target{promValue(`sum(o11yrum_aggregator_series{`+selGateway+`})`, "")},
			Unit:        "short", Options: statOptions("lastNotNull"),
		},
	}

	timeseries := func(title, desc, expr, legend, unit string) dash.Panel {
		return dash.Panel{
			Type: "timeseries", Title: title, Description: desc, W: 12, Datasource: &dash.Prometheus,
			Targets: []dash.Target{dash.PromRange("A", expr, legend)},
			Unit:    unit, Options: legendBottom(),
		}
	}

	return dash.Dashboard{
		UID:         gatewayUID,
		Title:       "libo11y RUM: gateway",
		Description: "The o11yrum gateway's own telemetry: requests, rejections, validation, sinks, the derived metric aggregator and symbolication.",
		Tags:        []string{"rum", "gateway"},
		Variables:   []dash.Variable{varProm, varGateway, varGatewayApp},
		Links: []dash.Link{
			{Title: "Overview", URL: "/d/libo11y-rum-overview?${__url_time_range}"},
		},
		Rows: [][]dash.Panel{
			row1,
			{
				timeseries("Requests by outcome", "Requests per second by outcome: accepted, partial (some records dropped by validation) or rejected.",
					byRate("o11yrum_outcome", batches), "{{o11yrum_outcome}}", "reqps"),
				timeseries("Requests by signal", "Requests per second by OTLP signal.",
					byRate("o11yrum_signal", batches), "{{o11yrum_signal}}", "reqps"),
			},
			{
				timeseries("Rejections by reason", "Refused requests per second by reason. origin and client_token point at configuration, rate_limited at a busy client, sink at a failing backend. Requests refused before the gateway knows their app, rate limited ones included, count under app unknown.",
					byRate("o11yrum_reason", rejected), "{{o11yrum_reason}}", "reqps"),
				timeseries("Records dropped by reason", "Records validation removed from accepted requests, per second, by reason.",
					byRate("o11yrum_reason", `o11yrum_records_dropped_total{`+selGatewayApp+`}`), "{{o11yrum_reason}}", "cps"),
			},
			{
				{
					Type: "timeseries", Title: "Sink latency", W: 12, Datasource: &dash.Prometheus,
					Description: "The median and 99th percentile of one export, by sink. The app picker does not apply.",
					Targets: []dash.Target{
						dash.PromRange("A", sinkQuantile("0.5"), "p50 {{o11yrum_sink}}"),
						dash.PromRange("B", sinkQuantile("0.99"), "p99 {{o11yrum_sink}}"),
					},
					Unit: "s", Thresholds: []dash.Step{{Color: "green"}, {Color: "red", Value: &sinkSlow}},
					Custom: map[string]any{"thresholdsStyle": map[string]any{"mode": "line"}}, Options: legendBottom(),
				},
				timeseries("Sink exports by outcome", "Exports per second by sink and outcome. The app picker does not apply.",
					`sum by (o11yrum_sink, o11yrum_outcome) (`+rate(`o11yrum_sink_duration_seconds_count{`+selGateway+`}`)+`)`,
					"{{o11yrum_sink}} {{o11yrum_outcome}}", "ops"),
			},
			{
				timeseries("Attributes removed by policy", "Attributes the attribute policy removed per second, by app: o11y.* keys the specification does not define, and keys past the limits.",
					byRate("o11yrum_app", `o11yrum_attributes_removed_total{`+selGatewayApp+`}`), "{{o11yrum_app}}", "cps"),
				timeseries("Aggregator series by metric", "Attribute sets each derived metric holds, summed across apps. Each app may hold aggregation.max_series_per_metric (default 2000) in one metric before its measurements go to the overflow series. The app picker does not apply.",
					`sum by (o11yrum_metric) (o11yrum_aggregator_series{`+selGateway+`})`, "{{o11yrum_metric}}", "short"),
			},
			{
				timeseries("Symbolicated frames by result", "Stack frames symbolication handled per second: hit (resolved), unmapped (no mapping at the position), miss (no map for the script), error (the map could not be read) and skipped (no release, or over a batch's budget). A rise in miss usually means a release went out before its maps were uploaded.",
					byRate("o11yrum_result", `o11yrum_symbolication_frames_total{`+selGatewayApp+`}`), "{{o11yrum_result}}", "cps"),
				{
					Type: "table", Title: "Source map uploads by outcome", W: 12, Datasource: &dash.Prometheus,
					Description: "Source map uploads over the time range, by app and outcome. unauthorized uploads name app unknown when the service is not configured.",
					Targets: []dash.Target{dash.PromInstant("A",
						`sum by (o11yrum_app, o11yrum_outcome) (increase(o11yrum_sourcemaps_uploads_total{`+selGatewayApp+`}[$__range]))`, "")},
					Overrides: []any{rename("Value", "uploads")}, Transforms: []any{hideTime()}, Options: sortedTable("uploads"),
				},
			},
		},
	}
}
