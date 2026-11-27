package o11yrum

import (
	"errors"
	"net/http"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// metricByName finds one metric in rm.
func metricByName(t *testing.T, rm metricdata.ResourceMetrics, name string) metricdata.Metrics {
	t.Helper()
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == name {
				if sm.Scope.Name != scopeName {
					t.Errorf("%s is in scope %q, want %q", name, sm.Scope.Name, scopeName)
				}
				return m
			}
		}
	}
	t.Fatalf("no metric %s", name)
	return metricdata.Metrics{}
}

// sumPoints renders an int64 sum's points as attribute set to value.
func sumPoints(t *testing.T, m metricdata.Metrics) map[attribute.Distinct]int64 {
	t.Helper()
	sum, ok := m.Data.(metricdata.Sum[int64])
	if !ok {
		t.Fatalf("%s is %T, want an int64 sum", m.Name, m.Data)
	}
	out := map[attribute.Distinct]int64{}
	for _, dp := range sum.DataPoints {
		out[dp.Attributes.Equivalent()] = dp.Value
	}
	return out
}

func set(kv ...string) attribute.Distinct {
	attrs := make([]attribute.KeyValue, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		attrs = append(attrs, attribute.String(kv[i], kv[i+1]))
	}
	s := attribute.NewSet(attrs...)
	return s.Equivalent()
}

func TestTelemetry(t *testing.T) {
	rec := o11ytest.Start(t)
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	failing := &recordingSink{}
	h, err := NewHandler(WithConfig(cfg), WithSDK(rec.SDK), WithSinks(&recordingSink{}, failing))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })

	// Accepted, with one attribute the policy removes.
	ld := sampleLogs()
	ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes().PutStr("client.address", "x")
	if w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.1:1", logsBody(t, ld)); w.Code != 200 {
		t.Fatalf("accepted: %d", w.Code)
	}
	// Partial: one invalid record.
	ld = plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	records := rl.ScopeLogs().AppendEmpty().LogRecords()
	summaryRecord(records.AppendEmpty())
	bad := records.AppendEmpty()
	summaryRecord(bad)
	bad.Attributes().Remove("o11y.rum.summary.seq")
	if w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.2:1", logsBody(t, ld)); w.Code != 200 {
		t.Fatalf("partial: %d", w.Code)
	}
	// Rejected: an unknown service.
	if w := postLogs(t, h, "nope", "https://shop.example", "", "203.0.113.3:1"); w.Code != 403 {
		t.Fatalf("unknown service: %d", w.Code)
	}
	// Rejected: a sink failure. Its dropped record and removed attribute
	// are not counted, because the client sends the batch again.
	failing.err = errors.New("down")
	bad.Attributes().PutStr("client.address", "x")
	if w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.4:1", logsBody(t, ld)); w.Code != 503 {
		t.Fatalf("sink failure: %d", w.Code)
	}
	// Rejected: undecodable traces.
	if w := send(h, http.MethodPost, "/_o11y/v1/traces", "application/json", "https://shop.example", "203.0.113.5:1", []byte("{")); w.Code != 400 {
		t.Fatalf("decode: %d", w.Code)
	}

	rm := rec.Metrics()
	batches := sumPoints(t, metricByName(t, rm, "o11yrum.batches"))
	want := map[attribute.Distinct]int64{
		set("o11yrum.app", "shop-web", "o11yrum.signal", "logs", "o11yrum.outcome", "accepted", "o11yrum.reason", "ok"):             1,
		set("o11yrum.app", "shop-web", "o11yrum.signal", "logs", "o11yrum.outcome", "partial", "o11yrum.reason", "ok"):              1,
		set("o11yrum.app", "unknown", "o11yrum.signal", "logs", "o11yrum.outcome", "rejected", "o11yrum.reason", "unknown_service"): 1,
		set("o11yrum.app", "shop-web", "o11yrum.signal", "logs", "o11yrum.outcome", "rejected", "o11yrum.reason", "sink"):           1,
		set("o11yrum.app", "unknown", "o11yrum.signal", "traces", "o11yrum.outcome", "rejected", "o11yrum.reason", "decode"):        1,
	}
	if len(batches) != len(want) {
		t.Errorf("o11yrum.batches has %d series, want %d", len(batches), len(want))
	}
	for k, v := range want {
		if batches[k] != v {
			t.Errorf("o11yrum.batches %v = %d, want %d", k, batches[k], v)
		}
	}

	dropped := sumPoints(t, metricByName(t, rm, "o11yrum.records.dropped"))
	if got := dropped[set("o11yrum.app", "shop-web", "o11yrum.signal", "logs", "o11yrum.reason", "event_required")]; got != 1 || len(dropped) != 1 {
		t.Errorf("o11yrum.records.dropped %v", dropped)
	}

	removed := sumPoints(t, metricByName(t, rm, "o11yrum.attributes.removed"))
	if got := removed[set("o11yrum.app", "shop-web", "o11yrum.signal", "logs")]; got != 1 {
		t.Errorf("o11yrum.attributes.removed %v", removed)
	}

	dur := metricByName(t, rm, "o11yrum.sink.duration")
	if dur.Unit != "s" {
		t.Errorf("o11yrum.sink.duration unit %q", dur.Unit)
	}
	hist, ok := dur.Data.(metricdata.Histogram[float64])
	if !ok {
		t.Fatalf("o11yrum.sink.duration is %T", dur.Data)
	}
	if len(hist.DataPoints) == 0 || hist.DataPoints[0].Bounds[0] != 0.001 {
		t.Errorf("o11yrum.sink.duration buckets are not sized for seconds: %v", hist.DataPoints)
	}
	counts := map[attribute.Distinct]uint64{}
	for _, dp := range hist.DataPoints {
		counts[dp.Attributes.Equivalent()] = dp.Count
	}
	// Three exports reached the sinks: the accepted, the partial and the
	// failed one. Both sinks are timed each time.
	if got := counts[set("o11yrum.sink", "recording", "o11yrum.outcome", "ok")]; got != 5 {
		t.Errorf("successful sink exports %d, want 5: %v", got, counts)
	}
	if got := counts[set("o11yrum.sink", "recording", "o11yrum.outcome", "error")]; got != 1 {
		t.Errorf("failed sink exports %d, want 1: %v", got, counts)
	}
}

func TestTelemetryWithoutProvider(t *testing.T) {
	tel := newTelemetry(nil, nil)
	tel.batch(t.Context(), "a", SignalLogs, outcomeAccepted, reasonOK)
	tel = newTelemetry(noop.NewMeterProvider(), nil)
	tel.batch(t.Context(), "a", SignalLogs, outcomeAccepted, reasonOK)
}
