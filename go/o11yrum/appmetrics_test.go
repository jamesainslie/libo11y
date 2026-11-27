package o11yrum

import (
	"context"
	"maps"
	"net/http"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// appMetricsBatch returns a batch for shop-web with resource attributes a
// browser would send, and the scope "shop-web" to add metrics to.
func appMetricsBatch() (pmetric.Metrics, pmetric.MetricSlice) {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	res := rm.Resource().Attributes()
	res.PutStr("service.name", "shop-web")
	res.PutStr("service.instance.id", "browser-1")
	res.PutStr("browser.brands", "x")
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName("shop-web")
	return md, sm.Metrics()
}

func addDeltaSum(ms pmetric.MetricSlice, name string, v int64, attrs map[string]string) pmetric.Metric {
	m := ms.AppendEmpty()
	m.SetName(name)
	m.SetUnit("{item}")
	sum := m.SetEmptySum()
	sum.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	sum.SetIsMonotonic(true)
	dp := sum.DataPoints().AppendEmpty()
	dp.SetIntValue(v)
	for k, val := range attrs {
		dp.Attributes().PutStr(k, val)
	}
	return m
}

func addDeltaHistogram(ms pmetric.MetricSlice, name string, bounds []float64, counts []uint64, sum float64) pmetric.Metric {
	m := ms.AppendEmpty()
	m.SetName(name)
	m.SetUnit("s")
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	dp := h.DataPoints().AppendEmpty()
	dp.ExplicitBounds().FromRaw(bounds)
	dp.BucketCounts().FromRaw(counts)
	var n uint64
	for _, c := range counts {
		n += c
	}
	dp.SetCount(n)
	dp.SetSum(sum)
	return m
}

func postMetrics(t *testing.T, h http.Handler, md pmetric.Metrics, remote string) (int, pmetricotlp.ExportResponse) {
	t.Helper()
	body, err := pmetricotlp.NewExportRequestFromMetrics(md).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	w := send(h, http.MethodPost, "/_o11y/v1/metrics", "application/json", "https://shop.example", remote, body)
	resp := pmetricotlp.NewExportResponse()
	if w.Code == 200 {
		if err := resp.UnmarshalJSON(w.Body.Bytes()); err != nil {
			t.Fatalf("response %q: %v", w.Body, err)
		}
	}
	return w.Code, resp
}

func collect(t *testing.T, r *sdkmetric.ManualReader) []metricdata.ScopeMetrics {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := r.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	return rm.ScopeMetrics
}

func TestAppMetricSumMerged(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	sink := &recordingSink{}
	h := newLabelHandler(t, p, []string{"shop.step"}, WithSinks(sink))
	for i, remote := range []string{"203.0.113.5:1000", "203.0.113.6:1000"} {
		md, ms := appMetricsBatch()
		md.ResourceMetrics().At(0).Resource().Attributes().PutStr("service.instance.id", "browser-"+remote)
		addDeltaSum(ms, "shop.cart.adds", 2, map[string]string{"shop.step": "checkout"})
		if code, resp := postMetrics(t, h, md, remote); code != 200 || resp.PartialSuccess().RejectedDataPoints() != 0 {
			t.Fatalf("request %d: %d %v", i, code, resp.PartialSuccess().ErrorMessage())
		}
	}
	if sink.count() != 0 {
		t.Fatal("app metrics reached a sink")
	}
	sms := collect(t, r)
	if len(sms) != 1 || sms[0].Scope.Name != "shop-web" {
		t.Fatalf("scopes %+v", sms)
	}
	got := flatten(sms)
	want := map[string]float64{"shop.cart.adds{service.name=shop-web,shop.step=checkout}": 4}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	m := sms[0].Metrics[0]
	if m.Unit != "{item}" || !m.Data.(metricdata.Sum[float64]).IsMonotonic {
		t.Fatalf("%+v", m)
	}
}

func TestAppMetricHistogramMerged(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newProducerHandler(t, p)
	for _, b := range []struct {
		remote string
		counts []uint64
		sum    float64
	}{{"203.0.113.5:1000", []uint64{1, 2, 0}, 1.5}, {"203.0.113.6:1000", []uint64{0, 1, 3}, 9}} {
		md, ms := appMetricsBatch()
		addDeltaHistogram(ms, "shop.checkout.duration", []float64{0.1, 1}, b.counts, b.sum)
		if code, _ := postMetrics(t, h, md, b.remote); code != 200 {
			t.Fatalf("status %d", code)
		}
	}
	pt := collect(t, r)[0].Metrics[0].Data.(metricdata.Histogram[float64]).DataPoints[0]
	if !slices.Equal(pt.BucketCounts, []uint64{1, 3, 3}) || pt.Count != 7 || pt.Sum != 10.5 || !slices.Equal(pt.Bounds, []float64{0.1, 1}) {
		t.Fatalf("%+v", pt)
	}
}

func TestAppMetricDrops(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newProducerHandler(t, p)
	md, ms := appMetricsBatch()
	addDeltaHistogram(ms, "shop.first", []float64{1}, []uint64{1, 0}, 0.5)
	addDeltaSum(ms, "shop.ok", 1, nil)
	cumulative := addDeltaSum(ms, "shop.total", 1, nil)
	cumulative.Sum().SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	gauge := ms.AppendEmpty()
	gauge.SetName("shop.gauge")
	gauge.SetEmptyGauge().DataPoints().AppendEmpty().SetDoubleValue(1)
	exp := ms.AppendEmpty()
	exp.SetName("shop.exp")
	exph := exp.SetEmptyExponentialHistogram()
	exph.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	exph.DataPoints().AppendEmpty().SetCount(1)
	addDeltaSum(ms, "o11y.rum.views", 1, nil)
	addDeltaSum(ms, "o11yrum.aggregator.series", 1, nil)
	addDeltaHistogram(ms, "shop.first", []float64{2}, []uint64{1, 0}, 0.5) // bounds changed
	two := addDeltaSum(ms, "shop.two", 1, nil)
	two.Sum().DataPoints().AppendEmpty().SetIntValue(-1) // negative on a monotonic sum
	code, resp := postMetrics(t, h, md, "203.0.113.5:1000")
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	// cumulative 1, gauge 1, exponential 1, reserved 2, conflict 1, invalid 1.
	if got := resp.PartialSuccess().RejectedDataPoints(); got != 7 {
		t.Fatalf("rejected %d: %s", got, resp.PartialSuccess().ErrorMessage())
	}
	msg := resp.PartialSuccess().ErrorMessage()
	for _, reason := range []string{"cumulative=1", "unsupported_metric=2", "reserved_metric=2", "conflict=1", "invalid_value=1"} {
		if !strings.Contains(msg, reason) {
			t.Errorf("message %q lacks %s", msg, reason)
		}
	}
	got := flatten(collect(t, r))
	want := map[string]float64{
		"shop.first{service.name=shop-web}#count": 1,
		"shop.ok{service.name=shop-web}":          1,
		"shop.two{service.name=shop-web}":         1,
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestAppMetricInvalidNames(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newProducerHandler(t, p)
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "", 1, nil)
	addDeltaSum(ms, "9lives", 1, nil)
	addDeltaSum(ms, strings.Repeat("a", 256), 1, nil)
	addDeltaSum(ms, "shop.unit", 1, nil).SetUnit(strings.Repeat("u", 64))
	// A client may not write into the gateway's own scope.
	own := md.ResourceMetrics().At(0).ScopeMetrics().AppendEmpty()
	own.Scope().SetName(scopeName)
	addDeltaSum(own.Metrics(), "shop.sneaky", 1, nil)
	code, resp := postMetrics(t, h, md, "203.0.113.5:1000")
	if code != 200 || resp.PartialSuccess().RejectedDataPoints() != 5 {
		t.Fatalf("%d rejected %d: %s", code, resp.PartialSuccess().RejectedDataPoints(), resp.PartialSuccess().ErrorMessage())
	}
	if got := flatten(collect(t, r)); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricCountPerApp(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	cfg, err := ParseConfig([]byte("aggregation: {max_metrics_per_app: 2}\n" + testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithMetricProducer(p))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	md, ms := appMetricsBatch()
	for _, name := range []string{"shop.a", "shop.b", "shop.c", "shop.a"} {
		addDeltaSum(ms, name, 1, nil)
	}
	code, resp := postMetrics(t, h, md, "203.0.113.5:1000")
	if code != 200 || resp.PartialSuccess().RejectedDataPoints() != 1 || !strings.Contains(resp.PartialSuccess().ErrorMessage(), "metric_limit=1") {
		t.Fatalf("%d %s", code, resp.PartialSuccess().ErrorMessage())
	}
	if got := flatten(collect(t, r)); len(got) != 2 || got["shop.a{service.name=shop-web}"] != 2 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricUnboundedAttributesRemoved(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	// Listing a key never brings back the unbounded ones.
	h := newLabelHandler(t, p, []string{"shop.step"})
	md, ms := appMetricsBatch()
	m := addDeltaSum(ms, "shop.cart.adds", 1, map[string]string{
		"shop.step":             "checkout",
		"session.id":            "s1",
		"o11y.rum.element.text": "Buy now",
		"o11y.rum.platform":     "web",
	})
	ex := m.Sum().DataPoints().At(0).Exemplars().AppendEmpty()
	ex.SetIntValue(1)
	if code, _ := postMetrics(t, h, md, "203.0.113.5:1000"); code != 200 {
		t.Fatalf("status %d", code)
	}
	got := flatten(collect(t, r))
	want := map[string]float64{"shop.cart.adds{o11y.rum.platform=web,service.name=shop-web,shop.step=checkout}": 1}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestAppMetricNonStringAttributes(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newLabelHandler(t, p, []string{"shop.items", "shop.member"})
	md, ms := appMetricsBatch()
	m := addDeltaSum(ms, "shop.cart.adds", 1, nil)
	m.Sum().DataPoints().At(0).Attributes().PutInt("shop.items", 3)
	m.Sum().DataPoints().At(0).Attributes().PutBool("shop.member", true)
	if code, _ := postMetrics(t, h, md, "203.0.113.5:1000"); code != 200 {
		t.Fatalf("status %d", code)
	}
	if got := flatten(collect(t, r)); got["shop.cart.adds{service.name=shop-web,shop.items=3,shop.member=true}"] != 1 {
		t.Fatalf("%v", got)
	}
}

func TestValidateMetricsCleansInPlace(t *testing.T) {
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	v := &validator{policy: newAttrPolicy(cfg.Apps[0], cfg.Limits), limits: cfg.Limits}
	md, ms := appMetricsBatch()
	m := addDeltaSum(ms, "shop.cart.adds", 1, map[string]string{"session.id": "s1", "shop.step": "x"})
	m.Sum().DataPoints().At(0).Exemplars().AppendEmpty()
	h := addDeltaHistogram(ms, "shop.h", []float64{1}, []uint64{1, 0}, 1)
	h.Histogram().DataPoints().At(0).Attributes().PutStr("session.id", "s1")
	h.Histogram().DataPoints().At(0).Exemplars().AppendEmpty()
	if drops := v.metrics(md); drops.total() != 0 {
		t.Fatalf("%v", drops)
	}
	if _, ok := md.ResourceMetrics().At(0).Resource().Attributes().Get("service.instance.id"); ok {
		t.Error("resource not validated")
	}
	sdp := m.Sum().DataPoints().At(0)
	if _, ok := sdp.Attributes().Get("session.id"); ok || sdp.Exemplars().Len() != 0 {
		t.Errorf("sum point %v exemplars %d", sdp.Attributes().AsRaw(), sdp.Exemplars().Len())
	}
	hdp := h.Histogram().DataPoints().At(0)
	if _, ok := hdp.Attributes().Get("session.id"); ok || hdp.Exemplars().Len() != 0 {
		t.Errorf("histogram point %v exemplars %d", hdp.Attributes().AsRaw(), hdp.Exemplars().Len())
	}
}

func TestAppMetricsWithoutProducer(t *testing.T) {
	// The endpoint still validates and answers 200, and tells the client
	// its points were not kept.
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.cart.adds", 1, nil)
	addDeltaHistogram(ms, "shop.h", []float64{1}, []uint64{1, 0}, 0.5)
	code, resp := postMetrics(t, newTestHandler(t), md, "203.0.113.5:1000")
	if code != 200 || resp.PartialSuccess().RejectedDataPoints() != 2 || !strings.Contains(resp.PartialSuccess().ErrorMessage(), "no_producer=2") {
		t.Fatalf("%d %d %s", code, resp.PartialSuccess().RejectedDataPoints(), resp.PartialSuccess().ErrorMessage())
	}
}

func TestAppMetricBoundsCapped(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newProducerHandler(t, p)
	md, ms := appMetricsBatch()
	bounds := make([]float64, maxAppBounds+1)
	for i := range bounds {
		bounds[i] = float64(i)
	}
	wide := make([]uint64, len(bounds)+1)
	wide[0] = 1
	ok := make([]uint64, maxAppBounds+1)
	ok[0] = 1
	addDeltaHistogram(ms, "shop.wide", bounds, wide, 0)
	addDeltaHistogram(ms, "shop.ok", bounds[:maxAppBounds], ok, 0)
	code, resp := postMetrics(t, h, md, "203.0.113.5:1000")
	if code != 200 || resp.PartialSuccess().RejectedDataPoints() != 1 || !strings.Contains(resp.PartialSuccess().ErrorMessage(), "invalid_value=1") {
		t.Fatalf("%d %s", code, resp.PartialSuccess().ErrorMessage())
	}
	if got := flatten(collect(t, r)); len(got) != 1 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricsAreAppScoped(t *testing.T) {
	// One app's definition of a metric never conflicts with another app's.
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h, err := NewHandler(WithConfig(cfg), WithMetricProducer(p))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "cart.adds", 1, nil)
	if code, _ := postMetrics(t, h, md, "203.0.113.5:1000"); code != 200 {
		t.Fatal(code)
	}
	other, oms := appMetricsBatch()
	other.ResourceMetrics().At(0).Resource().Attributes().PutStr("service.name", "shop-mobile")
	addDeltaHistogram(oms, "cart.adds", []float64{1}, []uint64{1, 0}, 0.5)
	body, err := pmetricotlp.NewExportRequestFromMetrics(other).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	w := send(h, http.MethodPost, "/_o11y/v1/metrics?client_token=pub-123", "application/json", "", "203.0.113.6:1000", body)
	resp := pmetricotlp.NewExportResponse()
	if err := resp.UnmarshalJSON(w.Body.Bytes()); err != nil || w.Code != 200 || resp.PartialSuccess().RejectedDataPoints() != 0 {
		t.Fatalf("%d %v %s", w.Code, err, resp.PartialSuccess().ErrorMessage())
	}
	got := flatten(collect(t, r))
	if got["cart.adds{service.name=shop-web}"] != 1 || got["cart.adds{service.name=shop-mobile}#count"] != 1 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricSlotTakenOnlyBySuccess(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	cfg, err := ParseConfig([]byte("aggregation: {max_metrics_per_app: 1}\n" + testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithMetricProducer(p))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.junk", -1, nil) // refused: negative on a monotonic sum
	addDeltaSum(ms, "shop.real", 1, nil)
	code, resp := postMetrics(t, h, md, "203.0.113.5:1000")
	if code != 200 || resp.PartialSuccess().RejectedDataPoints() != 1 || !strings.Contains(resp.PartialSuccess().ErrorMessage(), "invalid_value=1") {
		t.Fatalf("%d %s", code, resp.PartialSuccess().ErrorMessage())
	}
	if got := flatten(collect(t, r)); got["shop.real{service.name=shop-web}"] != 1 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricLabelBudget(t *testing.T) {
	// The caps apply to listed labels too. A key too long to list is
	// dropped as unlisted, and the point keeps its other labels.
	p := NewMetricProducer()
	r := newManualReader(t, p)
	wide := map[string]string{}
	listed := []string{"shop.step"}
	for i := range maxAppLabels + 1 {
		k := "shop.k" + strings.Repeat("x", i)
		wide[k] = "v"
		listed = append(listed, k)
	}
	h := newLabelHandler(t, p, listed)
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.wide", 1, wide)
	addDeltaSum(ms, "shop.long", 1, map[string]string{"shop.step": strings.Repeat("y", maxAppLabelLen+10)})
	addDeltaSum(ms, "shop.longkey", 1, map[string]string{"shop." + strings.Repeat("k", maxAppLabelLen): "v"})
	code, resp := postMetrics(t, h, md, "203.0.113.5:1000")
	if code != 200 || resp.PartialSuccess().RejectedDataPoints() != 1 || !strings.Contains(resp.PartialSuccess().ErrorMessage(), "label_budget=1") {
		t.Fatalf("%d %s", code, resp.PartialSuccess().ErrorMessage())
	}
	got := flatten(collect(t, r))
	if got["shop.long{service.name=shop-web,shop.step="+strings.Repeat("y", maxAppLabelLen)+"}"] != 1 || got["shop.longkey{service.name=shop-web}"] != 1 || len(got) != 2 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricsResponseIsProtobufForProtobuf(t *testing.T) {
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.cart.adds", 1, nil)
	body, err := pmetricotlp.NewExportRequestFromMetrics(md).MarshalProto()
	if err != nil {
		t.Fatal(err)
	}
	w := send(newTestHandler(t), http.MethodPost, "/_o11y/v1/metrics", "application/x-protobuf", "https://shop.example", "203.0.113.5:1000", body)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/x-protobuf" {
		t.Fatalf("%d %q", w.Code, w.Header().Get("Content-Type"))
	}
	resp := pmetricotlp.NewExportResponse()
	if err := resp.UnmarshalProto(w.Body.Bytes()); err != nil {
		t.Fatal(err)
	}
}

func TestAppMetricEmptyHistogramDeltas(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	cfg, err := ParseConfig([]byte("aggregation: {max_metrics_per_app: 1}\n" + testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithMetricProducer(p))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	md, ms := appMetricsBatch()
	addDeltaHistogram(ms, "shop.empty", []float64{1}, []uint64{0, 0}, 0)  // nothing observed: ignored
	addDeltaHistogram(ms, "shop.bogus", []float64{1}, []uint64{0, 0}, 3)  // a sum with no observations
	addDeltaHistogram(ms, "shop.real", []float64{1}, []uint64{1, 0}, 0.5) // takes the one slot
	code, resp := postMetrics(t, h, md, "203.0.113.5:1000")
	if code != 200 || resp.PartialSuccess().RejectedDataPoints() != 1 || !strings.Contains(resp.PartialSuccess().ErrorMessage(), "invalid_value=1") {
		t.Fatalf("%d %s", code, resp.PartialSuccess().ErrorMessage())
	}
	if got := flatten(collect(t, r)); len(got) != 1 || got["shop.real{service.name=shop-web}#count"] != 1 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricSetKeepsRacedMetrics(t *testing.T) {
	// A metric that aggregated a point keeps its slot even when a racing
	// request filled the last one, so it never freezes.
	s := &appMetricSet{max: 1, known: map[string]map[appMetricID]bool{}}
	a, b := appMetricID{"s", "a"}, appMetricID{"s", "b"}
	if !s.room("svc", a) || !s.room("svc", b) {
		t.Fatal("no room before either took the slot")
	}
	s.add("svc", a)
	s.add("svc", b)
	if !s.room("svc", a) || !s.room("svc", b) {
		t.Fatal("a raced metric lost its slot")
	}
	if s.room("svc", appMetricID{"s", "c"}) {
		t.Fatal("a new metric found room past the cap")
	}
}

// newLabelHandler returns a handler whose shop-web app lists labels in
// app_metric_labels, built with opts.
func newLabelHandler(t *testing.T, p *MetricProducer, labels []string, opts ...Option) *Handler {
	t.Helper()
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Apps[0].AppMetricLabels = labels
	h, err := NewHandler(append([]Option{WithConfig(cfg), WithMetricProducer(p)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func TestAppMetricUnclassifiedLabelsDropped(t *testing.T) {
	// Without an allow-list an app metric keeps only the labels the
	// specification classifies bounded or enum. The point still counts.
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newProducerHandler(t, p)
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.cart.adds", 1, map[string]string{
		"shop.step":         "checkout",
		"o11y.rum.platform": "web",
		"os.name":           "iOS",
		"o11y.label.step":   "pay", // a template the specification classifies unbounded
	})
	if code, resp := postMetrics(t, h, md, "203.0.113.5:1000"); code != 200 || resp.PartialSuccess().RejectedDataPoints() != 0 {
		t.Fatalf("%d %s", code, resp.PartialSuccess().ErrorMessage())
	}
	got := flatten(collect(t, r))
	want := map[string]float64{"shop.cart.adds{o11y.rum.platform=web,os.name=iOS,service.name=shop-web}": 1}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestAppMetricLabelAllowList(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newLabelHandler(t, p, []string{"shop.step", "shop.plan"})
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.cart.adds", 1, map[string]string{
		"shop.step":         "checkout",
		"shop.plan":         "pro",
		"shop.unlisted":     "x",
		"session.id":        "s1",
		"o11y.rum.platform": "web",
	})
	addDeltaHistogram(ms, "shop.checkout.duration", []float64{1}, []uint64{1, 0}, 0.5).
		Histogram().DataPoints().At(0).Attributes().PutStr("shop.step", "pay")
	if code, resp := postMetrics(t, h, md, "203.0.113.5:1000"); code != 200 || resp.PartialSuccess().RejectedDataPoints() != 0 {
		t.Fatalf("%d %s", code, resp.PartialSuccess().ErrorMessage())
	}
	got := flatten(collect(t, r))
	want := map[string]float64{
		"shop.cart.adds{o11y.rum.platform=web,service.name=shop-web,shop.plan=pro,shop.step=checkout}": 1,
		"shop.checkout.duration{service.name=shop-web,shop.step=pay}#count":                            1,
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestAppMetricAllowListIsPerApp(t *testing.T) {
	// shop-web's allow-list does not apply to shop-mobile.
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newLabelHandler(t, p, []string{"shop.step"})
	md, ms := appMetricsBatch()
	md.ResourceMetrics().At(0).Resource().Attributes().PutStr("service.name", "shop-mobile")
	addDeltaSum(ms, "shop.cart.adds", 1, map[string]string{"shop.step": "checkout"})
	body, err := pmetricotlp.NewExportRequestFromMetrics(md).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if w := send(h, http.MethodPost, "/_o11y/v1/metrics?client_token=pub-123", "application/json", "", "203.0.113.6:1000", body); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if got := flatten(collect(t, r)); got["shop.cart.adds{service.name=shop-mobile}"] != 1 || len(got) != 1 {
		t.Fatalf("%v", got)
	}
}

func TestAppMetricDroppedLabelsCounted(t *testing.T) {
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Apps[0].AppMetricLabels = []string{"shop.step"}
	// The resource loses its per-browser attributes either way.
	base := &validator{policy: newAttrPolicy(cfg.Apps[0], cfg.Limits), limits: cfg.Limits}
	bmd, bms := appMetricsBatch()
	addDeltaSum(bms, "shop.cart.adds", 1, nil)
	base.metrics(bmd)
	v := &validator{policy: newAttrPolicy(cfg.Apps[0], cfg.Limits), limits: cfg.Limits}
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.cart.adds", 1, map[string]string{"shop.step": "a", "shop.other": "b", "session.id": "s1", "o11y.rum.platform": "web"})
	v.metrics(md)
	attrs := ms.At(0).Sum().DataPoints().At(0).Attributes().AsRaw()
	if want := map[string]any{"shop.step": "a", "o11y.rum.platform": "web"}; !maps.Equal(attrs, want) {
		t.Fatalf("attributes %v want %v", attrs, want)
	}
	if n := v.attrsRemoved - base.attrsRemoved; n != 2 {
		t.Fatalf("point attributes removed %d, want 2", n)
	}
}

func TestAppLabelsRefusesLongKey(t *testing.T) {
	// The validator drops such a key before appLabels sees it, since no
	// allow-list may name it. appLabels still refuses one on its own.
	attrs := pcommon.NewMap()
	attrs.PutStr("shop."+strings.Repeat("k", maxAppLabelLen), "v")
	if _, ok := appLabels("shop-web", attrs); ok {
		t.Fatal("appLabels accepted a key longer than maxAppLabelLen")
	}
}

func TestAppMetricAllowListBeforeAttributeCap(t *testing.T) {
	// Unlisted labels go before limits.max_attributes counts, so junk
	// arriving first cannot push a listed label out.
	cfg, err := ParseConfig([]byte("limits: {max_attributes: 4}\n" + testConfig))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Apps[0].AppMetricLabels = []string{"shop.step"}
	v := &validator{policy: newAttrPolicy(cfg.Apps[0], cfg.Limits), limits: cfg.Limits}
	md, ms := appMetricsBatch()
	attrs := addDeltaSum(ms, "shop.cart.adds", 1, nil).Sum().DataPoints().At(0).Attributes()
	for i := range 8 {
		attrs.PutStr("shop.junk"+strings.Repeat("x", i), "v")
	}
	attrs.PutStr("shop.step", "pay")
	v.metrics(md)
	if got := attrs.AsRaw(); !maps.Equal(got, map[string]any{"shop.step": "pay"}) {
		t.Fatalf("attributes %v", got)
	}
}
