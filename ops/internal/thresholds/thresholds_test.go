package thresholds

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestDefaultLoads(t *testing.T) {
	d := Default()
	if d.MinViewsPerHour != 200 || d.RegressionRatio != 1.25 || len(d.Vitals) != 5 {
		t.Fatalf("defaults %+v", d)
	}
}

const valid = `min_views_per_hour: 200
regression_ratio: 1.25
errors_per_view: 0.1
gateway_selector: 'job=~"(.*/)?o11yrum-gateway"'
gateway_rejection_ratio: 0.05
gateway_min_requests_per_second: 0.05
rate_limited_ratio: 0.2
sink_failure_ratio: 0.01
sink_p99_seconds: 2
aggregator_series_warn: 1800
vitals:
  lcp: {good: 2.5, poor: 4}
  inp: {good: 0.2, poor: 0.5}
  cls: {good: 0.1, poor: 0.25}
  fcp: {good: 1.8, poor: 3}
  ttfb: {good: 0.8, poor: 1.8}
`

func write(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "thresholds.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadValid(t *testing.T) {
	got, err := Load(write(t, valid))
	if err != nil {
		t.Fatal(err)
	}
	if got.Vitals["cls"].Poor != 0.25 || got.GatewaySelector != `job=~"(.*/)?o11yrum-gateway"` {
		t.Fatalf("%+v", got)
	}
}

func TestLoadRefuses(t *testing.T) {
	cases := map[string][2]string{
		"missing vital":       {"  ttfb: {good: 0.8, poor: 1.8}\n", ""},
		"good not under poor": {"lcp: {good: 2.5, poor: 4}", "lcp: {good: 4, poor: 4}"},
		"regression ratio 1":  {"regression_ratio: 1.25", "regression_ratio: 1"},
		"negative minimum":    {"min_views_per_hour: 200", "min_views_per_hour: -1"},
		"negative ratio":      {"errors_per_view: 0.1", "errors_per_view: -0.1"},
		"bad selector":        {`gateway_selector: 'job=~"(.*/)?o11yrum-gateway"'`, `gateway_selector: 'job=~'`},
		"unknown key":         {"sink_p99_seconds: 2", "sink_p99_seconds: 2\nsink_p95_seconds: 1"},
		"unknown vital":       {"  ttfb: {good: 0.8, poor: 1.8}\n", "  ttfb: {good: 0.8, poor: 1.8}\n  tbt: {good: 0.2, poor: 0.6}\n"},
		"nan ratio":           {"regression_ratio: 1.25", "regression_ratio: .nan"},
		"nan vital":           {"lcp: {good: 2.5, poor: 4}", "lcp: {good: .nan, poor: 4}"},
		"infinite poor":       {"lcp: {good: 2.5, poor: 4}", "lcp: {good: 2.5, poor: .inf}"},
		"zero sink p99":       {"sink_p99_seconds: 2", "sink_p99_seconds: 0"},
	}
	for name, c := range cases {
		body := strings.Replace(valid, c[0], c[1], 1)
		if body == valid {
			t.Fatalf("%s: the replacement did not apply", name)
		}
		if _, err := Load(write(t, body)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The default vital bounds are the specification's rating table, which
// the gateway also rates against.
func TestDefaultsMatchSpec(t *testing.T) {
	raw, err := os.ReadFile("../../../docs/SPEC.md")
	if err != nil {
		t.Fatal(err)
	}
	_, table, ok := strings.Cut(string(raw), "### Vital ratings")
	if !ok {
		t.Fatal("docs/SPEC.md has no Vital ratings section")
	}
	got := map[string]Vital{}
	for _, line := range strings.Split(table, "\n") {
		if strings.HasPrefix(line, "#") {
			break
		}
		cells := strings.Split(strings.Trim(line, "| "), "|")
		if len(cells) != 3 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(cells[0]))
		good, gerr := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(cells[1]), " s"), 64)
		poor, perr := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(cells[2]), " s"), 64)
		if gerr != nil || perr != nil {
			continue // the header and separator rows
		}
		got[key] = Vital{Good: good, Poor: poor}
	}
	want := Default().Vitals
	if len(got) != 5 {
		t.Fatalf("parsed %d rows from the spec table, want 5: %v", len(got), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: default %+v, spec %+v", k, v, got[k])
		}
	}
}

func TestErrorsInStableOrder(t *testing.T) {
	body := strings.NewReplacer("errors_per_view: 0.1", "errors_per_view: -1", "rate_limited_ratio: 0.2", "rate_limited_ratio: -1", "sink_failure_ratio: 0.01", "sink_failure_ratio: -1").Replace(valid)
	_, first := Parse([]byte(body))
	if first == nil {
		t.Fatal("invalid thresholds were accepted")
	}
	for range 20 {
		if _, err := Parse([]byte(body)); err.Error() != first.Error() {
			t.Fatalf("order changed:\n%v\n%v", first, err)
		}
	}
}
