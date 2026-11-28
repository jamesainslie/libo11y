package pack

import (
	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

const vitalsNote = `**How to read these.** The gateway rates each vital with the specification's thresholds, the same ones that color these panels. A p75 counts every consented session, not only those the trace sampler kept. Each vital is reported once per view ("Once per view" in the specification), so a long-lived view contributes one sample, not one per interaction.`

// vitals breaks each web vital down by view, device class, browser and
// country.
func vitals(t thresholds.Thresholds) dash.Dashboard {
	sel := selApp + `, ` + selView + `, ` + selVitalDim
	rows := make([][]dash.Panel, 0, 3*len(vitalDefs)+1)
	for _, v := range vitalDefs {
		bucket := v.Family + `_bucket{` + sel + `}`
		count := v.Family + `_count{` + sel + `}`
		// p75Range is the p75 over the whole time range, for stats and
		// tables; p75Rate is the p75 at each step, for time series.
		p75Range := func(by string) string {
			return `histogram_quantile(0.75, sum by (` + by + `) (increase(` + bucket + `[$__range])))`
		}
		p75Rate := func(by string) string {
			return `histogram_quantile(0.75, sum by (` + by + `) (rate(` + bucket + `[$__rate_interval])))`
		}
		steps := vitalSteps(t, v.Key)
		rows = append(rows,
			[]dash.Panel{{Type: "row", Title: v.Label}},
			[]dash.Panel{
				{
					Type: "stat", Title: v.Label + " p75", W: 4, Datasource: &dash.Prometheus,
					Description: "The 75th percentile of " + v.Label + " over the time range.",
					Targets:     []dash.Target{promValue(p75Range("le"), "")},
					Unit:        v.Unit, Thresholds: steps, Options: statOptions("lastNotNull"),
				},
				{
					Type: "timeseries", Title: v.Label + " p75 over time", W: 10, Datasource: &dash.Prometheus,
					Targets: []dash.Target{dash.PromRange("A", p75Rate("le"), "p75")},
					Unit:    v.Unit, Thresholds: steps, Options: legendBottom(),
					Custom: map[string]any{"thresholdsStyle": map[string]any{"mode": "line"}},
				},
				{
					Type: "timeseries", Title: v.Label + " p75 by device class", W: 10, Datasource: &dash.Prometheus,
					Targets: []dash.Target{dash.PromRange("A", p75Rate("le, o11y_rum_device_class"), "{{o11y_rum_device_class}}")},
					Unit:    v.Unit, Options: legendBottom(),
				},
			},
			[]dash.Panel{
				{
					Type: "table", Title: v.Label + " p75 by view", W: 12, Datasource: &dash.Prometheus,
					Description: "The 75th percentile and the number of samples for each view over the time range.",
					Targets: []dash.Target{
						dash.PromInstant("A", p75Range("le, o11y_rum_view_name"), ""),
						dash.PromInstant("B", `sum by (o11y_rum_view_name) (increase(`+count+`[$__range]))`, ""),
					},
					Transforms: []any{map[string]any{"id": "merge", "options": map[string]any{}}, hideTime()},
					Overrides: []any{
						withUnit(rename("Value #A", "p75"), v.Unit),
						rename("Value #B", "samples"),
					},
					Options: sortedTable("samples"),
				},
				{
					Type: "table", Title: v.Label + " p75 by browser", W: 6, Datasource: &dash.Prometheus,
					Targets:    []dash.Target{dash.PromInstant("A", p75Range("le, o11y_rum_browser_family"), "")},
					Transforms: []any{hideTime()},
					Overrides:  []any{withUnit(rename("Value", "p75"), v.Unit)},
					Options:    sortedTable("p75"),
				},
				{
					Type: "table", Title: v.Label + " p75 by country", W: 6, Datasource: &dash.Prometheus,
					Targets:    []dash.Target{dash.PromInstant("A", p75Range("le, geo_country_iso_code"), "")},
					Transforms: []any{hideTime()},
					Overrides:  []any{withUnit(rename("Value", "p75"), v.Unit)},
					Options:    sortedTable("p75"),
				},
			},
		)
	}
	rows = append(rows, []dash.Panel{{Type: "text", Title: "How to read these", W: 24, H: 3, Content: vitalsNote}})
	return dash.Dashboard{
		UID:         "libo11y-rum-vitals",
		Title:       "libo11y RUM: web vitals",
		Description: "LCP, INP, CLS, FCP and TTFB at the 75th percentile, by view, device class, browser and country.",
		Tags:        []string{"rum"},
		Variables:   []dash.Variable{varProm, varApp, varView, varDevice, varBrowser, varCountry, varConn},
		Links: []dash.Link{
			{Title: "Overview", URL: "/d/libo11y-rum-overview?${app:queryparam}&${__url_time_range}"},
			{Title: "Errors and frustration", URL: "/d/libo11y-rum-errors?${app:queryparam}&${view:queryparam}&${__url_time_range}"},
		},
		Rows: rows,
	}
}
