package pack

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/lint"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// board returns the pack's dashboard with the given UID.
func board(t *testing.T, uid string) dash.Dashboard {
	t.Helper()
	for _, d := range Dashboards(thresholds.Default()) {
		if d.UID == uid {
			return d
		}
	}
	t.Fatalf("the pack has no dashboard %s", uid)
	return dash.Dashboard{}
}

// panelsOf flattens a dashboard's rows in reading order.
func panelsOf(d dash.Dashboard) []dash.Panel {
	var out []dash.Panel
	for _, r := range d.Rows {
		out = append(out, r...)
	}
	return out
}

func titlesOf(d dash.Dashboard) []string {
	var out []string
	for _, p := range panelsOf(d) {
		out = append(out, p.Title)
	}
	return out
}

func panelByTitle(t *testing.T, d dash.Dashboard, title string) dash.Panel {
	t.Helper()
	for _, p := range panelsOf(d) {
		if p.Title == title {
			return p
		}
	}
	t.Fatalf("%s has no panel %q", d.UID, title)
	return dash.Panel{}
}

// queryOf returns a target's query: expr for Prometheus and Loki, query
// for Tempo.
func queryOf(tg dash.Target) string {
	if q, ok := tg["expr"].(string); ok {
		return q
	}
	q, _ := tg["query"].(string)
	return q
}

// kindOf returns the datasource type a target queries.
func kindOf(p dash.Panel, tg dash.Target) string {
	if ds, ok := tg["datasource"].(dash.Datasource); ok {
		return ds.Type
	}
	if p.Datasource != nil {
		return p.Datasource.Type
	}
	return ""
}

func variableNames(d dash.Dashboard) []string {
	var out []string
	for _, v := range d.Variables {
		out = append(out, v.Name)
	}
	return out
}

func variable(t *testing.T, d dash.Dashboard, name string) dash.Variable {
	t.Helper()
	for _, v := range d.Variables {
		if v.Name == name {
			return v
		}
	}
	t.Fatalf("%s has no variable %s", d.UID, name)
	return dash.Variable{}
}

// wantVitalSteps is the threshold a vital's panels must carry: green, amber
// from the good bound, red from the poor bound.
func wantVitalSteps(t *testing.T, key string) []dash.Step {
	t.Helper()
	v, ok := thresholds.Default().Vitals[key]
	if !ok {
		t.Fatalf("no default thresholds for %s", key)
	}
	return []dash.Step{{Color: "green"}, {Color: "orange", Value: &v.Good}, {Color: "red", Value: &v.Poor}}
}

func stepsEqual(a, b []dash.Step) bool {
	return slices.EqualFunc(a, b, func(x, y dash.Step) bool {
		if x.Color != y.Color || (x.Value == nil) != (y.Value == nil) {
			return false
		}
		return x.Value == nil || *x.Value == *y.Value
	})
}

func linkURLs(p dash.Panel) []string {
	var out []string
	for _, l := range p.Links {
		out = append(out, l.URL)
	}
	return out
}

func TestUIDs(t *testing.T) {
	want := []string{"libo11y-rum-overview", "libo11y-rum-vitals", "libo11y-rum-errors", "libo11y-rum-session-explorer", "libo11y-rum-gateway"}
	if !slices.Equal(UIDs, want) {
		t.Fatalf("UIDs = %q, want %q", UIDs, want)
	}
}

// TestUIDsBuilt proves every UID a link may name is a dashboard the pack
// generates. The gateway dashboard arrives with Task R7c.1.
func TestUIDsBuilt(t *testing.T) {
	built := map[string]bool{}
	for _, d := range Dashboards(thresholds.Default()) {
		built[d.UID] = true
		if !slices.Contains(UIDs, d.UID) {
			t.Errorf("dashboard %s is built but not listed in UIDs", d.UID)
		}
	}
	for _, uid := range UIDs {
		switch {
		case built[uid]:
		case uid == "libo11y-rum-gateway":
			t.Logf("%s is not built yet; Task R7c.1 adds it", uid)
		default:
			t.Errorf("UIDs lists %s, which the pack does not build", uid)
		}
	}
}

