package o11y

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

// captureExporter records the spans handed to it so a test can inspect the
// attribute set that survives the redacting wrapper.
type captureExporter struct {
	mu    sync.Mutex
	spans []sdktrace.ReadOnlySpan
}

func (c *captureExporter) ExportSpans(_ context.Context, spans []sdktrace.ReadOnlySpan) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spans = append(c.spans, spans...)
	return nil
}

func (c *captureExporter) Shutdown(context.Context) error { return nil }

func (c *captureExporter) captured() []sdktrace.ReadOnlySpan {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.spans
}

// secretPolicy returns a policy that classifies key as Secret on top of the
// generated table. The runtime table currently carries no Secret-classified
// attribute, so the redaction path is exercised against a key the test
// controls, without mutating the shared generated table.
func secretPolicy(key attribute.Key) *sensitivityPolicy {
	s := newSettings([]Option{WithSensitivityForTest(map[attribute.Key]spectables.Sensitivity{key: spectables.Secret})})
	return newSensitivityPolicy(s, nil)
}

func TestRedactingExporterDropsSecretSpanAttr(t *testing.T) {
	const secretKey = attribute.Key("test.secret.token")
	const publicKey = attribute.Key("service.name")

	stub := &captureExporter{}
	exp := redactingExporter(stub, secretPolicy(secretKey))

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exp)),
	)
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	tracer := tp.Tracer("test")
	_, span := tracer.Start(context.Background(), "op")
	span.SetAttributes(
		secretKey.String("hunter2"),
		publicKey.String("checkout"),
	)
	span.End()

	spans := stub.captured()
	if len(spans) != 1 {
		t.Fatalf("captured %d spans, want 1", len(spans))
	}
	var sawSecret, sawPublic bool
	for _, a := range spans[0].Attributes() {
		if a.Key == secretKey {
			sawSecret = true
		}
		if a.Key == publicKey {
			sawPublic = true
		}
	}
	if sawSecret {
		t.Errorf("secret-classified span attribute %q leaked to the exporter", secretKey)
	}
	if !sawPublic {
		t.Errorf("non-secret span attribute %q was dropped", publicKey)
	}
}

func TestRedactingExporterStripsSecretFromEventsAndLinks(t *testing.T) {
	const secretKey = attribute.Key("test.secret.token")
	const publicKey = attribute.Key("service.name")

	stub := &captureExporter{}
	exp := redactingExporter(stub, secretPolicy(secretKey))

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exp)),
	)
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	linked := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10},
		SpanID:  trace.SpanID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08},
	})

	tracer := tp.Tracer("test")
	_, span := tracer.Start(context.Background(), "op",
		trace.WithLinks(trace.Link{
			SpanContext: linked,
			Attributes:  []attribute.KeyValue{secretKey.String("linksecret"), publicKey.String("ok")},
		}),
	)
	span.AddEvent("evt", trace.WithAttributes(
		secretKey.String("eventsecret"),
		publicKey.String("ok"),
	))
	span.End()

	spans := stub.captured()
	if len(spans) != 1 {
		t.Fatalf("captured %d spans, want 1", len(spans))
	}
	got := spans[0]

	var eventPublic, linkPublic bool
	for _, e := range got.Events() {
		for _, a := range e.Attributes {
			if a.Key == secretKey {
				t.Errorf("secret leaked in span event %q attribute", e.Name)
			}
			if a.Key == publicKey {
				eventPublic = true
			}
		}
	}
	for _, l := range got.Links() {
		for _, a := range l.Attributes {
			if a.Key == secretKey {
				t.Errorf("secret leaked in span link attribute")
			}
			if a.Key == publicKey {
				linkPublic = true
			}
		}
	}
	if !eventPublic {
		t.Errorf("non-secret span event attribute was dropped")
	}
	if !linkPublic {
		t.Errorf("non-secret span link attribute was dropped")
	}
}

