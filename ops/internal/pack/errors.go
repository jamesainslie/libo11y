package pack

import (
	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// keptOnly is the caveat every Loki panel of the errors dashboard carries.
const keptOnly = " Error and frustration events reach Loki only for kept sessions, while the Prometheus panels count every consented session."

// errorsDashboard shows error and frustration rates from the derived
// metrics, and the events behind them from Loki.
func errorsDashboard(_ thresholds.Thresholds) dash.Dashboard {
	sel := selApp + `, ` + selPlatform + `, ` + selView
	views := `o11y_rum_views_total{` + sel + `}`
	per100 := func(by, series string) string {
		return `100 * sum by (` + by + `) (rate(` + series + `{` + sel + `}[$__rate_interval])) / scalar(sum(rate(` + views + `[$__rate_interval])))`
	}
	topViews := func(series string) string {
		return `topk(20, sum by (service_name, o11y_rum_view_name) (increase(` + series + `{` + sel + `}[$__range])))`
	}
	events := func(match string) string {
		return lokiApp + ` | event_name` + match
	}
	errEvents := events(`="o11y.rum.error"`)
	frusEvents := events(`="o11y.rum.frustration"`)
	bothEvents := events(`=~"o11y\\.rum\\.(error|frustration)"`)

	return dash.Dashboard{
		UID:         "libo11y-rum-errors",
		Title:       "libo11y RUM: errors and frustration",
		Description: "Error and frustration rates for every consented session, and the events of kept sessions from Loki.",
		Tags:        []string{"rum"},
		Variables:   []dash.Variable{varProm, varLoki, varApp, varPlatform, varView},
		Links: []dash.Link{
			{Title: "Overview", URL: "/d/libo11y-rum-overview?${app:queryparam}&${platform:queryparam}&${__url_time_range}"},
			{Title: "Session explorer", URL: "/d/libo11y-rum-session-explorer?${app:queryparam}&${__url_time_range}"},
		},
		Rows: [][]dash.Panel{
			{
				{
					Type: "timeseries", Title: "Errors per 100 views by source", W: 12, Datasource: &dash.Prometheus,
					Targets: []dash.Target{dash.PromRange("A", per100("o11y_rum_error_source", "o11y_rum_errors_total"), "{{o11y_rum_error_source}}")},
					Unit:    "short", Options: legendBottom,
				},
				{
					Type: "timeseries", Title: "Frustrations per 100 views by type", W: 12, Datasource: &dash.Prometheus,
					Targets: []dash.Target{dash.PromRange("A", per100("o11y_rum_frustration_type", "o11y_rum_frustrations_total"), "{{o11y_rum_frustration_type}}")},
					Unit:    "short", Options: legendBottom,
				},
			},
			{
				{
					Type: "table", Title: "Views with the most errors", W: 12, Datasource: &dash.Prometheus,
					Targets:   []dash.Target{dash.PromInstant("A", topViews("o11y_rum_errors_total"), "")},
					Overrides: []any{rename("Value", "errors")}, Transforms: []any{hideTime}, Options: sortedTable("errors"),
				},
				{
					Type: "table", Title: "Views with the most frustration", W: 12, Datasource: &dash.Prometheus,
					Targets:   []dash.Target{dash.PromInstant("A", topViews("o11y_rum_frustrations_total"), "")},
					Overrides: []any{rename("Value", "frustrations")}, Transforms: []any{hideTime}, Options: sortedTable("frustrations"),
				},
			},
			{
				{
					Type: "table", Title: "Error inbox (kept sessions)", W: 24, H: 10, Datasource: &dash.Loki,
					Description: "The 50 most frequent errors over the time range, grouped by fingerprint." + keptOnly,
					Targets: []dash.Target{dash.LokiInstant("A",
						`topk(50, sum by (o11y_rum_error_fingerprint, exception_type, o11y_rum_error_source) (count_over_time(`+errEvents+` [$__range])))`)},
					Overrides: []any{rename("Value #A", "events")}, Transforms: []any{hideTime}, Options: sortedTable("events"),
				},
			},
			{
				{
					Type: "table", Title: "Most frustrated elements (kept sessions)", W: 12, Datasource: &dash.Loki,
					Description: "The UI elements with the most frustration signals over the time range." + keptOnly,
					Targets: []dash.Target{dash.LokiInstant("A",
						`topk(20, sum by (o11y_rum_frustration_type, o11y_rum_element_selector) (count_over_time(`+frusEvents+` [$__range])))`)},
					Overrides: []any{rename("Value #A", "events")}, Transforms: []any{hideTime}, Options: sortedTable("events"),
				},
				{
					Type: "table", Title: "Sessions with errors or frustration", W: 12, Datasource: &dash.Loki,
					Description: "The sessions with the most error and frustration events. Open a row in the session explorer." + keptOnly,
					Targets: []dash.Target{dash.LokiInstant("A",
						`topk(50, sum by (session_id) (count_over_time(`+bothEvents+` [$__range])))`)},
					Overrides: []any{rename("Value #A", "events")}, Transforms: []any{hideTime}, Options: sortedTable("events"),
					Links: []dash.Link{{
						Title: "Open in the session explorer",
						URL:   "/d/libo11y-rum-session-explorer?var-session_id=${__data.fields.session_id}&${app:queryparam}&${__url_time_range}",
					}},
				},
			},
			{
				{
					Type: "logs", Title: "Recent errors", W: 24, H: 12, Datasource: &dash.Loki,
					Description: "Error events, newest first." + keptOnly,
					Targets:     []dash.Target{dash.LokiLogs("A", errEvents)},
					Options:     logOptions("Descending"),
				},
			},
		},
	}
}
