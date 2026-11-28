package pack

import "github.com/jamesainslie/libo11y/ops/internal/dash"

// The datasource variables. Panels select datasources only through these,
// so no operator's datasource UID is written into a dashboard.
var (
	varProm  = dash.Variable{Name: "prometheus", Label: "Prometheus", Type: "datasource", Query: "prometheus"}
	varLoki  = dash.Variable{Name: "loki", Label: "Loki", Type: "datasource", Query: "loki"}
	varTempo = dash.Variable{Name: "tempo", Label: "Tempo", Type: "datasource", Query: "tempo"}
)

// promVar is a multi-value Prometheus label variable with an All value.
func promVar(name, label, query, all string) dash.Variable {
	return dash.Variable{
		Name: name, Label: label, Type: "query", Datasource: &dash.Prometheus, Query: query,
		Multi: true, IncludeAll: true, AllValue: all,
	}
}

// The RUM label variables. service.name and o11y.rum.platform are required
// on every derived metric, so their All value is .+; the others are
// optional and match a missing label with .*.
var (
	varApp      = promVar("app", "App", `label_values(o11y_rum_views_total, service_name)`, ".+")
	varPlatform = promVar("platform", "Platform", `label_values(o11y_rum_views_total{service_name=~"$app"}, o11y_rum_platform)`, ".+")
	varView     = promVar("view", "View", `label_values(o11y_rum_views_total{service_name=~"$app"}, o11y_rum_view_name)`, ".*")
	varDevice   = vitalLabelVar("device", "Device class", "o11y_rum_device_class")
	varBrowser  = vitalLabelVar("browser", "Browser", "o11y_rum_browser_family")
	varCountry  = vitalLabelVar("country", "Country", "geo_country_iso_code")
	varConn     = vitalLabelVar("connection", "Connection", "o11y_rum_connection_effective")
)

// vitalLabelVar is an optional vital dimension, read from the first vital's
// sample count.
func vitalLabelVar(name, label, l string) dash.Variable {
	return promVar(name, label, `label_values(`+vitalDefs[0].Family+`_count{service_name=~"$app"}, `+l+`)`, ".*")
}

// The session explorer's variables. Its app list comes from Loki, because
// the explorer reads only Loki and Tempo.
var (
	varLokiApp = dash.Variable{
		Name: "app", Label: "App", Type: "query", Datasource: &dash.Loki, Query: "label_values(service_name)",
		Multi: true, IncludeAll: true, AllValue: ".+",
	}
	varSession = dash.Variable{Name: "session_id", Label: "session.id", Type: "textbox"}
	varViewID  = dash.Variable{Name: "view_id", Label: "o11y.rum.view.id", Type: "textbox"}
)
