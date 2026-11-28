package pack

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/prometheus/promql/parser"

	"github.com/jamesainslie/libo11y/ops/internal/catalog"
	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/lint"
	"github.com/jamesainslie/libo11y/ops/internal/rules"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

func golden(t *testing.T) catalog.Catalog {
	t.Helper()
	c, err := catalog.Load("../catalog/testdata/exported.txt")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestBuildPaths(t *testing.T) {
	arts, err := Build(thresholds.Default(), "0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, a := range arts {
		if !Owned(a.Path) {
			t.Errorf("artifact %s is outside dashboards/, alerts/, kubernetes/ and kustomization.yaml", a.Path)
		}
		if seen[a.Path] {
			t.Errorf("artifact %s is built twice", a.Path)
		}
		seen[a.Path] = true
	}
}

// TestPackLints runs every check on what the pack really ships: each
// dashboard's shape, and each query against the gateway's catalog.
func TestPackLints(t *testing.T) {
	th := thresholds.Default()
	var dashboards [][]byte
	for _, d := range Dashboards(th) {
		b, err := d.JSON()
		if err != nil {
			t.Fatal(err)
		}
		dashboards = append(dashboards, b)
	}
	for _, err := range lintPack(dashboards, RuleFiles(th, "0.1.0"), golden(t)) {
		t.Error(err)
	}
}

// TestLintPlumbing proves lintPack reaches every query kind, before the
// pack has dashboards of its own: valid queries of each kind pass clean,
// and an invalid query of each kind is caught.
func TestLintPlumbing(t *testing.T) {
	vars := []dash.Variable{
		{Name: "prometheus", Label: "Prometheus", Type: "datasource", Query: "prometheus"},
		{Name: "loki", Label: "Loki", Type: "datasource", Query: "loki"},
		{Name: "tempo", Label: "Tempo", Type: "datasource", Query: "tempo"},
		{Name: "app", Label: "App", Type: "query", Datasource: &dash.Prometheus, Query: "label_values(o11y_rum_views_total, service_name)", IncludeAll: true, AllValue: ".+"},
		{Name: "session_id", Label: "session.id", Type: "textbox"},
	}
	board := func(prom, loki, tempo string) []byte {
		t.Helper()
		b, err := dash.Dashboard{UID: "libo11y-plumbing", Title: "Plumbing", Variables: vars, Rows: [][]dash.Panel{
			{{Type: "timeseries", Title: "prom", W: 24, Datasource: &dash.Prometheus, Targets: []dash.Target{dash.PromRange("A", prom, "")}}},
			{{Type: "logs", Title: "loki", W: 24, Datasource: &dash.Loki, Targets: []dash.Target{dash.LokiLogs("A", loki)}}},
			{{Type: "table", Title: "tempo", W: 24, Datasource: &dash.Tempo, Targets: []dash.Target{dash.TempoSearch("A", tempo, "traces", 20)}}},
		}}.JSON()
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	recording := rules.Rule{Record: "service_name:x:p75_rate1h", Expr: `histogram_quantile(0.75, sum by (service_name, le) (rate(o11y_rum_vital_lcp_seconds_bucket[1h])))`}
	files := func(extra ...rules.Rule) map[string]rules.File {
		return map[string]rules.File{"alerts/x.rules.yaml": {Groups: []rules.Group{{Name: "g", Rules: append([]rules.Rule{recording}, extra...)}}}}
	}

	good := board(
		`sum(rate(o11y_rum_views_total{service_name=~"$app"}[$__rate_interval])) / sum(service_name:x:p75_rate1h{service_name=~"$app"})`,
		`{service_name=~"$app"} | session_id="$session_id"`,
		`{ span.session.id = "$session_id" }`,
	)
	if errs := lintPack([][]byte{good}, files(rules.Rule{Alert: "Ok", Expr: `service_name:x:p75_rate1h > 4`}), golden(t)); len(errs) > 0 {
		t.Errorf("valid queries were refused: %v", errs)
	}

	bad := board(
		`sum by (session_id) (rate(o11y_rum_views_total[5m]))`,
		`{session_id="$session_id"}`,
		`{ span.user.id = "x" }`,
	)
	got := fmt.Sprint(lintPack([][]byte{bad}, files(rules.Rule{Alert: "Bad", Expr: `rate(o11yrum_aggregator_series[5m]) > 0`}), golden(t)))
	for _, want := range []string{"session_id is not a label", "session_id is structured metadata", "user.id", "needs a counter"} {
		if !strings.Contains(got, want) {
			t.Errorf("lintPack missed %q:\n%s", want, got)
		}
	}
}

// lintPack checks rendered dashboards and rule files. Each query is
// expanded with the dashboard's variables at their All values first.
func lintPack(dashboards [][]byte, files map[string]rules.File, c catalog.Catalog) []error {
	var errs []error
	recorded := map[string][]string{}
	for path, f := range files {
		for _, g := range f.Groups {
			for _, r := range g.Rules {
				if r.Record == "" {
					continue
				}
				l, err := outputLabels(r.Expr)
				if err != nil {
					errs = append(errs, fmt.Errorf("%s: %s: %w", path, r.Record, err))
					continue
				}
				recorded[r.Record] = l
			}
		}
	}
	for path, f := range files {
		for _, g := range f.Groups {
			for _, r := range g.Rules {
				for _, err := range lint.CheckPromQL(r.Expr, c, recorded) {
					errs = append(errs, fmt.Errorf("%s: %w", path, err))
				}
			}
		}
	}
	uids := map[string]bool{}
	var parsed []rendered
	for _, raw := range dashboards {
		var d rendered
		if err := json.Unmarshal(raw, &d); err != nil {
			errs = append(errs, err)
			continue
		}
		uids[d.UID] = true
		parsed = append(parsed, d)
	}
	for i, d := range parsed {
		errs = append(errs, lint.CheckDashboard(dashboards[i], uids)...)
		vars := d.allValues()
		for _, p := range d.allPanels() {
			for _, tg := range p.Targets {
				kind := tg.Datasource.Type
				if kind == "" {
					kind = p.Datasource.Type
				}
				q := tg.Expr
				if kind == "tempo" {
					q = tg.Query
				}
				x, err := lint.Expand(q, vars)
				if err != nil {
					errs = append(errs, fmt.Errorf("%s %q: %w", d.UID, p.Title, err))
					continue
				}
				var qerrs []error
				switch kind {
				case "prometheus":
					qerrs = lint.CheckPromQL(x, c, recorded)
				case "loki":
					qerrs = lint.CheckLogQL(x)
				case "tempo":
					qerrs = lint.CheckTraceQL(x)
				default:
					qerrs = []error{fmt.Errorf("target %s has no datasource", tg.RefID)}
				}
				for _, err := range qerrs {
					errs = append(errs, fmt.Errorf("%s %q: %w", d.UID, p.Title, err))
				}
			}
		}
	}
	return errs
}

// rendered is the part of a dashboard's JSON the query checks read.
type rendered struct {
	UID        string `json:"uid"`
	Templating struct {
		List []struct {
			Name     string `json:"name"`
			Type     string `json:"type"`
			AllValue string `json:"allValue"`
			Query    any    `json:"query"`
		} `json:"list"`
	} `json:"templating"`
	Panels []renderedPanel `json:"panels"`
}

type renderedPanel struct {
	Title      string          `json:"title"`
	Datasource dash.Datasource `json:"datasource"`
	Targets    []struct {
		RefID      string          `json:"refId"`
		Datasource dash.Datasource `json:"datasource"`
		Expr       string          `json:"expr"`
		Query      string          `json:"query"`
	} `json:"targets"`
	Panels []renderedPanel `json:"panels"`
}

func (d rendered) allPanels() []renderedPanel {
	var out []renderedPanel
	var walk func([]renderedPanel)
	walk = func(ps []renderedPanel) {
		for _, p := range ps {
			out = append(out, p)
			walk(p.Panels)
		}
	}
	walk(d.Panels)
	return out
}

// allValues gives each variable the value a query sees when the viewer
// leaves it at All or empty: a datasource variable its own name, a query
// or custom variable its All value, and a textbox its default.
func (d rendered) allValues() map[string]string {
	out := map[string]string{}
	for _, v := range d.Templating.List {
		switch v.Type {
		case "datasource":
			out[v.Name] = v.Name
		case "textbox":
			s, _ := v.Query.(string)
			out[v.Name] = s
		default:
			out[v.Name] = v.AllValue
		}
	}
	return out
}

// outputLabels returns the labels a recording rule's output keeps: the
// grouping of its outermost aggregation, without le.
func outputLabels(expr string) ([]string, error) {
	root, err := parser.NewParser(parser.Options{}).ParseExpr(expr)
	if err != nil {
		return nil, err
	}
	var agg *parser.AggregateExpr
	parser.Inspect(root, func(n parser.Node, _ []parser.Node) error {
		if a, ok := n.(*parser.AggregateExpr); ok && agg == nil {
			agg = a
		}
		return nil
	})
	if agg == nil || agg.Without {
		return nil, errors.New("a recording rule must aggregate with by (...), so its output labels are known")
	}
	return slices.DeleteFunc(slices.Clone(agg.Grouping), func(l string) bool { return l == "le" }), nil
}

func TestOwned(t *testing.T) {
	for p, want := range map[string]bool{
		"dashboards/libo11y-rum-overview.json": true,
		"alerts/libo11y-rum.rules.yaml":        true,
		"alerts/tests/libo11y-rum.test.yaml":   false,
		"kubernetes/prometheusrule.yaml":       true,
		"kustomization.yaml":                   true,
		"thresholds.yaml":                      false,
		"datasources/example.yaml":             false,
		"README.md":                            false,
	} {
		if Owned(p) != want {
			t.Errorf("Owned(%s) = %v, want %v", p, !want, want)
		}
	}
}

func TestDrift(t *testing.T) {
	root := t.TempDir()
	put := func(p, body string) {
		t.Helper()
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	arts := []Artifact{
		{Path: "dashboards/a.json", Data: []byte("a\n")},
		{Path: "dashboards/b.json", Data: []byte("b\n")},
		{Path: "alerts/c.rules.yaml", Data: []byte("c\n")},
	}
	put("dashboards/a.json", "a\n")
	put("dashboards/b.json", "old\n")
	put("dashboards/stale.json", "x\n")
	put("alerts/tests/c.test.yaml", "hand-written\n")
	put("thresholds.yaml", "x\n")
	put("dashboards/.DS_Store", "x")
	put("dashboards/.a.json.swp", "x")
	put("dashboards/a.json~", "x")
	got, err := Drift(root, arts)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"alerts/c.rules.yaml (missing)", "dashboards/b.json (differs)", "dashboards/stale.json (not generated)"}
	if !slices.Equal(got, want) {
		t.Fatalf("Drift = %q, want %q", got, want)
	}
}

func TestBuildRefusesDuplicateUIDs(t *testing.T) {
	d := dash.Dashboard{UID: "libo11y-x", Title: "x"}
	if _, err := build([]dash.Dashboard{d, d}, nil); err == nil {
		t.Fatal("two dashboards with one uid were accepted")
	}
}
