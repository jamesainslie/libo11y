package dash

import (
	"bytes"
	"encoding/json"
	"slices"
	"testing"
)

func TestLayoutAndIDs(t *testing.T) {
	d := Dashboard{UID: "libo11y-x", Title: "x", Rows: [][]Panel{
		{{Type: "stat", Title: "a", W: 12, H: 4}, {Type: "stat", Title: "b", W: 12, H: 4}},
		{{Type: "timeseries", Title: "c", W: 24}},
	}}
	var got struct {
		Panels []struct {
			ID      int                      `json:"id"`
			Title   string                   `json:"title"`
			GridPos struct{ X, Y, W, H int } `json:"gridPos"`
		} `json:"panels"`
		Tags          []string `json:"tags"`
		SchemaVersion int      `json:"schemaVersion"`
	}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	want := [][5]int{{1, 0, 0, 12, 4}, {2, 12, 0, 12, 4}, {3, 0, 4, 24, 8}}
	if len(got.Panels) != len(want) {
		t.Fatalf("%d panels, want %d", len(got.Panels), len(want))
	}
	for i, p := range got.Panels {
		if g := [5]int{p.ID, p.GridPos.X, p.GridPos.Y, p.GridPos.W, p.GridPos.H}; g != want[i] {
			t.Errorf("panel %d: %v, want %v", i, g, want[i])
		}
	}
	if got.SchemaVersion != 39 || !slices.Contains(got.Tags, "libo11y") {
		t.Fatalf("schema %d tags %v", got.SchemaVersion, got.Tags)
	}
}

// A row's height is its tallest panel, so the next row starts below it.
func TestRowHeightIsTallestPanel(t *testing.T) {
	d := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{
		{{Type: "row", Title: "r"}},
		{{Type: "stat", W: 6, H: 4}, {Type: "timeseries", W: 18, H: 10}},
		{{Type: "stat", W: 24, H: 3}},
	}}
	var got struct {
		Panels []struct {
			GridPos struct{ X, Y, W, H int } `json:"gridPos"`
		} `json:"panels"`
	}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	want := [][4]int{{0, 0, 24, 1}, {0, 1, 6, 4}, {6, 1, 18, 10}, {0, 11, 24, 3}}
	for i, p := range got.Panels {
		if g := [4]int{p.GridPos.X, p.GridPos.Y, p.GridPos.W, p.GridPos.H}; g != want[i] {
			t.Errorf("panel %d: %v, want %v", i, g, want[i])
		}
	}
}

func TestRowTooWide(t *testing.T) {
	_, err := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{{{Type: "stat", W: 20}, {Type: "stat", W: 8}}}}.JSON()
	if err == nil {
		t.Fatal("a 28-column row was accepted")
	}
}

func TestPanelWithoutWidth(t *testing.T) {
	_, err := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{{{Type: "stat", Title: "zero"}}}}.JSON()
	if err == nil {
		t.Fatal("a panel with no width was accepted")
	}
}

func TestDatasourceFlowsToTargets(t *testing.T) {
	d := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{{{Type: "timeseries", W: 24, Datasource: &Prometheus, Targets: []Target{PromRange("A", "up", "")}}}}}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"uid": "${prometheus}"`)) || bytes.Count(b, []byte(`"${prometheus}"`)) != 2 {
		t.Fatalf("datasource not on panel and target:\n%s", b)
	}
}

// A target that names its own datasource keeps it, and the panel's
// targets are not changed by rendering.
func TestTargetDatasourceKept(t *testing.T) {
	tg := LokiLogs("A", `{service_name="x"}`)
	tg["datasource"] = Loki
	p := Panel{Type: "logs", W: 24, Datasource: &Prometheus, Targets: []Target{tg, PromRange("B", "up", "")}}
	b, err := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{{p}}}.JSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"${loki}"`)) {
		t.Fatalf("target datasource lost:\n%s", b)
	}
	if _, set := p.Targets[1]["datasource"]; set {
		t.Fatal("rendering changed the caller's target")
	}
}

