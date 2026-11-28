package lint

import (
	"fmt"
	"strings"
	"testing"

	"github.com/jamesainslie/libo11y/ops/internal/catalog"
)

var c = catalog.Catalog{
	"o11y_rum_views_total":       {Name: "o11y_rum_views_total", Type: "counter", Labels: []string{"o11y_rum_platform", "o11y_rum_view_name", "service_name"}},
	"o11y_rum_vital_lcp_seconds": {Name: "o11y_rum_vital_lcp_seconds", Type: "histogram", Labels: []string{"o11y_rum_device_class", "service_name"}},
	"o11yrum_aggregator_series":  {Name: "o11yrum_aggregator_series", Type: "gauge", Labels: []string{"o11yrum_metric"}},
}

func TestCheckPromQL(t *testing.T) {
	ok := []string{
		`sum by (o11y_rum_platform) (rate(o11y_rum_views_total{service_name=~".+"}[5m]))`,
		`histogram_quantile(0.75, sum by (le, o11y_rum_device_class) (rate(o11y_rum_vital_lcp_seconds_bucket{service_name=~".+"}[5m])))`,
		`sum(o11yrum_aggregator_series{job=~".+"})`,
		`sum(rate(o11y_rum_vital_lcp_seconds_count[5m])) / ignoring(o11yrum_metric) sum(o11yrum_aggregator_series)`,
		`sum by (service_name) (increase(o11y_rum_vital_lcp_seconds_sum[1h])) / on(service_name) sum by (service_name) (increase(o11y_rum_views_total[1h]))`,
		`sum by (app) (label_replace(rate(o11y_rum_views_total[5m]), "app", "$1", "service_name", "(.*)"))`,
	}
	for _, e := range ok {
		if errs := CheckPromQL(e, c, nil); len(errs) > 0 {
			t.Errorf("%s: %v", e, errs)
		}
	}
	bad := map[string]string{
		`rate(o11y_rum_view_total[5m])`:                                                                  "unknown metric",
		`sum by (session_id) (rate(o11y_rum_views_total[5m]))`:                                           "session_id",
		`rate(o11y_rum_views_total{o11y_rum_device_class="x"}[5m])`:                                      "o11y_rum_device_class",
		`histogram_quantile(0.75, sum(rate(o11y_rum_vital_lcp_seconds_bucket[5m])))`:                     "le",
		`rate(o11yrum_aggregator_series[5m])`:                                                            "counter",
		`sum(rate(o11y_rum_views_total[5m]`:                                                              "parse",
		`rate(o11y_rum_vital_lcp_seconds_count{le="1"}[5m])`:                                             "le",
		`sum(rate(o11y_rum_views_total[5m])) / on(o11y_rum_view_id) sum(rate(o11y_rum_views_total[5m]))`: "o11y_rum_view_id",
		`{service_name="x"}`: "metric name",
	}
	for e, want := range bad {
		errs := CheckPromQL(e, c, nil)
		if len(errs) == 0 || !strings.Contains(fmt.Sprint(errs), want) {
			t.Errorf("%s: %v, want an error mentioning %q", e, errs, want)
		}
	}
}

// Recording rule outputs resolve through recorded, with their own labels.
func TestCheckPromQLRecorded(t *testing.T) {
	rec := map[string][]string{"service_name:o11y_rum_vital_lcp_seconds:p75_rate1h": {"service_name"}}
	if errs := CheckPromQL(`max by (service_name) (service_name:o11y_rum_vital_lcp_seconds:p75_rate1h offset 7d)`, c, rec); len(errs) > 0 {
		t.Errorf("recorded series: %v", errs)
	}
	errs := CheckPromQL(`service_name:o11y_rum_vital_lcp_seconds:p75_rate1h{o11y_rum_view_name="x"}`, c, rec)
	if !strings.Contains(fmt.Sprint(errs), "o11y_rum_view_name") {
		t.Errorf("a label the recording rule drops was accepted: %v", errs)
	}
}

// Every problem is reported, not only the first.
func TestCheckPromQLReportsAll(t *testing.T) {
	errs := CheckPromQL(`rate(nope_total[5m]) + rate(o11y_rum_views_total{session_id="x"}[5m])`, c, nil)
	if len(errs) < 2 {
		t.Fatalf("%v, want at least two problems", errs)
	}
}

// A classic histogram has no series named after the family itself.
func TestCheckPromQLBareHistogram(t *testing.T) {
	errs := CheckPromQL(`max(o11y_rum_vital_lcp_seconds{service_name=~".+"})`, c, nil)
	if !strings.Contains(fmt.Sprint(errs), "_bucket") {
		t.Errorf("a bare histogram name was accepted: %v", errs)
	}
}
