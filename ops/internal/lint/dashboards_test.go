package lint

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jamesainslie/libo11y/ops/internal/dash"
)

func tiny() dash.Dashboard {
	return dash.Dashboard{
		UID: "libo11y-tiny", Title: "Tiny",
		Variables: []dash.Variable{
			{Name: "prometheus", Label: "Prometheus", Type: "datasource", Query: "prometheus"},
			{Name: "app", Label: "App", Type: "query", Datasource: &dash.Prometheus, Query: "label_values(o11y_rum_views_total, service_name)", IncludeAll: true, AllValue: ".+"},
		},
		Links: []dash.Link{{Title: "Self", URL: "/d/libo11y-tiny"}},
		Rows: [][]dash.Panel{{
			{Type: "timeseries", Title: "Views", W: 12, Datasource: &dash.Prometheus, Targets: []dash.Target{
				dash.PromRange("A", `sum(rate(o11y_rum_views_total{service_name=~"$app"}[$__rate_interval]))`, ""),
			}},
			{Type: "stat", Title: "Apps", W: 12, Datasource: &dash.Prometheus, Targets: []dash.Target{
				dash.PromInstant("A", `count(count by (service_name) (o11y_rum_views_total))`, ""),
			}},
		}},
	}
}

var uids = map[string]bool{"libo11y-tiny": true}

func render(t *testing.T, d dash.Dashboard) map[string]any {
	t.Helper()
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func check(t *testing.T, m map[string]any) []error {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return CheckDashboard(b, uids)
}

func panel(m map[string]any, i int) map[string]any {
	return m["panels"].([]any)[i].(map[string]any)
}

func TestCheckDashboardAcceptsTiny(t *testing.T) {
	if errs := check(t, render(t, tiny())); len(errs) > 0 {
		t.Fatal(errs)
	}
}

func TestCheckDashboardRefuses(t *testing.T) {
	cases := map[string]struct {
		mutate func(m map[string]any)
		want   string
	}{
		"hardcoded uid": {func(m map[string]any) {
			panel(m, 0)["datasource"] = map[string]any{"type": "prometheus", "uid": "P1809F7CD0C75ACF3"}
		}, "P1809F7CD0C75ACF3"},
		"overlap": {func(m map[string]any) {
			panel(m, 1)["gridPos"].(map[string]any)["x"] = 6
		}, "overlap"},
		"too wide": {func(m map[string]any) {
			panel(m, 1)["gridPos"].(map[string]any)["w"] = 13
		}, "24"},
		"duplicate id": {func(m map[string]any) {
			panel(m, 1)["id"] = panel(m, 0)["id"]
		}, "id"},
		"missing link": {func(m map[string]any) {
			m["links"] = []any{map[string]any{"title": "x", "url": "/d/libo11y-missing", "type": "link"}}
		}, "libo11y-missing"},
		"em dash": {func(m map[string]any) {
			panel(m, 0)["title"] = "Views \u2014 all"
		}, "em dash"},
		"bad uid": {func(m map[string]any) { m["uid"] = "Tiny" }, "uid"},
		"schema":  {func(m map[string]any) { m["schemaVersion"] = 36 }, "schemaVersion"},
		"undefined datasource variable": {func(m map[string]any) {
			panel(m, 0)["datasource"] = map[string]any{"type": "loki", "uid": "${loki}"}
		}, "loki"},
		"duplicate refId": {func(m map[string]any) {
			p := panel(m, 0)
			p["targets"] = append(p["targets"].([]any), p["targets"].([]any)[0])
		}, "refId"},
		"string datasource": {func(m map[string]any) {
			panel(m, 0)["datasource"] = "MyProdPrometheus"
		}, "MyProdPrometheus"},
		"undefined variable": {func(m map[string]any) {
			panel(m, 0)["targets"].([]any)[0].(map[string]any)["expr"] = `sum(o11y_rum_views_total{o11y_rum_view_name=~"$view"})`
		}, "$view"},
	}
	for name, c := range cases {
		m := render(t, tiny())
		c.mutate(m)
		errs := check(t, m)
		if len(errs) == 0 || !strings.Contains(fmt.Sprint(errs), c.want) {
			t.Errorf("%s: %v, want an error mentioning %q", name, errs, c.want)
		}
	}
}

func TestCheckDashboardNotJSON(t *testing.T) {
	if errs := CheckDashboard([]byte("{"), uids); len(errs) == 0 {
		t.Fatal("malformed JSON was accepted")
	}
}

// Errors come out in the same order on every run.
func TestCheckDashboardStableOrder(t *testing.T) {
	m := render(t, tiny())
	panel(m, 0)["title"] = "a \u2014 b"
	panel(m, 1)["title"] = "c \u2014 d"
	m["description"] = "e \u2014 f"
	first := fmt.Sprint(check(t, m))
	for range 20 {
		if got := fmt.Sprint(check(t, m)); got != first {
			t.Fatalf("order changed:\n%s\n%s", first, got)
		}
	}
}