func TestVitalFamiliesInCatalog(t *testing.T) {
	c := golden(t)
	var keys []string
	for _, v := range vitalDefs {
		keys = append(keys, v.Key)
		f, ok := c.Resolve(v.Family + "_bucket")
		if !ok || f.Name != v.Family || f.Type != "histogram" {
			t.Errorf("vital %s: %s is not a histogram in the gateway's catalog", v.Key, v.Family)
		}
	}
	if !slices.Equal(keys, thresholds.VitalKeys) {
		t.Errorf("vitalDefs keys %q, want %q", keys, thresholds.VitalKeys)
	}
}

// TestEveryQueryFiltersByApp checks the rule every RUM dashboard keeps:
// each Prometheus selector carries service_name=~"$app", and each Loki
// stream selector is exactly {service_name=~"$app"}, so service_name is the
// only stream label and every panel follows the app picker.
func TestEveryQueryFiltersByApp(t *testing.T) {
	const appMark = "APP_VARIABLE"
	for _, d := range Dashboards(thresholds.Default()) {
		if !slices.Contains(variableNames(d), "app") {
			t.Errorf("%s has no app variable", d.UID)
			continue
		}
		vars := map[string]string{"app": appMark}
		for _, v := range d.Variables {
			if v.Name != "app" {
				vars[v.Name] = "x"
			}
		}
		for _, p := range panelsOf(d) {
			for _, tg := range p.Targets {
				q := queryOf(tg)
				switch kindOf(p, tg) {
				case "prometheus":
					x, err := lint.Expand(q, vars)
					if err != nil {
						t.Errorf("%s %q: %v", d.UID, p.Title, err)
						continue
					}
					for _, err := range promAppFilter(x, appMark) {
						t.Errorf("%s %q: %v", d.UID, p.Title, err)
					}
				case "loki":
					if !strings.Contains(q, `{service_name=~"$app"}`) {
						t.Errorf("%s %q: stream selector of %s is not {service_name=~\"$app\"}", d.UID, p.Title, q)
					}
					if strings.Count(q, "{") != 1 {
						t.Errorf("%s %q: %s has more than one stream selector", d.UID, p.Title, q)
					}
				}
			}
		}
	}
}

func promAppFilter(expr, mark string) []error {
	root, err := parser.NewParser(parser.Options{}).ParseExpr(expr)
	if err != nil {
		return []error{err}
	}
	var errs []error
	parser.Inspect(root, func(n parser.Node, _ []parser.Node) error {
		vs, ok := n.(*parser.VectorSelector)
		if !ok {
			return nil
		}
		if !slices.ContainsFunc(vs.LabelMatchers, func(m *labels.Matcher) bool {
			return m.Name == "service_name" && m.Type == labels.MatchRegexp && m.Value == mark
		}) {
			errs = append(errs, fmt.Errorf("selector %s does not filter service_name=~\"$app\"", vs))
		}
		return nil
	})
	return errs
}