func TestDeterministic(t *testing.T) {
	d := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{{{Type: "stat", W: 6, Options: map[string]any{"z": 1, "a": 2}}}}}
	a, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) || !bytes.HasSuffix(a, []byte("\n")) {
		t.Fatal("output not stable")
	}
}

func TestVariables(t *testing.T) {
	d := Dashboard{UID: "u", Title: "t", Variables: []Variable{
		{Name: "prometheus", Label: "Prometheus", Type: "datasource", Query: "prometheus"},
		{Name: "app", Label: "App", Type: "query", Datasource: &Prometheus, Query: "label_values(o11y_rum_views_total, service_name)", Multi: true, IncludeAll: true, AllValue: ".+"},
		{Name: "session_id", Label: "session.id", Type: "textbox"},
	}}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type": "datasource"`, `"definition": "label_values(o11y_rum_views_total, service_name)"`, `"allValue": ".+"`, `"type": "textbox"`} {
		if !bytes.Contains(b, []byte(want)) {
			t.Errorf("missing %s", want)
		}
	}
}

func TestStepsAndText(t *testing.T) {
	two := 2.0
	d := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{
		{{Type: "stat", W: 12, Unit: "s", Thresholds: []Step{{Color: "green"}, {Color: "red", Value: &two}}}},
		{{Type: "text", W: 24, Content: "# hello"}},
	}}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Panels []struct {
			FieldConfig struct {
				Defaults struct {
					Unit       string `json:"unit"`
					Thresholds struct {
						Mode  string `json:"mode"`
						Steps []struct {
							Color string   `json:"color"`
							Value *float64 `json:"value"`
						} `json:"steps"`
					} `json:"thresholds"`
				} `json:"defaults"`
			} `json:"fieldConfig"`
			Options map[string]any `json:"options"`
		} `json:"panels"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	def := got.Panels[0].FieldConfig.Defaults
	if def.Unit != "s" || def.Thresholds.Mode != "absolute" || len(def.Thresholds.Steps) != 2 ||
		def.Thresholds.Steps[0].Value != nil || *def.Thresholds.Steps[1].Value != 2 {
		t.Errorf("field config %+v", def)
	}
	if !bytes.Contains(b, []byte(`"value": null`)) {
		t.Error("the base step does not render a null value")
	}
	if o := got.Panels[1].Options; o["mode"] != "markdown" || o["content"] != "# hello" {
		t.Errorf("text options %v", o)
	}
}

func TestLinks(t *testing.T) {
	d := Dashboard{
		UID: "u", Title: "t",
		Links: []Link{{Title: "Vitals", URL: "/d/libo11y-rum-vitals"}},
		Rows:  [][]Panel{{{Type: "table", W: 24, Links: []Link{{Title: "Session", URL: "/d/libo11y-rum-session-explorer?var-session_id=${__value.raw}"}}}}},
	}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type": "link"`, `"url": "/d/libo11y-rum-vitals"`, `"url": "/d/libo11y-rum-session-explorer?var-session_id=${__value.raw}"`} {
		if !bytes.Contains(b, []byte(want)) {
			t.Errorf("missing %s", want)
		}
	}
}

func TestTargets(t *testing.T) {
	cases := map[string]struct {
		got  Target
		want map[string]any
	}{
		"prom range":   {PromRange("A", "up", "{{job}}"), map[string]any{"refId": "A", "expr": "up", "legendFormat": "{{job}}", "range": true, "instant": false}},
		"prom instant": {PromInstant("B", "up", ""), map[string]any{"refId": "B", "instant": true, "range": false, "format": "table"}},
		"loki logs":    {LokiLogs("C", "{a=\"b\"}"), map[string]any{"refId": "C", "queryType": "range"}},
		"loki instant": {LokiInstant("D", "x"), map[string]any{"refId": "D", "queryType": "instant"}},
		"tempo":        {TempoSearch("E", "{}", "spans", 20), map[string]any{"refId": "E", "queryType": "traceql", "query": "{}", "tableType": "spans", "limit": 20}},
	}
	for name, c := range cases {
		for k, v := range c.want {
			if c.got[k] != v {
				t.Errorf("%s: %s = %v, want %v", name, k, c.got[k], v)
			}
		}
	}
}

