package pack

import (
	"io"
	"log/slog"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/model/rulefmt"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/jamesainslie/libo11y/ops/internal/rules"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// alertsOf returns every alerting rule of the files, in file and group
// order.
func alertsOf(files map[string]rules.File) []rules.Rule {
	var out []rules.Rule
	for _, p := range slices.Sorted(maps.Keys(files)) {
		for _, g := range files[p].Groups {
			for _, r := range g.Rules {
				if r.Alert != "" {
					out = append(out, r)
				}
			}
		}
	}
	return out
}

func TestRules(t *testing.T) {
	files := RuleFiles(thresholds.Default(), "0.1.0")
	if got := slices.Sorted(maps.Keys(files)); !slices.Equal(got, []string{gatewayRulesPath, rumRulesPath}) {
		t.Fatalf("rule files %q", got)
	}
	var groups []string
	for _, p := range []string{rumRulesPath, gatewayRulesPath} {
		for _, g := range files[p].Groups {
			groups = append(groups, g.Name)
		}
		b, err := files[p].YAML()
		if err != nil {
			t.Fatal(err)
		}
		if _, errs := rulefmt.Parse(b, false, model.UTF8Validation, parser.NewParser(parser.Options{}), slog.New(slog.NewTextHandler(io.Discard, nil))); len(errs) > 0 {
			t.Errorf("%s: %v", p, errs)
		}
	}
	if want := []string{"libo11y-rum-recording", "libo11y-rum-alerts", "libo11y-rum-gateway-alerts"}; !slices.Equal(groups, want) {
		t.Errorf("groups %q, want %q", groups, want)
	}

	vital := map[string]int{}
	names := map[string]bool{}
	for _, r := range alertsOf(files) {
		names[r.Alert] = true
		switch r.Labels["severity"] {
		case "critical", "warning", "info":
		default:
			t.Errorf("%s: severity %q", r.Alert, r.Labels["severity"])
		}
		if r.For == "" {
			t.Errorf("%s has no for duration", r.Alert)
		}
		for _, k := range []string{"summary", "description", "runbook_url", "dashboard"} {
			if r.Annotations[k] == "" {
				t.Errorf("%s has no %s annotation", r.Alert, k)
			}
		}
		for k, v := range r.Annotations {
			if strings.Contains(v, "$value") {
				t.Errorf("%s: annotation %s uses $value, so promtool cannot compare it exactly", r.Alert, k)
			}
		}
		if want := "https://github.com/jamesainslie/libo11y/blob/ops/v0.1.0/ops/README.md#" + strings.ToLower(r.Alert); r.Annotations["runbook_url"] != want {
			t.Errorf("%s: runbook_url %q, want %q", r.Alert, r.Annotations["runbook_url"], want)
		}
		uid, ok := strings.CutPrefix(r.Annotations["dashboard"], "/d/")
		if !ok || !slices.Contains(UIDs, uid) {
			t.Errorf("%s: dashboard %q is not a dashboard of the pack", r.Alert, r.Annotations["dashboard"])
		}
		if v := r.Labels["vital"]; v != "" {
			vital[r.Alert]++
			if !slices.Contains(thresholds.VitalKeys, v) {
				t.Errorf("%s: vital %q", r.Alert, v)
			}
		}
	}
	if vital["O11yRUMVitalPoor"] != len(thresholds.VitalKeys) || vital["O11yRUMVitalRegression"] != len(thresholds.VitalKeys) {
		t.Errorf("vital alerts %v, want one poor and one regression alert per vital", vital)
	}
	for _, n := range []string{
		"O11yRUMVitalPoor", "O11yRUMVitalRegression", "O11yRUMErrorRateHigh",
		"O11yRUMGatewayRejections", "O11yRUMGatewayRateLimited", "O11yRUMGatewaySinkFailing",
		"O11yRUMGatewaySinkSlow", "O11yRUMAggregatorNearCap", "O11yRUMGatewayDown",
	} {
		if !names[n] {
			t.Errorf("no alert %s", n)
		}
	}
}

// TestRecordingRules names the series the alerts read: a p75 and a sample
// count over one hour for each vital, and views and errors over 15
// minutes, all by service_name.
func TestRecordingRules(t *testing.T) {
	g := RuleFiles(thresholds.Default(), "0.1.0")[rumRulesPath].Groups[0]
	if g.Interval != "1m" {
		t.Errorf("recording interval %q, want 1m", g.Interval)
	}
	var got []string
	for _, r := range g.Rules {
		got = append(got, r.Record)
		l, err := outputLabels(r.Expr)
		if err != nil || !slices.Equal(l, []string{"service_name"}) {
			t.Errorf("%s keeps %q (%v), want only service_name", r.Record, l, err)
		}
	}
	var want []string
	for _, v := range vitalDefs {
		want = append(want, "service_name:"+v.Family+":p75_rate1h", "service_name:"+v.Family+"_count:increase1h")
	}
	want = append(want, "service_name:o11y_rum_views:increase15m", "service_name:o11y_rum_errors:increase15m")
	if !slices.Equal(got, want) {
		t.Errorf("recorded\n got %q\nwant %q", got, want)
	}
}

// TestRulesFollowThresholds proves the rules are generated from the
// thresholds, not written with the defaults.
func TestRulesFollowThresholds(t *testing.T) {
	th := thresholds.Default()
	th.MinViewsPerHour = 1000
	th.GatewaySelector = `job="rum"`
	th.Vitals = maps.Clone(th.Vitals)
	th.Vitals["lcp"] = thresholds.Vital{Good: 2, Poor: 3.5}
	files := RuleFiles(th, "9.9.9")
	var exprs strings.Builder
	for _, r := range alertsOf(files) {
		exprs.WriteString(r.Expr + "\n")
		if !strings.Contains(r.Annotations["runbook_url"], "/ops/v9.9.9/") {
			t.Errorf("%s: runbook_url %q does not name the version", r.Alert, r.Annotations["runbook_url"])
		}
	}
	for _, want := range []string{">= 1000", ">= 250", `{job="rum"`, "o11y_rum_vital_lcp_seconds:p75_rate1h > 3.5", "o11y_rum_vital_lcp_seconds:p75_rate1h > 2\n"} {
		if !strings.Contains(exprs.String(), want) {
			t.Errorf("no rule contains %q:\n%s", want, exprs.String())
		}
	}
}

// TestRunbookAnchors keeps every runbook_url pointing at a heading of
// ops/README.md.
func TestRunbookAnchors(t *testing.T) {
	readme, err := os.ReadFile("../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, r := range alertsOf(RuleFiles(thresholds.Default(), "0.1.0")) {
		if seen[r.Alert] {
			continue
		}
		seen[r.Alert] = true
		if !strings.Contains(string(readme), "\n### "+r.Alert+"\n") {
			t.Errorf("ops/README.md has no heading ### %s for its runbook_url", r.Alert)
		}
	}
}

// TestBuildRefusesInvalidRules makes the generator fail, rather than write
// rule files Prometheus would refuse, when thresholds that pass validation
// still produce an expression that does not parse.
func TestBuildRefusesInvalidRules(t *testing.T) {
	th := thresholds.Default()
	th.GatewaySelector = `job="x",`
	if _, err := Build(th, "0.1.0"); err == nil {
		t.Fatal("a selector with a trailing comma produced rules that do not parse, and Build accepted them")
	}
}

// TestErrorRateNeedsViews keeps the error rate alert from dividing by zero
// views when the minimum traffic is set to 0.
func TestErrorRateNeedsViews(t *testing.T) {
	th := thresholds.Default()
	th.MinViewsPerHour = 0
	for _, r := range alertsOf(RuleFiles(th, "0.1.0")) {
		if r.Alert == "O11yRUMErrorRateHigh" && !strings.Contains(r.Expr, recordedViews+" >= 1") {
			t.Errorf("O11yRUMErrorRateHigh does not need at least one view:\n%s", r.Expr)
		}
	}
}