func TestOverview(t *testing.T) {
	d := board(t, "libo11y-rum-overview")
	if d.Title != "libo11y RUM: overview" {
		t.Errorf("title %q", d.Title)
	}
	if got, want := variableNames(d), []string{"prometheus", "app", "platform"}; !slices.Equal(got, want) {
		t.Errorf("variables %q, want %q", got, want)
	}
	want := []string{
		"Views per minute", "Errors per 100 views", "Frustrations per 100 views", "LCP p75", "INP p75", "CLS p75",
		"Views by platform", "Views by kind", "Long animation frames per view",
		"Errors by source", "Frustrations by type",
		"LCP rating share", "INP rating share", "CLS rating share",
		"Top views by traffic",
		"About these numbers",
	}
	if got := titlesOf(d); !slices.Equal(got, want) {
		t.Errorf("panels\n got %q\nwant %q", got, want)
	}
	for _, key := range []string{"lcp", "inp", "cls"} {
		p := panelByTitle(t, d, strings.ToUpper(key)+" p75")
		if !stepsEqual(p.Thresholds, wantVitalSteps(t, key)) {
			t.Errorf("%s thresholds %+v, want the default vital thresholds", p.Title, p.Thresholds)
		}
	}
	top := panelByTitle(t, d, "Top views by traffic")
	if urls := linkURLs(top); len(urls) != 1 || !strings.HasPrefix(urls[0], "/d/libo11y-rum-vitals?") {
		t.Errorf("Top views by traffic links %q, want one link to libo11y-rum-vitals", urls)
	}
	var linked []string
	for _, l := range d.Links {
		linked = append(linked, l.URL)
	}
	for _, uid := range []string{"libo11y-rum-vitals", "libo11y-rum-errors", "libo11y-rum-gateway"} {
		if !slices.ContainsFunc(linked, func(u string) bool { return strings.HasPrefix(u, "/d/"+uid) }) {
			t.Errorf("the overview does not link to %s: %q", uid, linked)
		}
	}
	// Long animation frames exist only on the browser platforms, so the
	// ratio counts only their views.
	loaf := queryOf(panelByTitle(t, d, "Long animation frames per view").Targets[0])
	if !strings.Contains(loaf, `o11y_rum_views_total{service_name=~"$app", o11y_rum_platform=~"web|webext"}`) {
		t.Errorf("Long animation frames per view divides by views of every platform: %s", loaf)
	}
	// The vital and long animation frame metrics carry no platform label.
	for _, title := range []string{"LCP p75", "INP p75", "CLS p75", "LCP rating share", "INP rating share", "CLS rating share", "Long animation frames per view"} {
		if p := panelByTitle(t, d, title); !strings.Contains(p.Description, "platform") {
			t.Errorf("%q does not say it ignores the platform picker", title)
		}
	}
	for _, key := range []string{"LCP", "INP", "CLS"} {
		p := panelByTitle(t, d, key+" rating share")
		if p.Type != "bargauge" || p.Unit != "percentunit" || len(p.Overrides) != 3 {
			t.Errorf("%s: type %s unit %s with %d overrides, want a percentunit bargauge coloring three ratings", p.Title, p.Type, p.Unit, len(p.Overrides))
		}
	}
}

func TestVitals(t *testing.T) {
	d := board(t, "libo11y-rum-vitals")
	if d.Title != "libo11y RUM: web vitals" {
		t.Errorf("title %q", d.Title)
	}
	if got, want := variableNames(d), []string{"prometheus", "app", "view", "device", "browser", "country", "connection"}; !slices.Equal(got, want) {
		t.Errorf("variables %q, want %q", got, want)
	}
	ps := panelsOf(d)
	var rows []string
	for _, p := range ps {
		if p.Type == "row" {
			rows = append(rows, p.Title)
		}
	}
	var labels []string
	for _, v := range vitalDefs {
		labels = append(labels, v.Label)
	}
	if !slices.Equal(rows, labels) {
		t.Fatalf("row panels %q, want %q", rows, labels)
	}
	// Each vital is a row panel and six panels; a text panel closes the dashboard.
	if len(ps) != 7*len(vitalDefs)+1 || ps[len(ps)-1].Type != "text" {
		t.Fatalf("%d panels, want %d and a closing text panel", len(ps), 7*len(vitalDefs)+1)
	}
	for i, v := range vitalDefs {
		section := ps[i*7 : i*7+7]
		want := []string{v.Label, v.Label + " p75", v.Label + " p75 over time", v.Label + " p75 by device class", v.Label + " p75 by view", v.Label + " p75 by browser", v.Label + " p75 by country"}
		var got []string
		for _, p := range section {
			got = append(got, p.Title)
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s panels %q, want %q", v.Key, got, want)
		}
		for _, p := range section[1:] {
			for _, tg := range p.Targets {
				q := queryOf(tg)
				for _, o := range vitalDefs {
					if o.Family != v.Family && strings.Contains(q, o.Family) {
						t.Errorf("%s %q queries %s", v.Key, p.Title, o.Family)
					}
				}
				if !strings.Contains(q, v.Family) {
					t.Errorf("%s %q does not query %s", v.Key, p.Title, v.Family)
				}
			}
		}
		if p := section[1]; !stepsEqual(p.Thresholds, wantVitalSteps(t, v.Key)) || p.Unit != v.Unit {
			t.Errorf("%s: thresholds %+v unit %s, want the default vital thresholds and %s", p.Title, p.Thresholds, p.Unit, v.Unit)
		}
		if p := section[2]; !stepsEqual(p.Thresholds, wantVitalSteps(t, v.Key)) || !drawsThresholdLines(p) {
			t.Errorf("%s: thresholds %+v custom %v, want the vital thresholds drawn as lines", p.Title, p.Thresholds, p.Custom)
		}
		byView := section[4]
		if len(byView.Targets) != 2 || len(byView.Transforms) == 0 || fmt.Sprint(byView.Transforms[0].(map[string]any)["id"]) != "merge" {
			t.Errorf("%s: %d targets and transforms %v, want two targets merged first", byView.Title, len(byView.Targets), byView.Transforms)
		}
	}
}

