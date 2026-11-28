package ops_test

import (
	"fmt"
	"slices"
	"testing"

	"github.com/prometheus/prometheus/promql/parser"
)

var promParser = parser.NewParser(parser.Options{})

// sampleCountQueries returns, for each distinct range selector in a PromQL
// expression, a query for the fewest samples any series it matches has in
// that range: min(count_over_time(sel[range])). rate() and increase()
// answer for a series only when it has at least two samples in the range,
// so the integration test waits for each of these to reach two before it
// asks Grafana for the panel.
func sampleCountQueries(expr string) ([]string, error) {
	root, err := promParser.ParseExpr(expr)
	if err != nil {
		return nil, fmt.Errorf("parse %q: %w", expr, err)
	}
	var out []string
	parser.Inspect(root, func(n parser.Node, _ []parser.Node) error {
		if ms, ok := n.(*parser.MatrixSelector); ok {
			if q := fmt.Sprintf("min(count_over_time(%s))", ms); !slices.Contains(out, q) {
				out = append(out, q)
			}
		}
		return nil
	})
	return out, nil
}

func TestSampleCountQueries(t *testing.T) {
	tests := []struct {
		name string
		expr string
		want []string
	}{
		{
			name: "one rate",
			expr: `sum(rate(o11yrum_batches_total{job=~"o11yrum-gateway"}[1m]))`,
			want: []string{`min(count_over_time(o11yrum_batches_total{job=~"o11yrum-gateway"}[1m]))`},
		},
		{
			name: "quantile of a bucket rate",
			expr: `histogram_quantile(0.5, sum by (le) (rate(o11yrum_sink_duration_seconds_bucket{job=~"g"}[1m])))`,
			want: []string{`min(count_over_time(o11yrum_sink_duration_seconds_bucket{job=~"g"}[1m]))`},
		},
		{
			name: "each range selector once, in order",
			expr: `sum(increase(a_total[1h])) / scalar(sum(increase(a_total[1h]))) + sum(rate(b_total[1m]))`,
			want: []string{`min(count_over_time(a_total[1h]))`, `min(count_over_time(b_total[1m]))`},
		},
		{
			name: "no range selector",
			expr: `sum(up)`,
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := sampleCountQueries(tt.expr)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("sampleCountQueries(%q) = %q, want %q", tt.expr, got, tt.want)
			}
		})
	}
}

func TestSampleCountQueriesRejectsBadPromQL(t *testing.T) {
	if _, err := sampleCountQueries(`sum(rate(x[`); err == nil {
		t.Error("sampleCountQueries accepted unparseable PromQL")
	}
}
