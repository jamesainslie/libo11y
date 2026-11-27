package aggregate

import (
	"errors"
	"math"
	"slices"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestSumsAccumulate(t *testing.T) {
	start := time.Unix(100, 0)
	now := start
	a := New(10, func() time.Time { return now })
	d := Desc{Scope: "s", Name: "views", Unit: "{view}", Description: "views", Kind: Sum, Monotonic: true}
	set := attribute.NewSet(attribute.String("service.name", "web"), attribute.String("o11y.rum.view.name", "/"))
	if err := a.Add(d, set, 1); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	if err := a.Add(d, set, 2); err != nil {
		t.Fatal(err)
	}
	sm := a.Produce()
	if len(sm) != 1 || sm[0].Scope.Name != "s" || len(sm[0].Metrics) != 1 {
		t.Fatalf("%+v", sm)
	}
	m := sm[0].Metrics[0]
	if m.Name != "views" || m.Unit != "{view}" || m.Description != "views" {
		t.Fatalf("%+v", m)
	}
	sum := m.Data.(metricdata.Sum[float64])
	if sum.Temporality != metricdata.CumulativeTemporality || !sum.IsMonotonic {
		t.Fatalf("%+v", sum)
	}
	if p := sum.DataPoints[0]; p.Value != 3 || !p.StartTime.Equal(start) || !p.Time.Equal(now) {
		t.Fatalf("%+v", p)
	}
}

func TestHistogramBuckets(t *testing.T) {
	a := New(10, time.Now)
	d := Desc{Scope: "s", Name: "lcp", Unit: "s", Kind: Histogram, Bounds: []float64{1, 2.5, 4}}
	set := attribute.NewSet(attribute.String("service.name", "web"))
	for _, v := range []float64{0.5, 1, 2.5, 3, 9} {
		if err := a.Record(d, set, v); err != nil {
			t.Fatal(err)
		}
	}
	hist := a.Produce()[0].Metrics[0].Data.(metricdata.Histogram[float64])
	if hist.Temporality != metricdata.CumulativeTemporality {
		t.Fatalf("temporality %v", hist.Temporality)
	}
	h := hist.DataPoints[0]
	// Buckets are upper-inclusive, as OpenTelemetry defines them: 1 falls in
	// (-inf, 1] and 2.5 in (1, 2.5].
	if !slices.Equal(h.BucketCounts, []uint64{2, 1, 1, 1}) || h.Count != 5 || h.Sum != 16 {
		t.Fatalf("%+v", h)
	}
	if !slices.Equal(h.Bounds, []float64{1, 2.5, 4}) {
		t.Fatalf("bounds %v", h.Bounds)
	}
	if mn, ok := h.Min.Value(); !ok || mn != 0.5 {
		t.Fatalf("min %v", mn)
	}
	if mx, ok := h.Max.Value(); !ok || mx != 9 {
		t.Fatalf("max %v", mx)
	}
}

func TestMergeDeltaHistogram(t *testing.T) {
	a := New(10, time.Now)
	d := Desc{Scope: "app", Name: "checkout.duration", Unit: "s", Kind: Histogram, Bounds: []float64{1, 2}}
	set := attribute.NewSet(attribute.String("service.name", "web"))
	lo, hi := 0.2, 3.0
	if err := a.Merge(d, set, []uint64{1, 0, 1}, 3.2, &lo, &hi); err != nil {
		t.Fatal(err)
	}
	if err := a.Merge(d, set, []uint64{0, 2, 0}, 3.0, nil, nil); err != nil {
		t.Fatal(err)
	}
	h := a.Produce()[0].Metrics[0].Data.(metricdata.Histogram[float64]).DataPoints[0]
	if !slices.Equal(h.BucketCounts, []uint64{1, 2, 1}) || h.Count != 4 || math.Abs(h.Sum-6.2) > 1e-12 {
		t.Fatalf("%+v", h)
	}
	if mn, _ := h.Min.Value(); mn != 0.2 {
		t.Fatalf("min %v", mn)
	}
	if mx, _ := h.Max.Value(); mx != 3 {
		t.Fatalf("max %v", mx)
	}
	if err := a.Merge(d, set, []uint64{1, 1}, 1, nil, nil); err == nil {
		t.Fatal("wrong bucket count accepted")
	}
}

func TestMergeWithoutExtremaOmitsThem(t *testing.T) {
	a := New(10, time.Now)
	d := Desc{Scope: "app", Name: "h", Unit: "s", Kind: Histogram, Bounds: []float64{1}}
	if err := a.Merge(d, attribute.NewSet(), []uint64{1, 1}, 2.5, nil, nil); err != nil {
		t.Fatal(err)
	}
	h := a.Produce()[0].Metrics[0].Data.(metricdata.Histogram[float64]).DataPoints[0]
	if _, ok := h.Min.Value(); ok {
		t.Fatal("min defined with no observed minimum")
	}
	if _, ok := h.Max.Value(); ok {
		t.Fatal("max defined with no observed maximum")
	}
}

func TestKindMismatchRefused(t *testing.T) {
	a := New(10, time.Now)
	sum := Desc{Scope: "s", Name: "x", Unit: "1", Kind: Sum, Monotonic: true}
	hist := Desc{Scope: "s", Name: "y", Unit: "1", Kind: Histogram, Bounds: []float64{1}}
	if err := a.Record(sum, attribute.NewSet(), 1); err == nil {
		t.Fatal("Record on a sum accepted")
	}
	if err := a.Add(hist, attribute.NewSet(), 1); err == nil {
		t.Fatal("Add on a histogram accepted")
	}
	if err := a.Merge(sum, attribute.NewSet(), []uint64{1}, 1, nil, nil); err == nil {
		t.Fatal("Merge on a sum accepted")
	}
	if len(a.Produce()) != 0 {
		t.Fatal("a refused measurement defined a metric")
	}
}

func TestConflictingDefinitionRefused(t *testing.T) {
	a := New(10, time.Now)
	set := attribute.NewSet()
	if err := a.Add(Desc{Scope: "s", Name: "x", Unit: "1", Kind: Sum, Monotonic: true}, set, 1); err != nil {
		t.Fatal(err)
	}
	for name, d := range map[string]Desc{
		"kind":      {Scope: "s", Name: "x", Unit: "1", Kind: Histogram, Bounds: []float64{1}},
		"unit":      {Scope: "s", Name: "x", Unit: "ms", Kind: Sum, Monotonic: true},
		"monotonic": {Scope: "s", Name: "x", Unit: "1", Kind: Sum},
	} {
		var err error
		if d.Kind == Histogram {
			err = a.Record(d, set, 1)
		} else {
			err = a.Add(d, set, 1)
		}
		if !errors.Is(err, ErrConflict) {
			t.Errorf("%s change: err %v", name, err)
		}
	}
	h := Desc{Scope: "s", Name: "h", Unit: "s", Kind: Histogram, Bounds: []float64{1, 2}}
	if err := a.Record(h, set, 1); err != nil {
		t.Fatal(err)
	}
	h2 := h
	h2.Bounds = []float64{1, 3}
	if err := a.Record(h2, set, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("bounds change: err %v", err)
	}
	// The same name in another scope is another metric.
	other := Desc{Scope: "t", Name: "x", Unit: "ms", Kind: Sum, Monotonic: true}
	if err := a.Add(other, set, 1); err != nil {
		t.Fatalf("other scope: %v", err)
	}
}

func TestDescriptionIsNotPartOfIdentity(t *testing.T) {
	a := New(10, time.Now)
	d := Desc{Scope: "s", Name: "x", Unit: "1", Description: "first", Kind: Sum, Monotonic: true}
	_ = a.Add(d, attribute.NewSet(), 1)
	d.Description = "second"
	if err := a.Add(d, attribute.NewSet(), 1); err != nil {
		t.Fatal(err)
	}
	if got := a.Produce()[0].Metrics[0].Description; got != "first" {
		t.Fatalf("description %q", got)
	}
}

func TestBoundsAreCopied(t *testing.T) {
	a := New(10, time.Now)
	bounds := []float64{1, 2}
	d := Desc{Scope: "s", Name: "h", Unit: "s", Kind: Histogram, Bounds: bounds}
	_ = a.Record(d, attribute.NewSet(), 1.5)
	bounds[0] = 10
	h := a.Produce()[0].Metrics[0].Data.(metricdata.Histogram[float64]).DataPoints[0]
	if h.Bounds[0] != 1 {
		t.Fatalf("caller's slice aliased: %v", h.Bounds)
	}
}

func TestSeriesCapOverflows(t *testing.T) {
	a := New(2, time.Now)
	d := Desc{Scope: "s", Name: "views", Unit: "{view}", Kind: Sum, Monotonic: true}
	for _, v := range []string{"/a", "/b", "/c", "/d"} {
		_ = a.Add(d, attribute.NewSet(attribute.String("service.name", "web"), attribute.String("o11y.rum.view.name", v)), 1)
	}
	// An existing series keeps counting after the cap is reached.
	_ = a.Add(d, attribute.NewSet(attribute.String("service.name", "web"), attribute.String("o11y.rum.view.name", "/a")), 1)
	pts := a.Produce()[0].Metrics[0].Data.(metricdata.Sum[float64]).DataPoints
	if len(pts) != 3 {
		t.Fatalf("%d points, want 2 plus overflow", len(pts))
	}
	var overflow, first float64
	for _, p := range pts {
		if v, ok := p.Attributes.Value("otel.metric.overflow"); ok && v.AsBool() {
			overflow = p.Value
			if s, _ := p.Attributes.Value("service.name"); s.AsString() != "web" {
				t.Fatal("overflow lost service.name")
			}
			if p.Attributes.Len() != 2 {
				t.Fatalf("overflow attributes %v", p.Attributes.ToSlice())
			}
		}
		if v, _ := p.Attributes.Value("o11y.rum.view.name"); v.AsString() == "/a" {
			first = p.Value
		}
	}
	if overflow != 2 || first != 2 {
		t.Fatalf("overflow %v, /a %v", overflow, first)
	}
	if got := a.SeriesCounts()["views"]; got != 3 {
		t.Fatalf("series %d", got)
	}
}

func TestOverflowIsPerService(t *testing.T) {
	a := New(1, time.Now)
	d := Desc{Scope: "s", Name: "views", Unit: "{view}", Kind: Sum, Monotonic: true}
	for _, svc := range []string{"a", "a", "b", "c"} {
		for _, v := range []string{"/x", "/y"} {
			_ = a.Add(d, attribute.NewSet(attribute.String("service.name", svc), attribute.String("o11y.rum.view.name", v)), 1)
		}
	}
	pts := a.Produce()[0].Metrics[0].Data.(metricdata.Sum[float64]).DataPoints
	overflow := map[string]float64{}
	for _, p := range pts {
		if v, ok := p.Attributes.Value("otel.metric.overflow"); ok && v.AsBool() {
			s, _ := p.Attributes.Value("service.name")
			overflow[s.AsString()] = p.Value
		}
	}
	// One real series, then one overflow series per service that overflows.
	if len(pts) != 4 || overflow["a"] != 2 || overflow["b"] != 2 || overflow["c"] != 2 {
		t.Fatalf("%d points, overflow %v", len(pts), overflow)
	}
}

func TestSeriesCountsSumAcrossScopes(t *testing.T) {
	a := New(10, time.Now)
	for _, scope := range []string{"s", "t"} {
		_ = a.Add(Desc{Scope: scope, Name: "x", Unit: "1", Kind: Sum, Monotonic: true}, attribute.NewSet(), 1)
	}
	if got := a.SeriesCounts(); got["x"] != 2 || len(got) != 1 {
		t.Fatalf("%v", got)
	}
}

func TestProduceIsDeterministicAndCopied(t *testing.T) {
	a := New(10, time.Now)
	h := Desc{Scope: "s", Name: "h", Unit: "s", Kind: Histogram, Bounds: []float64{1}}
	c := Desc{Scope: "t", Name: "c", Unit: "1", Kind: Sum, Monotonic: true}
	for _, v := range []string{"/z", "/a", "/m"} {
		set := attribute.NewSet(attribute.String("k", v))
		_ = a.Record(h, set, 0.5)
		_ = a.Add(c, set, 1)
	}
	first := a.Produce()
	second := a.Produce()
	if len(first) != 2 || first[0].Scope.Name != "s" || first[1].Scope.Name != "t" {
		t.Fatalf("scopes not in first-seen order: %+v", first)
	}
	keys := func(sm []metricdata.ScopeMetrics) []string {
		var out []string
		for _, p := range sm[0].Metrics[0].Data.(metricdata.Histogram[float64]).DataPoints {
			v, _ := p.Attributes.Value("k")
			out = append(out, v.AsString())
		}
		return out
	}
	if got := keys(first); !slices.Equal(got, []string{"/a", "/m", "/z"}) {
		t.Fatalf("order %v", got)
	}
	if !slices.Equal(keys(first), keys(second)) {
		t.Fatal("order changed between calls")
	}
	pts := first[0].Metrics[0].Data.(metricdata.Histogram[float64]).DataPoints
	pts[0].BucketCounts[0] = 99
	pts[0].Bounds[0] = 99
	again := a.Produce()[0].Metrics[0].Data.(metricdata.Histogram[float64]).DataPoints
	if again[0].BucketCounts[0] != 1 || again[0].Bounds[0] != 1 {
		t.Fatalf("Produce shares state: %+v", again[0])
	}
}

func TestInvalidValuesRefused(t *testing.T) {
	a := New(10, time.Now)
	sum := Desc{Scope: "s", Name: "c", Unit: "1", Kind: Sum, Monotonic: true}
	updown := Desc{Scope: "s", Name: "u", Unit: "1", Kind: Sum}
	hist := Desc{Scope: "s", Name: "h", Unit: "s", Kind: Histogram, Bounds: []float64{1}}
	set := attribute.NewSet()
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := a.Add(sum, set, v); !errors.Is(err, ErrValue) {
			t.Errorf("Add(%v): %v", v, err)
		}
		if err := a.Record(hist, set, v); !errors.Is(err, ErrValue) {
			t.Errorf("Record(%v): %v", v, err)
		}
		if err := a.Merge(hist, set, []uint64{1, 0}, v, nil, nil); !errors.Is(err, ErrValue) {
			t.Errorf("Merge sum %v: %v", v, err)
		}
		if err := a.Merge(hist, set, []uint64{1, 0}, 0, &v, nil); !errors.Is(err, ErrValue) {
			t.Errorf("Merge min %v: %v", v, err)
		}
	}
	if err := a.Add(sum, set, -1); !errors.Is(err, ErrValue) {
		t.Errorf("negative add to a monotonic sum: %v", err)
	}
	if err := a.Add(updown, set, -1); err != nil {
		t.Errorf("negative add to a non-monotonic sum: %v", err)
	}
	if got := a.SeriesCounts(); got["c"] != 0 || got["h"] != 0 {
		t.Fatalf("refused values made series: %v", got)
	}
}