func TestVitalVariablesMatchEmpty(t *testing.T) {
	d := board(t, "libo11y-rum-vitals")
	for name, all := range map[string]string{"app": ".+", "view": ".*", "device": ".*", "browser": ".*", "country": ".*", "connection": ".*"} {
		v := variable(t, d, name)
		if v.AllValue != all || !v.IncludeAll {
			t.Errorf("variable %s: All value %q, want %q", name, v.AllValue, all)
		}
	}
	if q := variable(t, d, "device").Query; !strings.Contains(q, vitalDefs[0].Family+"_count") {
		t.Errorf("device variable %q does not read %s_count", q, vitalDefs[0].Family)
	}
}

func TestErrors(t *testing.T) {
	d := board(t, "libo11y-rum-errors")
	if d.Title != "libo11y RUM: errors and frustration" {
		t.Errorf("title %q", d.Title)
	}
	if got, want := variableNames(d), []string{"prometheus", "loki", "app", "platform", "view"}; !slices.Equal(got, want) {
		t.Errorf("variables %q, want %q", got, want)
	}
	want := []string{
		"Errors per 100 views by source", "Frustrations per 100 views by type",
		"Views with the most errors", "Views with the most frustration",
		"Error inbox (kept sessions)",
		"Most frustrated elements (kept sessions)", "Sessions with errors or frustration",
		"Recent errors",
	}
	if got := titlesOf(d); !slices.Equal(got, want) {
		t.Errorf("panels\n got %q\nwant %q", got, want)
	}
	for _, title := range want[4:] {
		p := panelByTitle(t, d, title)
		if p.Datasource == nil || p.Datasource.UID != "${loki}" {
			t.Errorf("%q does not use ${loki}", title)
		}
		if !strings.Contains(p.Description, "kept sessions") {
			t.Errorf("%q does not say its events exist only for kept sessions", title)
		}
		for _, tg := range p.Targets {
			q, err := lint.Expand(queryOf(tg), map[string]string{"app": ".+"})
			if err != nil {
				t.Fatal(err)
			}
			if errs := lint.CheckLogQL(q); len(errs) > 0 {
				t.Errorf("%q: %v", title, errs)
			}
		}
	}
	sessions := panelByTitle(t, d, "Sessions with errors or frustration")
	if urls := linkURLs(sessions); len(urls) != 1 || !strings.HasPrefix(urls[0], "/d/libo11y-rum-session-explorer?") || !strings.Contains(urls[0], "var-session_id=") {
		t.Errorf("sessions links %q, want one link to the session explorer setting var-session_id", urls)
	}
}

