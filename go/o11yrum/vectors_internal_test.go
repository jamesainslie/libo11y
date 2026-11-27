package o11yrum

import (
	"bytes"
	"cmp"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/aggregate"
	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// updateVectors rewrites the committed vectors instead of checking them:
// go test -run TestVectors -update-vectors .
var updateVectors = flag.Bool("update-vectors", false, "rewrite conformance/vectors from this implementation")

// vectorsDir holds the values every libo11y implementation must reproduce
// exactly. See conformance/README.md.
const vectorsDir = "../../conformance/vectors"

// vectorFile is the shape of rum-view-summary-metrics.json.
type vectorFile struct {
	Scope      string                `json:"scope"`
	Bounds     map[string][]float64  `json:"bounds"`
	Thresholds map[string][2]float64 `json:"thresholds"`
	Cases      []vectorCase          `json:"cases"`
}

// vectorCase is the summaries of one app's request and the metrics a fresh
// gateway derives from them.
type vectorCase struct {
	Name      string           `json:"name"`
	Service   string           `json:"service"`
	Resource  map[string]any   `json:"resource"`
	Summaries []map[string]any `json:"summaries"`
	Metrics   []vectorMetric   `json:"metrics"`
}

// vectorMetric is one data point. A sum has Sum only; a histogram has
// Count, Sum, Min, Max and BucketCounts against the file's bounds for its
// unit.
type vectorMetric struct {
	Name         string            `json:"name"`
	Kind         string            `json:"kind"`
	Unit         string            `json:"unit"`
	Attributes   map[string]string `json:"attributes"`
	Sum          float64           `json:"sum"`
	Count        *uint64           `json:"count,omitempty"`
	Min          *float64          `json:"min,omitempty"`
	Max          *float64          `json:"max,omitempty"`
	BucketCounts []uint64          `json:"bucket_counts,omitempty"`
}

// summary returns a view summary's required attributes plus extra.
func summary(platform, name, kind, view string, seq int, extra map[string]any) map[string]any {
	s := map[string]any{
		keyPlatform:    platform,
		keyViewName:    name,
		keyViewKind:    kind,
		keyViewID:      view,
		keySessionID:   "session-1",
		keySummarySeq:  seq,
		keySummaryTime: 4.5,
	}
	for k, v := range extra {
		s[k] = v
	}
	return s
}

// allVitals sets every vital of a summary.
func allVitals(lcp, inp, cls, fcp, ttfb float64) map[string]any {
	return map[string]any{
		keySummaryLCP: lcp, keySummaryINP: inp, keySummaryCLS: cls,
		keySummaryFCP: fcp, keySummaryTTFB: ttfb,
	}
}

func merged(ms ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, m := range ms {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

var webResource = map[string]any{keyBrowserFamily: "chrome", keyCountry: "DE"}

var summaryCases = []vectorCase{
	{
		Name:     "initial web view with every vital and count",
		Service:  "shop-web",
		Resource: webResource,
		Summaries: []map[string]any{summary("web", "/documents/$docId", "initial", "view-1", 0, merged(
			allVitals(1.8, 0.15, 0.05, 1.2, 0.4),
			map[string]any{
				keyDeviceClass:                "desktop",
				keyConnEffective:              "4g",
				keySummaryErrors + "uncaught": 2,
				keySummaryErrors + "network":  1,
				keySummaryFrust + "rage":      1,
				keySummaryFrust + "dead":      3,
				keySummaryLoAF:                4,
				"o11y.rum.summary.requests":   12,
				keySummaryErrors + "csp":      0,
				keySummaryFrust + "error":     0,
			},
		))},
	},
	{
		Name:     "two summaries of one view count the view once",
		Service:  "shop-web",
		Resource: webResource,
		Summaries: []map[string]any{
			summary("web", "/cart", "initial", "view-1", 0, merged(allVitals(2, 0.1, 0.02, 1, 0.3), map[string]any{
				keyDeviceClass: "mobile", keySummaryErrors + "uncaught": 1, keySummaryFrust + "rage": 1, keySummaryLoAF: 2,
			})),
			summary("web", "/cart", "initial", "view-1", 1, map[string]any{
				keyDeviceClass: "mobile", keySummaryErrors + "uncaught": 2, keySummaryFrust + "rage": 1, keySummaryLoAF: 1,
			}),
		},
	},
	{
		Name:      "every vital at its good bound is good",
		Service:   "shop-web",
		Resource:  webResource,
		Summaries: []map[string]any{summary("web", "/", "initial", "view-1", 0, allVitals(2.5, 0.2, 0.1, 1.8, 0.8))},
	},
	{
		Name:      "every vital at its poor bound needs improvement",
		Service:   "shop-web",
		Resource:  webResource,
		Summaries: []map[string]any{summary("web", "/", "initial", "view-1", 0, allVitals(4, 0.5, 0.25, 3, 1.8))},
	},
	{
		Name:      "every vital just above its poor bound is poor",
		Service:   "shop-web",
		Resource:  webResource,
		Summaries: []map[string]any{summary("web", "/", "initial", "view-1", 0, allVitals(4.000000001, 0.500000001, 0.250000001, 3.000000001, 1.800000001))},
	},
	{
		Name:     "soft navigation without vitals or device class",
		Service:  "shop-web",
		Resource: map[string]any{keyBrowserFamily: "firefox"},
		Summaries: []map[string]any{summary("web", "/orders/$orderId", "soft", "view-2", 0, map[string]any{
			keySummaryErrors + "unhandled_rejection": 1,
		})},
	},
	{
		Name:     "react native screen without a browser family",
		Service:  "shop-app",
		Resource: map[string]any{keyCountry: "US"},
		Summaries: []map[string]any{summary("react_native", "Checkout", "screen", "view-1", 0, map[string]any{
			keyDeviceClass: "mobile", keySummaryErrors + "anr": 1, keySummaryFrust + "dead": 1, keySummaryTTFB: 0.9,
		})},
	},
	{
		Name:      "a summary with every count absent counts only the view",
		Service:   "shop-web",
		Resource:  map[string]any{},
		Summaries: []map[string]any{summary("webext", "popup", "initial", "view-1", 0, nil)},
	},
}

// putTyped stores v in m under k with the registry type of k: int keys as
// integers, double keys as floats, everything else as a string. This is
// the reading rule conformance/README.md gives ports.
func putTyped(t *testing.T, m pcommon.Map, k string, v any) {
	t.Helper()
	switch rumspec.Types[k] {
	case "int":
		n, ok := v.(int)
		if !ok {
			t.Fatalf("%s: %v is not an int", k, v)
		}
		m.PutInt(k, int64(n))
	case "double":
		switch x := v.(type) {
		case float64:
			m.PutDouble(k, x)
		case int:
			m.PutDouble(k, float64(x))
		default:
			t.Fatalf("%s: %v is not a number", k, v)
		}
	default:
		s, ok := v.(string)
		if !ok {
			t.Fatalf("%s: %v is not a string", k, v)
		}
		m.PutStr(k, s)
	}
}

func runCase(t *testing.T, c vectorCase) vectorCase {
	t.Helper()
	agg := aggregate.New(2000, func() time.Time { return time.Unix(0, 0) })
	d := &deriver{agg: agg}
	res := pcommon.NewMap()
	for k, v := range c.Resource {
		putTyped(t, res, k, v)
	}
	for _, s := range c.Summaries {
		rec := pcommon.NewMap()
		for k, v := range s {
			putTyped(t, rec, k, v)
		}
		d.summary(c.Service, attrLookup{record: rec, resource: res})
	}
	c.Metrics = vectorMetrics(agg.Produce())
	return c
}

// vectorMetrics flattens produced metrics, sorted by name, then by the
// attribute encoding.
func vectorMetrics(sms []metricdata.ScopeMetrics) []vectorMetric {
	type entry struct {
		m   vectorMetric
		key string
	}
	var out []entry
	enc := attribute.DefaultEncoder()
	for _, sm := range sms {
		for _, m := range sm.Metrics {
			switch data := m.Data.(type) {
			case metricdata.Sum[float64]:
				for _, p := range data.DataPoints {
					out = append(out, entry{vectorMetric{
						Name: m.Name, Kind: "sum", Unit: m.Unit, Attributes: attrMap(p.Attributes), Sum: p.Value,
					}, p.Attributes.Encoded(enc)})
				}
			case metricdata.Histogram[float64]:
				for _, p := range data.DataPoints {
					count := p.Count
					lo, _ := p.Min.Value()
					hi, _ := p.Max.Value()
					out = append(out, entry{vectorMetric{
						Name: m.Name, Kind: "histogram", Unit: m.Unit, Attributes: attrMap(p.Attributes),
						Sum: p.Sum, Count: &count, Min: &lo, Max: &hi, BucketCounts: p.BucketCounts,
					}, p.Attributes.Encoded(enc)})
				}
			}
		}
	}
	slices.SortFunc(out, func(a, b entry) int {
		return cmp.Or(cmp.Compare(a.m.Name, b.m.Name), cmp.Compare(a.key, b.key))
	})
	ms := make([]vectorMetric, len(out))
	for i, e := range out {
		ms[i] = e.m
	}
	return ms
}

func attrMap(set attribute.Set) map[string]string {
	out := make(map[string]string, set.Len())
	for _, kv := range set.ToSlice() {
		out[string(kv.Key)] = kv.Value.String()
	}
	return out
}

// checkVectorFile compares the JSON rendering of v with the committed file
// name, or rewrites the file under -update-vectors.
func checkVectorFile(t *testing.T, name string, v any) {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(vectorsDir, name)
	if *updateVectors {
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run cd go/o11yrum && go test -run TestVectors -update-vectors . to create it)", err)
	}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Errorf("%s is stale or this implementation changed its output; regenerate with cd go/o11yrum && go test -run TestVectors -update-vectors . and diff it against:\n%s", path, buf.String())
	}
}

func TestVectorsViewSummaryMetrics(t *testing.T) {
	if _, err := os.Stat("../../go.work"); err != nil {
		t.Skip("conformance vectors live beside the go modules; skipped outside the repository")
	}
	file := vectorFile{
		Scope:      scopeName,
		Bounds:     map[string][]float64{"s": secondsBounds, "1": clsBounds},
		Thresholds: map[string][2]float64{},
	}
	for _, v := range vitals {
		file.Thresholds[v.metric] = [2]float64{v.good, v.poor}
	}
	for _, c := range summaryCases {
		file.Cases = append(file.Cases, runCase(t, c))
	}
	checkVectorFile(t, "rum-view-summary-metrics.json", file)
}

// TestVectorCasesRateAsIntended pins the intent of the threshold cases, so
// a regenerated file cannot silently change what they test.
func TestVectorCasesRateAsIntended(t *testing.T) {
	want := map[string]string{
		"every vital at its good bound is good":           ratingGood,
		"every vital at its poor bound needs improvement": ratingNI,
		"every vital just above its poor bound is poor":   ratingPoor,
	}
	for _, c := range summaryCases {
		rate, ok := want[c.Name]
		if !ok {
			continue
		}
		got := runCase(t, c)
		vitalsSeen := 0
		for _, m := range got.Metrics {
			if m.Kind != "histogram" {
				continue
			}
			vitalsSeen++
			if m.Attributes[keyVitalRating] != rate {
				t.Errorf("%s: %s rated %s, want %s", c.Name, m.Name, m.Attributes[keyVitalRating], rate)
			}
		}
		if vitalsSeen != len(vitals) {
			t.Errorf("%s: %d vitals", c.Name, vitalsSeen)
		}
	}
	two := runCase(t, summaryCases[1])
	views := 0.0
	for _, m := range two.Metrics {
		if m.Name == metricViews {
			views += m.Sum
		}
	}
	if views != 1 {
		t.Fatalf("two summaries of one view counted %v views", views)
	}
}
