package pack

import (
	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

const overviewNote = `**About these numbers.** The gateway derives every metric here from the view summaries of every consented session, so the counts include sessions the trace sampler did not keep. Each vital is reported once per view, as the specification's "Once per view" rule says, so a p75 here can differ from CrUX, which samples differently.`

// overview is the RUM front page: traffic, error and frustration rates,
// and the three Core Web Vitals for the selected apps.
func overview(t thresholds.Thresholds) dash.Dashboard {
	views := `o11y_rum_views_total{` + selApp + `, ` + selPlatform + `}`
	errs := `o11y_rum_errors_total{` + selApp + `, ` + selPlatform + `}`
	frus := `o11y_rum_frustrations_total{` + selApp + `, ` + selPlatform + `}`
	per100 := func(series string) string {
		return `100 * (sum(increase(` + series + `[$__range])) or vector(0)) / sum(increase(` + views + `[$__range]))`
	}
	byRate := func(by, series string) string {
		return `sum by (` + by + `) (rate(` + series + `[$__rate_interval]))`
	}

	row1 := []dash.Panel{
		{
			Type: "stat", Title: "Views per minute", W: 4, H: 4, Datasource: &dash.Prometheus,
			Description: "Views started per minute, averaged over the time range.",
			Targets:     []dash.Target{dash.PromRange("A", `sum(rate(`+views+`[$__rate_interval])) * 60`, "")},
			Unit:        "short", Options: statOptions("mean"),
		},
		{
			Type: "stat", Title: "Errors per 100 views", W: 4, H: 4, Datasource: &dash.Prometheus,
			Description: "Errors over the time range for every 100 views.",
			Targets:     []dash.Target{promValue(per100(errs), "")},
			Unit:        "short", Options: statOptions("lastNotNull"),
		},
		{
			Type: "stat", Title: "Frustrations per 100 views", W: 4, H: 4, Datasource: &dash.Prometheus,
			Description: "Frustration signals (rage, dead and error clicks) over the time range for every 100 views.",
			Targets:     []dash.Target{promValue(per100(frus), "")},
			Unit:        "short", Options: statOptions("lastNotNull"),
		},
	}
	for _, v := range vitalDefs[:3] {
		row1 = append(row1, dash.Panel{
			Type: "stat", Title: v.Label + " p75", W: 4, H: 4, Datasource: &dash.Prometheus,
			Description: "The 75th percentile of " + v.Label + " over the time range, colored by the specification's rating thresholds. Vitals carry no platform label, so this panel ignores the platform picker.",
			Targets:     []dash.Target{promValue(`histogram_quantile(0.75, sum by (le) (increase(`+v.Family+`_bucket{`+selApp+`}[$__range])))`, "")},
			Unit:        v.Unit, Thresholds: vitalSteps(t, v.Key), Options: statOptions("lastNotNull"),
		})
	}

	row2 := []dash.Panel{
		{
			Type: "timeseries", Title: "Views by platform", W: 8, Datasource: &dash.Prometheus,
			Targets: []dash.Target{dash.PromRange("A", byRate("o11y_rum_platform", views), "{{o11y_rum_platform}}")},
			Unit:    "short", Options: legendBottom(),
		},
		{
			Type: "timeseries", Title: "Views by kind", W: 8, Datasource: &dash.Prometheus,
			Targets: []dash.Target{dash.PromRange("A", byRate("o11y_rum_view_kind", views), "{{o11y_rum_view_kind}}")},
			Unit:    "short", Options: legendBottom(),
		},
		{
			Type: "timeseries", Title: "Long animation frames per view", W: 8, Datasource: &dash.Prometheus,
			Description: "Long animation frames (50 ms or longer) for each browser view, a sign of a busy main thread. Only browsers report them, and the metric has no platform label, so this panel ignores the platform picker.",
			Targets: []dash.Target{dash.PromRange("A",
				`sum(rate(o11y_rum_browser_long_animation_frames_total{`+selApp+`}[$__rate_interval])) / sum(rate(o11y_rum_views_total{`+selApp+`, `+selBrowser+`}[$__rate_interval]))`,
				"frames per view")},
			Unit: "short", Options: legendBottom(),
		},
	}

	row3 := []dash.Panel{
		{
			Type: "timeseries", Title: "Errors by source", W: 12, Datasource: &dash.Prometheus,
			Targets: []dash.Target{dash.PromRange("A", byRate("o11y_rum_error_source", errs), "{{o11y_rum_error_source}}")},
			Unit:    "short", Options: legendBottom(),
		},
		{
			Type: "timeseries", Title: "Frustrations by type", W: 12, Datasource: &dash.Prometheus,
			Targets: []dash.Target{dash.PromRange("A", byRate("o11y_rum_frustration_type", frus), "{{o11y_rum_frustration_type}}")},
			Unit:    "short", Options: legendBottom(),
		},
	}

	var row4 []dash.Panel
	for _, v := range vitalDefs[:3] {
		count := v.Family + `_count{` + selApp + `}`
		row4 = append(row4, dash.Panel{
			Type: "bargauge", Title: v.Label + " rating share", W: 8, Datasource: &dash.Prometheus,
			Description: "The share of " + v.Label + " samples the gateway rated good, needs-improvement and poor over the time range. Vitals carry no platform label, so this panel ignores the platform picker.",
			Targets: []dash.Target{promValue(
				`sum by (o11y_rum_vital_rating) (increase(`+count+`[$__range])) / scalar(sum(increase(`+count+`[$__range])))`,
				"{{o11y_rum_vital_rating}}")},
			Unit: "percentunit", Overrides: ratingColors(),
			Options: map[string]any{
				"orientation":   "horizontal",
				"displayMode":   "basic",
				"showUnfilled":  true,
				"reduceOptions": map[string]any{"calcs": []any{"lastNotNull"}, "fields": "", "values": false},
			},
		})
	}

	top := dash.Panel{
		Type: "table", Title: "Top views by traffic", W: 24, Datasource: &dash.Prometheus,
		Description: "The 20 busiest views over the time range. Open a row for that view's web vitals.",
		Targets:     []dash.Target{dash.PromInstant("A", `topk(20, sum by (service_name, o11y_rum_view_name) (increase(`+views+`[$__range])))`, "")},
		Overrides:   []any{rename("Value", "views")},
		Transforms:  []any{hideTime()},
		Options:     sortedTable("views"),
		Links: []dash.Link{{
			Title: "Vitals of this view",
			URL:   "/d/libo11y-rum-vitals?var-app=${__data.fields.service_name:percentencode}&var-view=${__data.fields.o11y_rum_view_name:percentencode}&${__url_time_range}",
		}},
	}

	return dash.Dashboard{
		UID:         "libo11y-rum-overview",
		Title:       "libo11y RUM: overview",
		Description: "Traffic, errors, frustration and Core Web Vitals derived by the o11yrum gateway.",
		Tags:        []string{"rum"},
		Variables:   []dash.Variable{varProm, varApp, varPlatform},
		Links: []dash.Link{
			{Title: "Web vitals", URL: "/d/libo11y-rum-vitals?${app:queryparam}&${__url_time_range}"},
			{Title: "Errors and frustration", URL: "/d/libo11y-rum-errors?${app:queryparam}&${platform:queryparam}&${__url_time_range}"},
			{Title: "Gateway", URL: "/d/libo11y-rum-gateway?${__url_time_range}"},
		},
		Rows: [][]dash.Panel{
			row1, row2, row3, row4,
			{top},
			{{Type: "text", Title: "About these numbers", W: 24, H: 3, Content: overviewNote}},
		},
	}
}