func TestExplorer(t *testing.T) {
	d := board(t, "libo11y-rum-session-explorer")
	if d.Title != "libo11y RUM: session explorer" || d.TimeFrom != "now-24h" {
		t.Errorf("title %q, time from %q", d.Title, d.TimeFrom)
	}
	if got, want := variableNames(d), []string{"loki", "tempo", "app", "session_id", "view_id"}; !slices.Equal(got, want) {
		t.Errorf("variables %q, want %q", got, want)
	}
	for _, name := range []string{"session_id", "view_id"} {
		if v := variable(t, d, name); v.Type != "textbox" {
			t.Errorf("variable %s is a %s, want a textbox", name, v.Type)
		}
	}
	if v := variable(t, d, "app"); v.Datasource == nil || v.Datasource.Type != "loki" {
		t.Errorf("the app variable reads %v, want Loki", v.Datasource)
	}
	want := []string{
		"How to use",
		"Views in this session", "Traces in this session",
		"Session timeline",
		"Spans of the selected view", "Events of the selected view",
		"Errors and frustration in this session",
	}
	if got := titlesOf(d); !slices.Equal(got, want) {
		t.Errorf("panels\n got %q\nwant %q", got, want)
	}
	kinds := map[string]int{}
	for _, p := range panelsOf(d) {
		for _, tg := range p.Targets {
			q := queryOf(tg)
			kind := kindOf(p, tg)
			kinds[kind]++
			switch kind {
			case "loki":
				sel, rest, _ := strings.Cut(q, "}")
				// A label filter treats a missing field as "", so an empty text box
				// would match every line without a session; the != "" guard stops it.
				if strings.Contains(sel, "session_id") || !strings.Contains(rest, `| session_id!="" | session_id="$session_id"`) {
					t.Errorf("%q: %s does not filter session_id after the stream selector", p.Title, q)
				}
			case "tempo":
				if !strings.Contains(q, `span.session.id = "$session_id"`) {
					t.Errorf("%q: %s does not filter span.session.id", p.Title, q)
				}
			default:
				t.Errorf("%q queries %q; the explorer reads only Loki and Tempo", p.Title, kind)
			}
		}
	}
	if kinds["loki"] != 4 || kinds["tempo"] != 2 {
		t.Errorf("query kinds %v, want 4 Loki and 2 Tempo", kinds)
	}
	for _, title := range []string{"Spans of the selected view", "Events of the selected view"} {
		p := panelByTitle(t, d, title)
		if !strings.Contains(p.Description, "view_id") {
			t.Errorf("%q does not say it is empty until view_id is set", title)
		}
		if !strings.Contains(queryOf(p.Targets[0]), "$view_id") {
			t.Errorf("%q does not filter by $view_id", title)
		}
	}
	if q := queryOf(panelByTitle(t, d, "Events of the selected view").Targets[0]); !strings.Contains(q, `| o11y_rum_view_id!="" | o11y_rum_view_id="$view_id"`) {
		t.Errorf("Events of the selected view: %s matches events without a view while view_id is empty", q)
	}
	views := panelByTitle(t, d, "Views in this session")
	if urls := linkURLs(views); len(urls) != 1 || !strings.Contains(urls[0], "var-view_id=") || !strings.HasPrefix(urls[0], "/d/libo11y-rum-session-explorer?") {
		t.Errorf("views links %q, want one link back to the explorer setting var-view_id", urls)
	}
}

// TestDashboardsInUIDOrder keeps the kustomization's order the order of
// UIDs.
func TestDashboardsInUIDOrder(t *testing.T) {
	var got []string
	for _, d := range Dashboards(thresholds.Default()) {
		got = append(got, d.UID)
	}
	want := slices.DeleteFunc(slices.Clone(UIDs), func(u string) bool { return !slices.Contains(got, u) })
	if !slices.Equal(got, want) {
		t.Errorf("dashboards %q, want them in UIDs order %q", got, want)
	}
}

// drawsThresholdLines reports whether a time series panel draws its
// thresholds as lines.
func drawsThresholdLines(p dash.Panel) bool {
	style, _ := p.Custom["thresholdsStyle"].(map[string]any)
	return style["mode"] == "line"
}
