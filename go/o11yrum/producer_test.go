package o11yrum

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// summaryLogs is one valid view summary for shop-web.
func summaryLogs() plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	lr := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	lr.SetEventName(eventViewSummary)
	baseSummary(0).CopyTo(lr.Attributes())
	lr.Attributes().PutDouble(keySummaryLCP, 1.2)
	return ld
}

func postSummary(t *testing.T, h http.Handler, remote string) int {
	t.Helper()
	return send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", remote, logsBody(t, summaryLogs())).Code
}

// newManualReader returns a reader over p, attached to a throwaway meter
// provider so Collect works.
func newManualReader(t *testing.T, p *MetricProducer) *sdkmetric.ManualReader {
	t.Helper()
	r := sdkmetric.NewManualReader(sdkmetric.WithProducer(p))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(r))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })
	return r
}

// viewsTotal collects r and returns the summed o11y.rum.views.
func viewsTotal(t *testing.T, r *sdkmetric.ManualReader) float64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := r.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	var total float64
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != metricViews {
				continue
			}
			for _, p := range m.Data.(metricdata.Sum[float64]).DataPoints {
				total += p.Value
			}
		}
	}
	return total
}

func newProducerHandler(t *testing.T, p *MetricProducer, opts ...Option) *Handler {
	t.Helper()
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(append([]Option{WithConfig(cfg), WithMetricProducer(p)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func TestProducerBeforeBindProducesNothing(t *testing.T) {
	got, err := NewMetricProducer().Produce(context.Background())
	if got != nil || err != nil {
		t.Fatalf("%v, %v", got, err)
	}
}

func TestProducerBindsOnce(t *testing.T) {
	p := NewMetricProducer()
	newProducerHandler(t, p)
	cfg, _ := ParseConfig([]byte(testConfig))
	if _, err := NewHandler(WithConfig(cfg), WithMetricProducer(p)); err == nil || !strings.Contains(err.Error(), "already bound") {
		t.Fatalf("err %v", err)
	}
}

func TestIngestDerivesAfterSinkSuccess(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	sink := &recordingSink{}
	h := newProducerHandler(t, p, WithSinks(sink))
	if code := postSummary(t, h, "203.0.113.5:1000"); code != 200 {
		t.Fatalf("status %d", code)
	}
	if got := viewsTotal(t, r); got != 1 {
		t.Fatalf("views %v, want 1", got)
	}
	// A failed export answers 503 and the client retries the batch, so it
	// must not count yet.
	sink.mu.Lock()
	sink.err = errors.New("collector down")
	sink.mu.Unlock()
	if code := postSummary(t, h, "203.0.113.6:1000"); code != 503 {
		t.Fatalf("status %d, want 503", code)
	}
	if got := viewsTotal(t, r); got != 1 {
		t.Fatalf("views %v after a 503, want 1", got)
	}
	sink.mu.Lock()
	sink.err = nil
	sink.mu.Unlock()
	if code := postSummary(t, h, "203.0.113.6:1000"); code != 200 {
		t.Fatalf("status %d", code)
	}
	if got := viewsTotal(t, r); got != 2 {
		t.Fatalf("views %v after the retry, want 2", got)
	}
}

func TestIngestDerivesWithoutSinks(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newProducerHandler(t, p)
	if code := postSummary(t, h, "203.0.113.5:1000"); code != 200 {
		t.Fatalf("status %d", code)
	}
	if got := viewsTotal(t, r); got != 1 {
		t.Fatalf("views %v, want 1", got)
	}
}

func TestIngestDerivesOnlyValidatedSummaries(t *testing.T) {
	// A summary missing a required attribute is dropped by validation and
	// counts nothing.
	p := NewMetricProducer()
	r := newManualReader(t, p)
	h := newProducerHandler(t, p)
	ld := summaryLogs()
	ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes().Remove(keyViewID)
	w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.5:1000", logsBody(t, ld))
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if got := viewsTotal(t, r); got != 0 {
		t.Fatalf("views %v, want 0", got)
	}
}

func TestHandlerWithoutProducerDerivesNothing(t *testing.T) {
	h := newTestHandler(t)
	if h.derive != nil {
		t.Fatal("a handler without a producer built a deriver")
	}
	if code := postSummary(t, h, "203.0.113.5:1000"); code != 200 {
		t.Fatalf("status %d", code)
	}
}

func TestAggregationConfig(t *testing.T) {
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Aggregation.MaxSeriesPerMetric != 2000 {
		t.Fatalf("default %d", cfg.Aggregation.MaxSeriesPerMetric)
	}
	_, err = ParseConfig([]byte("aggregation: {max_series_per_metric: -1}\n" + testConfig))
	if err == nil || !strings.Contains(err.Error(), "aggregation.max_series_per_metric must be positive") {
		t.Fatalf("err %v", err)
	}
}

func TestAggregatorSeriesCap(t *testing.T) {
	p := NewMetricProducer()
	r := newManualReader(t, p)
	cfg, err := ParseConfig([]byte("aggregation: {max_series_per_metric: 1}\n" + testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithMetricProducer(p))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	for i, name := range []string{"/a", "/b", "/c"} {
		ld := summaryLogs()
		ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes().PutStr(keyViewName, name)
		remote := "203.0.113." + string(rune('1'+i)) + ":1000"
		if w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", remote, logsBody(t, ld)); w.Code != 200 {
			t.Fatalf("status %d", w.Code)
		}
	}
	if got := viewsTotal(t, r); got != 3 {
		t.Fatalf("views %v, want 3 with overflow", got)
	}
}

func TestAggregatorSeriesGauge(t *testing.T) {
	rec := o11ytest.Start(t)
	p := NewMetricProducer()
	h := newProducerHandler(t, p, WithSDK(rec.SDK))
	if code := postSummary(t, h, "203.0.113.5:1000"); code != 200 {
		t.Fatalf("status %d", code)
	}
	series := map[string]int64{}
	for _, sm := range rec.Metrics().ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "o11yrum.aggregator.series" {
				continue
			}
			for _, pt := range m.Data.(metricdata.Gauge[int64]).DataPoints {
				v, _ := pt.Attributes.Value("o11yrum.metric")
				series[v.AsString()] = pt.Value
			}
		}
	}
	if series[metricViews] != 1 || series[metricLCP] != 1 {
		t.Fatalf("series %v", series)
	}
	// Close unregisters the callback.
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	for _, sm := range rec.Metrics().ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == "o11yrum.aggregator.series" && len(m.Data.(metricdata.Gauge[int64]).DataPoints) > 0 {
				t.Fatal("gauge still reported after Close")
			}
		}
	}
}