func TestVariableErrors(t *testing.T) {
	for name, v := range map[string]Variable{
		"query without datasource": {Name: "app", Type: "query", Query: "label_values(up, job)"},
		"unknown type":             {Name: "x", Type: "interval"},
	} {
		if _, err := (Dashboard{UID: "u", Title: "t", Variables: []Variable{v}}).JSON(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := (Dashboard{Title: "t"}).JSON(); err == nil {
		t.Error("a dashboard without a uid was accepted")
	}
}

// A dashboard opens on the last six hours unless it names its own range.
func TestTimeFrom(t *testing.T) {
	for from, want := range map[string]string{"": "now-6h", "now-24h": "now-24h"} {
		b, err := Dashboard{UID: "u", Title: "t", TimeFrom: from}.JSON()
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			Time struct{ From, To string } `json:"time"`
		}
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatal(err)
		}
		if got.Time.From != want || got.Time.To != "now" {
			t.Errorf("TimeFrom %q: time %+v, want from %s to now", from, got.Time, want)
		}
	}
}

// Custom goes into fieldConfig.defaults.custom, where Grafana keeps the
// panel type's own field options, such as a threshold line style.
func TestCustomFieldConfig(t *testing.T) {
	p := Panel{Type: "timeseries", W: 24, Custom: map[string]any{"thresholdsStyle": map[string]any{"mode": "line"}}}
	b, err := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{{p}, {{Type: "stat", W: 24}}}}.JSON()
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Panels []struct {
			FieldConfig struct {
				Defaults map[string]any `json:"defaults"`
			} `json:"fieldConfig"`
		} `json:"panels"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	custom, _ := got.Panels[0].FieldConfig.Defaults["custom"].(map[string]any)
	style, _ := custom["thresholdsStyle"].(map[string]any)
	if style["mode"] != "line" {
		t.Errorf("custom field config %v", got.Panels[0].FieldConfig.Defaults)
	}
	if _, set := got.Panels[1].FieldConfig.Defaults["custom"]; set {
		t.Error("a panel without Custom renders a custom field config")
	}
}

// Grafana's Loki datasource reads a variable query as a label_values()
// string, while Prometheus takes the {query, refId} object.
func TestLokiVariableQueryIsAString(t *testing.T) {
	d := Dashboard{UID: "u", Title: "t", Variables: []Variable{
		{Name: "loki", Label: "Loki", Type: "datasource", Query: "loki"},
		{Name: "app", Label: "App", Type: "query", Datasource: &Loki, Query: "label_values(service_name)", IncludeAll: true, AllValue: ".+"},
		{Name: "papp", Label: "App", Type: "query", Datasource: &Prometheus, Query: "label_values(up, job)"},
	}}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Templating struct {
			List []struct {
				Query any `json:"query"`
			} `json:"list"`
		} `json:"templating"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if q := got.Templating.List[1].Query; q != "label_values(service_name)" {
		t.Errorf("loki variable query %v, want the label_values() string", q)
	}
	if q, ok := got.Templating.List[2].Query.(map[string]any); !ok || q["query"] != "label_values(up, job)" {
		t.Errorf("prometheus variable query %v, want {query, refId}", got.Templating.List[2].Query)
	}
}

// Queries and link URLs keep &, < and > as written, so the committed JSON
// reads like the query an operator types.
func TestNoHTMLEscaping(t *testing.T) {
	d := Dashboard{UID: "u", Title: "t", Rows: [][]Panel{{{
		Type: "table", W: 24, Datasource: &Tempo,
		Targets: []Target{TempoSearch("A", `{ span.a = "1" && span.b > 2 }`, "spans", 20)},
		Links:   []Link{{Title: "x", URL: "/d/x?var-a=1&var-b=2"}},
	}}}}
	b, err := d.JSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`span.a = \"1\" && span.b > 2`, `/d/x?var-a=1&var-b=2`} {
		if !bytes.Contains(b, []byte(want)) {
			t.Errorf("missing %s in\n%s", want, b)
		}
	}
}
