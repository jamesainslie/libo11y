package o11yrum

import (
	"context"
	"maps"
	"net/http"
	"slices"
	"strings"
	"testing"

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
	h := newProducerHandler(t, p, WithSinks(sink))
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
	h := newProducerHandler(t, p)
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
	h := newProducerHandler(t, p)
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
	md, ms := appMetricsBatch()
	addDeltaSum(ms, "shop.cart.adds", 1, nil)
	if code, _ := postMetrics(t, newTestHandler(t), md, "203.0.113.5:1000"); code != 200 {
		t.Fatalf("status %d", code)
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