// exportOnePIISpan runs one span through redactingExporter with policy. The
// span carries the PII attribute host.ip on itself, on one event, and on one
// link, each next to a public attribute.
func exportOnePIISpan(t *testing.T, policy *sensitivityPolicy) sdktrace.ReadOnlySpan {
	t.Helper()
	stub := &captureExporter{}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(redactingExporter(stub, policy))),
	)
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	linked := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10},
		SpanID:  trace.SpanID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08},
	})
	pii := attribute.String("host.ip", "10.0.0.1")
	public := attribute.String("service.name", "checkout")
	_, span := tp.Tracer("test").Start(context.Background(), "op",
		trace.WithLinks(trace.Link{SpanContext: linked, Attributes: []attribute.KeyValue{pii, public}}),
	)
	span.SetAttributes(pii, public)
	span.AddEvent("evt", trace.WithAttributes(pii, public))
	span.End()

	spans := stub.captured()
	if len(spans) != 1 {
		t.Fatalf("captured %d spans, want 1", len(spans))
	}
	return spans[0]
}

// spanAttrSets returns the span's own, first event's, and first link's
// attribute sets, labelled for error messages.
func spanAttrSets(t *testing.T, span sdktrace.ReadOnlySpan) map[string][]attribute.KeyValue {
	t.Helper()
	if len(span.Events()) != 1 || len(span.Links()) != 1 {
		t.Fatalf("got %d events and %d links, want 1 each", len(span.Events()), len(span.Links()))
	}
	return map[string][]attribute.KeyValue{
		"span":  span.Attributes(),
		"event": span.Events()[0].Attributes,
		"link":  span.Links()[0].Attributes,
	}
}

func lookupAttr(attrs []attribute.KeyValue, key attribute.Key) (attribute.Value, bool) {
	for _, a := range attrs {
		if a.Key == key {
			return a.Value, true
		}
	}
	return attribute.Value{}, false
}

// internalTestKey is the PIIHash key for in-package tests.
var internalTestKey = bytes.Repeat([]byte("k"), minPIIHashKeyLen)

// wantToken computes the expected PIIHash token independently of the
// policy: HMAC-SHA256 over the canonical value, truncated to 128 bits.
func wantToken(key []byte, canonical string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(canonical))
	return "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil)[:16])
}

func TestRedactingExporterAppliesPIIMode(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mode    PIIMode
		present bool
		want    string
	}{
		{name: "drop", mode: PIIDrop, present: false},
		{name: "allow", mode: PIIAllow, present: true, want: "10.0.0.1"},
		{name: "hash", mode: PIIHash, present: true, want: wantToken(internalTestKey, "10.0.0.1")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := newSensitivityPolicy(newSettings([]Option{WithPIIMode(tc.mode), WithPIIHashKey(internalTestKey)}), nil)
			for where, attrs := range spanAttrSets(t, exportOnePIISpan(t, policy)) {
				got, ok := lookupAttr(attrs, "host.ip")
				if ok != tc.present {
					t.Errorf("%s: host.ip present = %v, want %v (attrs %v)", where, ok, tc.present, attrs)
				}
				if ok && got.AsString() != tc.want {
					t.Errorf("%s: host.ip = %q, want %q", where, got.AsString(), tc.want)
				}
				if v, ok := lookupAttr(attrs, "service.name"); !ok || v.AsString() != "checkout" {
					t.Errorf("%s: public service.name lost or changed: %v", where, attrs)
				}
			}
		})
	}
}

func TestRedactingExporterCountsOneViolationPerPIIAttribute(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })
	policy := newSensitivityPolicy(newSettings([]Option{WithPIIMode(PIIHash), WithPIIHashKey(internalTestKey)}), newViolationRecorder(mp))

	stub := &captureExporter{}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(redactingExporter(stub, policy))),
	)
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	_, span := tp.Tracer("test").Start(context.Background(), "op")
	span.SetAttributes(attribute.String("host.ip", "10.0.0.1"), attribute.String("service.name", "checkout"))
	span.End()

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	var points []metricdata.DataPoint[int64]
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "o11y.schema.violations" {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatalf("o11y.schema.violations data is %T, want Sum[int64]", m.Data)
			}
			points = append(points, sum.DataPoints...)
		}
	}
	if len(points) != 1 {
		t.Fatalf("got %d violation points, want 1: %+v", len(points), points)
	}
	p := points[0]
	if v, _ := p.Attributes.Value(spec.SignalKey); v.AsString() != string(spec.SignalTraces) {
		t.Errorf("signal = %q, want traces", v.AsString())
	}
	if v, _ := p.Attributes.Value(spec.RuleKey); v.AsString() != "pii_attribute" {
		t.Errorf("rule = %q, want pii_attribute", v.AsString())
	}
	if p.Value != 1 {
		t.Errorf("violation count = %d, want 1", p.Value)
	}
}
