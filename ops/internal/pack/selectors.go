package pack

import (
	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// Prometheus label matchers built from dashboard variables. Required
// labels use .+ as the All value and optional ones .*, so a series without
// an optional label still counts when its variable is at All.
const (
	selApp      = `service_name=~"$app"`
	selPlatform = `o11y_rum_platform=~"$platform"`
	selView     = `o11y_rum_view_name=~"$view"`
	// selBrowser keeps the platforms that report browser-only metrics, such
	// as long animation frames.
	selBrowser  = `o11y_rum_platform=~"web|webext"`
	selVitalDim = `o11y_rum_device_class=~"$device", o11y_rum_browser_family=~"$browser", geo_country_iso_code=~"$country", o11y_rum_connection_effective=~"$connection"`
)

// lokiApp is the only stream selector the pack writes. service_name is
// Loki's one index label for OTLP logs; everything else, session.id and
// o11y.rum.view.id included, is structured metadata read after it.
const lokiApp = `{service_name=~"$app"}`

// vitalDef is one web vital: its thresholds key, display label, Prometheus
// family (from the gateway's catalog) and Grafana unit.
type vitalDef struct {
	Key, Label, Family, Unit string
}

// vitalDefs are the vitals in display order.
var vitalDefs = []vitalDef{
	{"lcp", "LCP", "o11y_rum_vital_lcp_seconds", "s"},
	{"inp", "INP", "o11y_rum_vital_inp_seconds", "s"},
	{"cls", "CLS", "o11y_rum_vital_cls", "none"},
	{"fcp", "FCP", "o11y_rum_vital_fcp_seconds", "s"},
	{"ttfb", "TTFB", "o11y_rum_vital_ttfb_seconds", "s"},
}

// vitalSteps colors a vital green up to its good bound, orange from it and
// red from its poor bound.
func vitalSteps(t thresholds.Thresholds, key string) []dash.Step {
	v := t.Vitals[key]
	return []dash.Step{{Color: "green"}, {Color: "orange", Value: &v.Good}, {Color: "red", Value: &v.Poor}}
}
