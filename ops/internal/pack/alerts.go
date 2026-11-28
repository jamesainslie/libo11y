package pack

import (
	"math"
	"strconv"
	"strings"

	"github.com/jamesainslie/libo11y/ops/internal/rules"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// The recorded series the RUM alerts read. Dashboards query the raw series,
// so they work without these rules.
func recordedP75(family string) string   { return "service_name:" + family + ":p75_rate1h" }
func recordedCount(family string) string { return "service_name:" + family + "_count:increase1h" }

const (
	recordedViews  = "service_name:o11y_rum_views:increase15m"
	recordedErrors = "service_name:o11y_rum_errors:increase15m"
)

// The rule files' paths, relative to ops/.
const (
	rumRulesPath     = "alerts/libo11y-rum.rules.yaml"
	gatewayRulesPath = "alerts/libo11y-rum-gateway.rules.yaml"
)

// rumRules is alerts/libo11y-rum.rules.yaml: the recording group, then the
// vital and error rate alerts.
func rumRules(t thresholds.Thresholds, version string) rules.File {
	rec := rules.Group{Name: "libo11y-rum-recording", Interval: "1m"}
	for _, v := range vitalDefs {
		rec.Rules = append(rec.Rules,
			rules.Rule{Record: recordedP75(v.Family), Expr: `histogram_quantile(0.75, sum by (service_name, le) (rate(` + v.Family + `_bucket[1h])))`},
			rules.Rule{Record: recordedCount(v.Family), Expr: `sum by (service_name) (increase(` + v.Family + `_count[1h]))`},
		)
	}
	rec.Rules = append(rec.Rules,
		rules.Rule{Record: recordedViews, Expr: `sum by (service_name) (increase(o11y_rum_views_total[15m]))`},
		rules.Rule{Record: recordedErrors, Expr: `sum by (service_name) (increase(o11y_rum_errors_total[15m]))`},
	)

	minViews := num(float64(t.MinViewsPerHour))
	alerts := rules.Group{Name: "libo11y-rum-alerts"}
	for _, v := range vitalDefs {
		bounds := t.Vitals[v.Key]
		unit := ""
		if v.Unit == "s" {
			unit = " s"
		}
		p75, count := recordedP75(v.Family), recordedCount(v.Family)
		labels := func() map[string]string { return map[string]string{"severity": "warning", "vital": v.Key} }
		alerts.Rules = append(alerts.Rules,
			rules.Rule{
				Alert: "O11yRUMVitalPoor",
				Expr: lines(
					p75+" > "+num(bounds.Poor),
					"and on (service_name) "+count+" >= "+minViews,
				),
				For:    "30m",
				Labels: labels(),
				Annotations: annotations(version, "O11yRUMVitalPoor", "libo11y-rum-vitals",
					v.Label+" p75 is poor for {{ $labels.service_name }}",
					"The "+v.Label+" p75 over the last hour has been above "+num(bounds.Poor)+unit+" for 30 minutes, with at least "+minViews+" samples an hour."),
			},
			rules.Rule{
				Alert: "O11yRUMVitalRegression",
				Expr: lines(
					p75+" > "+num(t.RegressionRatio)+" * ("+p75+" offset 7d)",
					"and "+p75+" > "+num(bounds.Good),
					"and on (service_name) "+count+" >= "+minViews,
					"and on (service_name) ("+count+" offset 7d) >= "+minViews,
				),
				For:    "1h",
				Labels: labels(),
				Annotations: annotations(version, "O11yRUMVitalRegression", "libo11y-rum-vitals",
					v.Label+" p75 regressed for {{ $labels.service_name }}",
					"The "+v.Label+" p75 over the last hour is more than "+num(t.RegressionRatio)+" times the same hour a week ago and above the good bound of "+num(bounds.Good)+unit+"."),
			},
		)
	}
	// At least one view, so a minimum of 0 never divides by zero views.
	minViews15m := num(math.Max(float64(t.MinViewsPerHour)/4, 1))
	alerts.Rules = append(alerts.Rules, rules.Rule{
		Alert: "O11yRUMErrorRateHigh",
		Expr: lines(
			recordedErrors+" / "+recordedViews+" > "+num(t.ErrorsPerView),
			"and on (service_name) "+recordedViews+" >= "+minViews15m,
		),
		For:    "15m",
		Labels: map[string]string{"severity": "warning"},
		Annotations: annotations(version, "O11yRUMErrorRateHigh", "libo11y-rum-errors",
			"Error rate is high for {{ $labels.service_name }}",
			"The app reported more than "+num(t.ErrorsPerView)+" errors per view over the last 15 minutes, with at least "+minViews15m+" views."),
	})
	return rules.File{Groups: []rules.Group{rec, alerts}}
}

// gatewayRules is alerts/libo11y-rum-gateway.rules.yaml. Every selector
// carries the thresholds' gateway selector.
func gatewayRules(t thresholds.Thresholds, version string) rules.File {
	gs := t.GatewaySelector
	batches := func(extra string) string {
		if extra != "" {
			extra = ", " + extra
		}
		return `o11yrum_batches_total{` + gs + extra + `}`
	}
	// share is the fraction of requests matching extra over window, by job
	// and app. The alerts pair it with gate, the minimum request rate.
	share := func(extra, window string) string {
		by := "sum by (job, o11yrum_app) "
		total := by + "(rate(" + batches("") + "[" + window + "]))"
		return lines(
			"(",
			"  "+by+"(rate("+batches(extra)+"["+window+"]))",
			"/",
			"  "+total,
			")",
		)
	}
	minRate := num(t.GatewayMinRequestsPerSec)
	gate := "and on (job, o11yrum_app) sum by (job, o11yrum_app) (rate(" + batches("") + "[10m])) > " + minRate
	alert := func(name, expr, forDur, severity, summary, description string) rules.Rule {
		return rules.Rule{
			Alert: name, Expr: expr, For: forDur,
			Labels:      map[string]string{"severity": severity},
			Annotations: annotations(version, name, gatewayUID, summary, description),
		}
	}
	g := rules.Group{Name: "libo11y-rum-gateway-alerts", Rules: []rules.Rule{
		alert("O11yRUMGatewayRejections",
			lines(share(`o11yrum_outcome="rejected", o11yrum_reason!~"rate_limited|sink"`, "10m")+" > "+num(t.GatewayRejectionRatio), gate),
			"15m", "warning",
			"The gateway is rejecting requests for {{ $labels.o11yrum_app }}",
			"More than "+percent(t.GatewayRejectionRatio)+" of the requests for {{ $labels.o11yrum_app }} to {{ $labels.job }} were rejected over the last 10 minutes, for reasons other than rate limiting and sink failures."),
		alert("O11yRUMGatewayRateLimited",
			lines(share(`o11yrum_outcome="rejected", o11yrum_reason="rate_limited"`, "10m")+" > "+num(t.RateLimitedRatio), gate),
			"15m", "info",
			"The gateway is rate limiting {{ $labels.o11yrum_app }}",
			"More than "+percent(t.RateLimitedRatio)+" of the requests for {{ $labels.o11yrum_app }} to {{ $labels.job }} were refused by the per-client rate limit over the last 10 minutes."),
		alert("O11yRUMGatewaySinkFailing",
			lines(
				"sum by (job) (rate("+batches(`o11yrum_outcome="rejected", o11yrum_reason="sink"`)+"[5m]))",
				"/",
				"sum by (job) (rate("+batches("")+"[5m]))",
				"> "+num(t.SinkFailureRatio),
				"and on (job) sum by (job) (rate("+batches("")+"[5m])) > "+minRate,
			),
			"5m", "critical",
			"{{ $labels.job }} cannot export to its sinks",
			"More than "+percent(t.SinkFailureRatio)+" of the requests to {{ $labels.job }} failed in a sink over the last 5 minutes. The gateway answers them with 503 and Retry-After, so a short outage loses little, but a sink that stays down loses telemetry."),
		alert("O11yRUMGatewaySinkSlow",
			"histogram_quantile(0.99, sum by (job, o11yrum_sink, le) (rate(o11yrum_sink_duration_seconds_bucket{"+gs+"}[10m]))) > "+num(t.SinkP99Seconds),
			"10m", "warning",
			"Sink {{ $labels.o11yrum_sink }} is slow on {{ $labels.job }}",
			"The p99 of one export to sink {{ $labels.o11yrum_sink }} has been above "+num(t.SinkP99Seconds)+" s for 10 minutes."),
		alert("O11yRUMAggregatorNearCap",
			"max by (job, o11yrum_metric) (o11yrum_aggregator_series{"+gs+"}) > "+num(float64(t.AggregatorSeriesWarn)),
			"30m", "warning",
			"Derived metric {{ $labels.o11yrum_metric }} is near its series cap on {{ $labels.job }}",
			"Derived metric {{ $labels.o11yrum_metric }} has held more than "+num(float64(t.AggregatorSeriesWarn))+" attribute sets for 30 minutes. Each app may hold aggregation.max_series_per_metric (default 2000) attribute sets in one metric before new ones go to the overflow series. The gauge sums every app, so with several apps it can fire before any one app reaches the cap."),
		alert("O11yRUMGatewayDown",
			"up{"+gs+"} == 0",
			"5m", "critical",
			"Prometheus cannot scrape {{ $labels.job }}",
			"The scrape of {{ $labels.instance }} in job {{ $labels.job }} has failed for 5 minutes. The alert sees only gateways Prometheus scrapes: up exists only for scrape targets, so a gateway that pushes its metrics over OTLP needs its own absence check."),
	}}
	return rules.File{Groups: []rules.Group{g}}
}

// annotations are the four every alert carries. The runbook is the alert's
// heading in ops/README.md at the release tag.
func annotations(version, alert, uid, summary, description string) map[string]string {
	return map[string]string{
		"summary":     summary,
		"description": description,
		"runbook_url": "https://github.com/jamesainslie/libo11y/blob/ops/v" + version + "/ops/README.md#" + strings.ToLower(alert),
		"dashboard":   "/d/" + uid,
	}
}

func lines(l ...string) string { return strings.Join(l, "\n") }

// num formats a threshold the shortest way that reads it back exactly.
func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// percent formats a ratio as a percentage, rounding away float noise such
// as 0.07 * 100 = 7.000000000000001.
func percent(ratio float64) string { return num(math.Round(ratio*100*1e6)/1e6) + "%" }
