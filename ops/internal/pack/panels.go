package pack

import "github.com/jamesainslie/libo11y/ops/internal/dash"

// promValue is an instant Prometheus query returned as series, for stat
// and bar gauge panels, which show one value for each series.
func promValue(ref, expr, legend string) dash.Target {
	t := dash.PromInstant(ref, expr, legend)
	t["format"] = "time_series"
	return t
}

// statOptions reduce each series to one number.
func statOptions(calc string) map[string]any {
	return map[string]any{
		"reduceOptions": map[string]any{"calcs": []any{calc}, "fields": "", "values": false},
		"colorMode":     "value",
		"graphMode":     "none",
		"justifyMode":   "auto",
		"textMode":      "auto",
	}
}

// legendBottom is the legend of every time series panel.
var legendBottom = map[string]any{
	"legend":  map[string]any{"displayMode": "list", "placement": "bottom", "showLegend": true},
	"tooltip": map[string]any{"mode": "multi", "sort": "desc"},
}

// hideTime drops the Time column an instant query adds to a table.
var hideTime = map[string]any{"id": "organize", "options": map[string]any{"excludeByName": map[string]any{"Time": true}}}

// rename is a field override that gives a column a display name.
func rename(field, name string) map[string]any {
	return map[string]any{
		"matcher":    map[string]any{"id": "byName", "options": field},
		"properties": []any{map[string]any{"id": "displayName", "value": name}},
	}
}

// fieldColor is a field override that paints one series a fixed color.
func fieldColor(field, color string) map[string]any {
	return map[string]any{
		"matcher":    map[string]any{"id": "byName", "options": field},
		"properties": []any{map[string]any{"id": "color", "value": map[string]any{"mode": "fixed", "fixedColor": color}}},
	}
}

// ratingColors paint the three vital ratings of the specification.
var ratingColors = []any{fieldColor("good", "green"), fieldColor("needs-improvement", "orange"), fieldColor("poor", "red")}

// logOptions are the options of a logs panel.
func logOptions(order string) map[string]any {
	return map[string]any{
		"sortOrder":          order,
		"showTime":           true,
		"enableLogDetails":   true,
		"wrapLogMessage":     true,
		"prettifyLogMessage": false,
		"dedupStrategy":      "none",
	}
}

// sortedTable sorts a table by a column, largest first.
func sortedTable(column string) map[string]any {
	return map[string]any{"showHeader": true, "sortBy": []any{map[string]any{"displayName": column, "desc": true}}}
}

// withUnit adds a unit to a field override.
func withUnit(override map[string]any, unit string) map[string]any {
	props, _ := override["properties"].([]any)
	override["properties"] = append(props, map[string]any{"id": "unit", "value": unit})
	return override
}