func TestEmptyProducesNothing(t *testing.T) {
	if got := New(10, time.Now).Produce(); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestConcurrentUse(t *testing.T) {
	a := New(100, time.Now)
	d := Desc{Scope: "s", Name: "views", Unit: "{view}", Kind: Sum, Monotonic: true}
	h := Desc{Scope: "s", Name: "lcp", Unit: "s", Kind: Histogram, Bounds: []float64{1}}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 100 {
				_ = a.Add(d, attribute.NewSet(), 1)
				_ = a.Record(h, attribute.NewSet(), 0.5)
				_ = a.Produce()
				_ = a.SeriesCounts()
			}
		})
	}
	wg.Wait()
	if v := a.Produce()[0].Metrics[0].Data.(metricdata.Sum[float64]).DataPoints[0].Value; v != 800 {
		t.Fatalf("sum %v", v)
	}
}

func TestHistogramBoundsMustIncrease(t *testing.T) {
	a := New(10, time.Now)
	for _, b := range [][]float64{{2, 1}, {1, 1}, {math.NaN()}, {1, math.Inf(1)}} {
		d := Desc{Scope: "s", Name: "h", Unit: "s", Kind: Histogram, Bounds: b}
		if err := a.Record(d, attribute.NewSet(), 1); err == nil {
			t.Errorf("bounds %v accepted", b)
		}
		if err := a.Merge(d, attribute.NewSet(), make([]uint64, len(b)+1), 1, nil, nil); err == nil {
			t.Errorf("merge with bounds %v accepted", b)
		}
	}
	// No bounds is one bucket holding everything.
	d := Desc{Scope: "s", Name: "one", Unit: "s", Kind: Histogram}
	if err := a.Record(d, attribute.NewSet(), 5); err != nil {
		t.Fatal(err)
	}
}
