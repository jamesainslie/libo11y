package catalog

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestResolveHistogramSeries(t *testing.T) {
	c := Catalog{"o11y_rum_vital_lcp_seconds": {Name: "o11y_rum_vital_lcp_seconds", Type: "histogram", Labels: []string{"service_name"}}}
	for _, s := range []string{"o11y_rum_vital_lcp_seconds_bucket", "o11y_rum_vital_lcp_seconds_sum", "o11y_rum_vital_lcp_seconds_count"} {
		if f, ok := c.Resolve(s); !ok || f.Name != "o11y_rum_vital_lcp_seconds" {
			t.Errorf("%s: %v %v", s, f, ok)
		}
	}
	if _, ok := c.Resolve("o11y_rum_vital_lcp_seconds_total"); ok {
		t.Error("a _total series resolved to a histogram")
	}
	if _, ok := c.Resolve("o11y_rum_vital_lcp_seconds"); !ok {
		t.Error("the family name itself did not resolve")
	}
}

// Only histograms own _bucket, _sum and _count series.
func TestResolveSuffixOnlyForHistograms(t *testing.T) {
	c := Catalog{"o11yrum_aggregator_series": {Name: "o11yrum_aggregator_series", Type: "gauge"}}
	if _, ok := c.Resolve("o11yrum_aggregator_series_count"); ok {
		t.Error("a gauge resolved a _count series")
	}
}

func TestFormatAndLoadRoundTrip(t *testing.T) {
	c := Catalog{
		"b_total": {Name: "b_total", Type: "counter", Labels: []string{"x", "y"}},
		"a":       {Name: "a", Type: "gauge"},
	}
	got := string(c.Format())
	want := "a gauge\nb_total counter x,y\n"
	if got != want {
		t.Fatalf("Format:\n%s\nwant:\n%s", got, want)
	}
	path := filepath.Join(t.TempDir(), "exported.txt")
	if err := os.WriteFile(path, []byte(got), 0o600); err != nil {
		t.Fatal(err)
	}
	back, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, c) {
		t.Fatalf("Load: %v, want %v", back, c)
	}
}

func TestLoadRefusesMalformedLines(t *testing.T) {
	for name, body := range map[string]string{
		"one field":     "a\n",
		"four fields":   "a gauge x y\n",
		"unknown type":  "a summary\n",
		"duplicate":     "a gauge\na gauge\n",
		"empty label":   "a gauge x,,y\n",
		"unsorted file": "b gauge\na gauge\n",
	} {
		path := filepath.Join(t.TempDir(), "exported.txt")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestGoldenHasTheSpecMetrics(t *testing.T) {
	c, err := Load("testdata/exported.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"o11y_rum_views_total", "o11y_rum_errors_total", "o11y_rum_frustrations_total",
		"o11y_rum_browser_long_animation_frames_total",
		"o11yrum_batches_total", "o11yrum_records_dropped_total", "o11yrum_attributes_removed_total",
		"o11yrum_sink_duration_seconds", "o11yrum_aggregator_series",
	} {
		if _, ok := c[name]; !ok {
			t.Errorf("golden lacks %s", name)
		}
	}
	vitals := 0
	for name := range c {
		if strings.HasPrefix(name, "o11y_rum_vital_") {
			vitals++
		}
	}
	if vitals != 5 {
		t.Errorf("%d vital families, want 5", vitals)
	}
}

// Session and view IDs are high cardinality and must never be Prometheus
// labels.
func TestGoldenHasNoSessionOrViewIDLabels(t *testing.T) {
	c, err := Load("testdata/exported.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range c {
		for _, l := range f.Labels {
			if l == "session_id" || l == "o11y_rum_view_id" {
				t.Errorf("%s has label %s", f.Name, l)
			}
		}
	}
}
