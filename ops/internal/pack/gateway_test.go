package pack

import (
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/jamesainslie/libo11y/ops/internal/dash"
	"github.com/jamesainslie/libo11y/ops/internal/lint"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

func TestGateway(t *testing.T) {
	d := board(t, gatewayUID)
	if d.Title != "libo11y RUM: gateway" {
		t.Errorf("title %q", d.Title)
	}
	if got, want := variableNames(d), []string{"prometheus", "gateway", "app"}; !slices.Equal(got, want) {
		t.Errorf("variables %q, want %q", got, want)
	}
	for name, query := range map[string]string{
		"gateway": `label_values(o11yrum_batches_total, job)`,
		"app":     `label_values(o11yrum_batches_total{job=~"$gateway"}, o11yrum_app)`,
	} {
		v := variable(t, d, name)
		if v.Query != query || !v.Multi || !v.IncludeAll || v.AllValue != ".+" {
			t.Errorf("variable %s: %+v, want a multi-value query %s with All .+", name, v, query)
		}
	}
	want := []string{
		"Requests per second", "Rejected share", "Sink p99", "Aggregator series",
		"Requests by outcome", "Requests by signal",
		"Rejections by reason", "Records dropped by reason",
		"Sink latency", "Sink exports by outcome",
		"Attributes removed by policy", "Aggregator series by metric",
		"Symbolicated frames by result", "Source map uploads by outcome",
	}
	if got := titlesOf(d); !slices.Equal(got, want) {
		t.Errorf("panels\n got %q\nwant %q", got, want)
	}
	th := thresholds.Default()
	rejected := panelByTitle(t, d, "Rejected share")
	amber, red := th.GatewayRejectionRatio, 2*th.GatewayRejectionRatio
	if !stepsEqual(rejected.Thresholds, []dash.Step{{Color: "green"}, {Color: "orange", Value: &amber}, {Color: "red", Value: &red}}) || rejected.Unit != "percentunit" {
		t.Errorf("Rejected share: thresholds %+v unit %s, want green, amber at %v, red at %v, percentunit", rejected.Thresholds, rejected.Unit, amber, red)
	}
	sink := panelByTitle(t, d, "Sink p99")
	if !stepsEqual(sink.Thresholds, []dash.Step{{Color: "green"}, {Color: "red", Value: &th.SinkP99Seconds}}) || sink.Unit != "s" {
		t.Errorf("Sink p99: thresholds %+v unit %s, want red from %v s", sink.Thresholds, sink.Unit, th.SinkP99Seconds)
	}
	if p := panelByTitle(t, d, "Sink latency"); len(p.Targets) != 2 {
		t.Errorf("Sink latency has %d targets, want p50 and p99", len(p.Targets))
	}
	for _, p := range panelsOf(d) {
		if p.Type == "text" {
			continue
		}
		for _, tg := range p.Targets {
			if kindOf(p, tg) != "prometheus" {
				t.Errorf("%q queries %s; the gateway dashboard reads only Prometheus", p.Title, kindOf(p, tg))
			}
		}
	}
}

// TestGatewayFilters checks every selector on the gateway dashboard
// follows the gateway picker, and that every selector on a family with an
// o11yrum_app label follows the app picker.
func TestGatewayFilters(t *testing.T) {
	const gatewayMark, appMark = "GATEWAY_VARIABLE", "APP_VARIABLE"
	c := golden(t)
	d := board(t, gatewayUID)
	vars := map[string]string{"gateway": gatewayMark, "app": appMark, "prometheus": "prometheus"}
	for _, p := range panelsOf(d) {
		for _, tg := range p.Targets {
			x, err := lint.Expand(queryOf(tg), vars)
			if err != nil {
				t.Errorf("%q: %v", p.Title, err)
				continue
			}
			root, err := parser.NewParser(parser.Options{}).ParseExpr(x)
			if err != nil {
				t.Errorf("%q: %v", p.Title, err)
				continue
			}
			parser.Inspect(root, func(n parser.Node, _ []parser.Node) error {
				vs, ok := n.(*parser.VectorSelector)
				if !ok {
					return nil
				}
				if !hasRegexp(vs, "job", gatewayMark) {
					t.Errorf("%q: selector %s does not filter job=~\"$gateway\"", p.Title, vs)
				}
				f, ok := c.Resolve(vs.Name)
				if ok && slices.Contains(f.Labels, "o11yrum_app") && !hasRegexp(vs, "o11yrum_app", appMark) {
					t.Errorf("%q: selector %s does not filter o11yrum_app=~\"$app\"", p.Title, vs)
				}
				return nil
			})
		}
	}
}

func hasRegexp(vs *parser.VectorSelector, name, value string) bool {
	return slices.ContainsFunc(vs.LabelMatchers, func(m *labels.Matcher) bool {
		return m.Name == name && m.Type == labels.MatchRegexp && m.Value == value
	})
}

// TestGatewayLinks keeps the gateway dashboard one click from the
// overview and back.
func TestGatewayLinks(t *testing.T) {
	d := board(t, gatewayUID)
	var urls []string
	for _, l := range d.Links {
		urls = append(urls, l.URL)
	}
	if !slices.ContainsFunc(urls, func(u string) bool { return strings.HasPrefix(u, "/d/libo11y-rum-overview") }) {
		t.Errorf("the gateway dashboard does not link to the overview: %q", urls)
	}
}
