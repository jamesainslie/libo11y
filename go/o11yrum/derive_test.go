package o11yrum

import (
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/aggregate"
	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// flatten renders produced metrics as name{k=v,...} keys with sorted
// attributes. A sum maps to its value; a histogram's key gets #count and
// maps to its count.
func flatten(sms []metricdata.ScopeMetrics) map[string]float64 {
	out := map[string]float64{}
	for _, sm := range sms {
		for _, m := range sm.Metrics {
			switch data := m.Data.(type) {
			case metricdata.Sum[float64]:
				for _, p := range data.DataPoints {
					out[seriesKey(m.Name, p.Attributes.ToSlice())] = p.Value
				}
			case metricdata.Histogram[float64]:
				for _, p := range data.DataPoints {
					out[seriesKey(m.Name, p.Attributes.ToSlice())+"#count"] = float64(p.Count)
				}
			}
		}
	}
	return out
}

// seriesKey renders name{k=v,...}. ToSlice already sorts by key.
func seriesKey(name string, kvs []attribute.KeyValue) string {
	parts := make([]string, len(kvs))
	for i, kv := range kvs {
		parts[i] = string(kv.Key) + "=" + kv.Value.String()
	}
	return name + "{" + strings.Join(parts, ",") + "}"
}

func keysOf(kvs []attribute.KeyValue) []string {
	out := make([]string, len(kvs))
	for i, kv := range kvs {
		out[i] = string(kv.Key)
	}
	return out
}

func specRequired(metric string) []string { return rumspec.Metrics[metric].Required }

func newTestDeriver() (*deriver, *aggregate.Aggregator) {
	agg := aggregate.New(2000, func() time.Time { return time.Unix(1, 0) })
	return &deriver{agg: agg}, agg
}

// baseSummary returns the attributes every view summary carries.
func baseSummary(seq int64) pcommon.Map {
	rec := pcommon.NewMap()
	rec.PutStr("o11y.rum.platform", "web")
	rec.PutStr("o11y.rum.view.name", "/documents/$docId")
	rec.PutStr("o11y.rum.view.kind", "initial")
	rec.PutStr("o11y.rum.view.id", "v0")
	rec.PutStr("session.id", "s1")
	rec.PutInt("o11y.rum.summary.seq", seq)
	rec.PutDouble("o11y.rum.summary.time_on_view", 12.5)
	return rec
}

func TestRating(t *testing.T) {
	for _, tc := range []struct {
		v    float64
		want string
	}{{2.5, "good"}, {2.5000001, "needs-improvement"}, {4, "needs-improvement"}, {4.0000001, "poor"}, {0, "good"}} {
		if got := rating(tc.v, 2.5, 4); got != tc.want {
			t.Errorf("rating(%v) = %s, want %s", tc.v, got, tc.want)
		}
	}
}

func TestVitalThresholdsMatchSpec(t *testing.T) {
	want := map[string][2]float64{
		metricLCP: {2.5, 4}, metricINP: {0.2, 0.5}, metricCLS: {0.1, 0.25},
		metricFCP: {1.8, 3}, metricTTFB: {0.8, 1.8},
	}
	if len(vitals) != len(want) {
		t.Fatalf("%d vitals", len(vitals))
	}
	for _, v := range vitals {
		if got := [2]float64{v.good, v.poor}; got != want[v.metric] {
			t.Errorf("%s thresholds %v, want %v", v.metric, got, want[v.metric])
		}
		bounds := secondsBounds
		if v.metric == metricCLS {
			bounds = clsBounds
		}
		// Every threshold is a bucket bound, so the share of good and poor
		// views is exact from the buckets.
		if !slices.Contains(bounds, v.good) || !slices.Contains(bounds, v.poor) {
			t.Errorf("%s thresholds are not bucket bounds", v.metric)
		}
	}
}

func TestSummaryDerivation(t *testing.T) {
	d, agg := newTestDeriver()
	res := pcommon.NewMap()
	res.PutStr("o11y.rum.browser.family", "chrome")
	res.PutStr("geo.country.iso_code", "DE")
	rec := baseSummary(0)
	rec.PutStr("o11y.rum.device.class", "desktop")
	rec.PutInt("o11y.rum.summary.errors.uncaught", 2)
	rec.PutInt("o11y.rum.summary.frustrations.rage", 1)
	rec.PutInt("o11y.rum.summary.long_animation_frames", 3)
	rec.PutDouble("o11y.rum.summary.lcp.value", 1.8)
	d.summary("shop-web", attrLookup{record: rec, resource: res})
	got := flatten(agg.Produce())
	want := map[string]float64{
		"o11y.rum.views{o11y.rum.device.class=desktop,o11y.rum.platform=web,o11y.rum.view.kind=initial,o11y.rum.view.name=/documents/$docId,service.name=shop-web}":                                            1,
		"o11y.rum.errors{o11y.rum.error.source=uncaught,o11y.rum.platform=web,o11y.rum.view.name=/documents/$docId,service.name=shop-web}":                                                                     2,
		"o11y.rum.frustrations{o11y.rum.frustration.type=rage,o11y.rum.platform=web,o11y.rum.view.name=/documents/$docId,service.name=shop-web}":                                                               1,
		"o11y.rum.browser.long_animation_frames{o11y.rum.view.name=/documents/$docId,service.name=shop-web}":                                                                                                   3,
		"o11y.rum.vital.lcp{geo.country.iso_code=DE,o11y.rum.browser.family=chrome,o11y.rum.device.class=desktop,o11y.rum.view.name=/documents/$docId,o11y.rum.vital.rating=good,service.name=shop-web}#count": 1,
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got\n%v\nwant\n%v", got, want)
	}
}

func TestSummaryServiceNameIsTheApp(t *testing.T) {
	// The resource's service.name is the client's claim; the label is the
	// app the gateway admitted the batch for.
	d, agg := newTestDeriver()
	res := pcommon.NewMap()
	res.PutStr("service.name", "something-else")
	d.summary("shop-web", attrLookup{record: baseSummary(0), resource: res})
	for k := range flatten(agg.Produce()) {
		if !strings.Contains(k, "service.name=shop-web") || strings.Contains(k, "something-else") {
			t.Fatalf("series %s", k)
		}
	}
}

func TestSummarySecondFlushDoesNotRecountView(t *testing.T) {
	d, agg := newTestDeriver()
	empty := pcommon.NewMap()
	first := baseSummary(0)
	first.PutInt("o11y.rum.summary.errors.uncaught", 1)
	second := baseSummary(1)
	second.PutInt("o11y.rum.summary.errors.uncaught", 2)
	d.summary("shop-web", attrLookup{record: first, resource: empty})
	d.summary("shop-web", attrLookup{record: second, resource: empty})
	got := flatten(agg.Produce())
	if v := got["o11y.rum.views{o11y.rum.platform=web,o11y.rum.view.kind=initial,o11y.rum.view.name=/documents/$docId,service.name=shop-web}"]; v != 1 {
		t.Fatalf("views %v in %v", v, got)
	}
	if v := got["o11y.rum.errors{o11y.rum.error.source=uncaught,o11y.rum.platform=web,o11y.rum.view.name=/documents/$docId,service.name=shop-web}"]; v != 3 {
		t.Fatalf("errors %v in %v", v, got)
	}
}

func TestSummaryWithoutSeqCountsNoView(t *testing.T) {
	d, agg := newTestDeriver()
	rec := baseSummary(0)
	rec.Remove("o11y.rum.summary.seq")
	d.summary("shop-web", attrLookup{record: rec, resource: pcommon.NewMap()})
	if got := flatten(agg.Produce()); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}

func TestSummaryZeroCountsEmitNothing(t *testing.T) {
	d, agg := newTestDeriver()
	rec := baseSummary(1)
	rec.PutInt("o11y.rum.summary.errors.uncaught", 0)
	rec.PutInt("o11y.rum.summary.frustrations.dead", 0)
	rec.PutInt("o11y.rum.summary.long_animation_frames", 0)
	d.summary("shop-web", attrLookup{record: rec, resource: pcommon.NewMap()})
	if got := flatten(agg.Produce()); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}

func TestSummaryCountsEveryEnumMember(t *testing.T) {
	d, agg := newTestDeriver()
	rec := baseSummary(1)
	for _, src := range []string{"uncaught", "unhandled_rejection", "console", "boundary", "resource", "csp", "network", "crash", "anr", "hang", "custom"} {
		rec.PutInt("o11y.rum.summary.errors."+src, 1)
	}
	for _, typ := range []string{"rage", "dead", "error"} {
		rec.PutInt("o11y.rum.summary.frustrations."+typ, 1)
	}
	d.summary("shop-web", attrLookup{record: rec, resource: pcommon.NewMap()})
	var errs, frust int
	for k := range flatten(agg.Produce()) {
		switch {
		case strings.HasPrefix(k, "o11y.rum.errors{"):
			errs++
		case strings.HasPrefix(k, "o11y.rum.frustrations{"):
			frust++
		}
	}
	if errs != 11 || frust != 3 {
		t.Fatalf("errors %d frustrations %d", errs, frust)
	}
}

func TestSummaryCLSUsesUnitlessBounds(t *testing.T) {
	d, agg := newTestDeriver()
	rec := baseSummary(0)
	rec.PutDouble("o11y.rum.summary.cls.value", 0.3)
	rec.PutDouble("o11y.rum.summary.lcp.value", 4.5)
	d.summary("shop-web", attrLookup{record: rec, resource: pcommon.NewMap()})
	seen := 0
	for _, m := range agg.Produce()[0].Metrics {
		h, ok := m.Data.(metricdata.Histogram[float64])
		if !ok {
			continue
		}
		seen++
		p := h.DataPoints[0]
		rate, _ := p.Attributes.Value(keyVitalRating)
		switch m.Name {
		case metricCLS:
			if m.Unit != "1" || !slices.Equal(p.Bounds, clsBounds) || rate.AsString() != "poor" {
				t.Errorf("cls unit %s bounds %v rating %s", m.Unit, p.Bounds, rate.AsString())
			}
		case metricLCP:
			if m.Unit != "s" || !slices.Equal(p.Bounds, secondsBounds) || rate.AsString() != "poor" {
				t.Errorf("lcp unit %s bounds %v rating %s", m.Unit, p.Bounds, rate.AsString())
			}
		default:
			t.Errorf("unexpected histogram %s", m.Name)
		}
		if !m.Data.(metricdata.Histogram[float64]).DataPoints[0].Time.Equal(time.Unix(1, 0)) {
			t.Error("clock not used")
		}
	}
	if seen != 2 {
		t.Fatalf("%d histograms", seen)
	}
}

func TestSummaryReactNative(t *testing.T) {
	d, agg := newTestDeriver()
	rec := baseSummary(0)
	rec.PutStr("o11y.rum.platform", "react_native")
	rec.PutStr("o11y.rum.view.kind", "screen")
	rec.PutStr("o11y.rum.view.name", "Checkout")
	rec.PutDouble("o11y.rum.summary.ttfb.value", 0.9)
	d.summary("shop-app", attrLookup{record: rec, resource: pcommon.NewMap()})
	got := flatten(agg.Produce())
	want := map[string]float64{
		"o11y.rum.views{o11y.rum.platform=react_native,o11y.rum.view.kind=screen,o11y.rum.view.name=Checkout,service.name=shop-app}": 1,
		"o11y.rum.vital.ttfb{o11y.rum.view.name=Checkout,o11y.rum.vital.rating=needs-improvement,service.name=shop-app}#count":       1,
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got\n%v\nwant\n%v", got, want)
	}
}

func TestSummaryLabelsAreSpecLabels(t *testing.T) {
	// A string attribute that is not a label of a metric never reaches it,
	// and a label whose value is not a string is left out.
	d, agg := newTestDeriver()
	rec := baseSummary(0)
	rec.PutStr("o11y.rum.connection.type", "wifi")
	rec.PutInt("o11y.rum.device.class", 3)
	rec.PutDouble("o11y.rum.summary.inp.value", 0.1)
	d.summary("shop-web", attrLookup{record: rec, resource: pcommon.NewMap()})
	for k := range flatten(agg.Produce()) {
		if strings.Contains(k, "connection.type") || strings.Contains(k, "device.class") ||
			strings.Contains(k, "session.id") || strings.Contains(k, "view.id") {
			t.Fatalf("series %s", k)
		}
	}
}

func TestDeriveLogsOnlyReadsSummaries(t *testing.T) {
	d, agg := newTestDeriver()
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	recs := rl.ScopeLogs().AppendEmpty().LogRecords()
	errRec := recs.AppendEmpty()
	errRec.SetEventName(eventRUMError)
	baseSummary(0).CopyTo(errRec.Attributes())
	errRec.Attributes().PutStr("o11y.rum.error.source", "uncaught")
	sum := recs.AppendEmpty()
	baseSummary(0).CopyTo(sum.Attributes())
	sum.Attributes().PutStr("event.name", eventViewSummary) // the older carrier
	d.logs("shop-web", ld)
	got := flatten(agg.Produce())
	if len(got) != 1 {
		t.Fatalf("%v", got)
	}
	for k, v := range got {
		if !strings.HasPrefix(k, "o11y.rum.views{") || v != 1 {
			t.Fatalf("%s=%v", k, v)
		}
	}
}

func TestDerivedMetricsCarryRequiredLabels(t *testing.T) {
	// Every derived point carries the labels the spec requires of its
	// metric, given a summary that carries the view's identity.
	d, agg := newTestDeriver()
	rec := baseSummary(0)
	rec.PutInt("o11y.rum.summary.errors.csp", 1)
	rec.PutInt("o11y.rum.summary.frustrations.dead", 1)
	rec.PutInt("o11y.rum.summary.long_animation_frames", 1)
	for _, v := range []string{"lcp", "inp", "cls", "fcp", "ttfb"} {
		rec.PutDouble("o11y.rum.summary."+v+".value", 0.05)
	}
	d.summary("shop-web", attrLookup{record: rec, resource: pcommon.NewMap()})
	names := map[string]bool{}
	for _, m := range agg.Produce()[0].Metrics {
		names[m.Name] = true
		var sets [][]string
		switch data := m.Data.(type) {
		case metricdata.Sum[float64]:
			for _, p := range data.DataPoints {
				sets = append(sets, keysOf(p.Attributes.ToSlice()))
			}
		case metricdata.Histogram[float64]:
			for _, p := range data.DataPoints {
				sets = append(sets, keysOf(p.Attributes.ToSlice()))
			}
		}
		for _, keys := range sets {
			for _, req := range specRequired(m.Name) {
				if !slices.Contains(keys, req) {
					t.Errorf("%s lacks required %s: %v", m.Name, req, keys)
				}
			}
		}
	}
	if len(names) != len(standardMetrics) {
		t.Fatalf("derived %v, want all of %v", slices.Sorted(maps.Keys(names)), standardMetrics)
	}
}
