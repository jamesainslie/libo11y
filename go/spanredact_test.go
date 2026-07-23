package o11y

import (
	"context"
	"sync"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
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

// registerSecretKey installs a temporary Secret classification for key and
// removes it when the test ends. The runtime table currently carries no
// Secret-classified attribute, so the redaction path is exercised against a
// key the test controls.
func registerSecretKey(t *testing.T, key attribute.Key) {
	t.Helper()
	prev, had := spectables.SensitivityOf[key]
	spectables.SensitivityOf[key] = spectables.Secret
	t.Cleanup(func() {
		if had {
			spectables.SensitivityOf[key] = prev
			return
		}
		delete(spectables.SensitivityOf, key)
	})
}

func TestRedactingExporterDropsSecretSpanAttr(t *testing.T) {
	const secretKey = attribute.Key("test.secret.token")
	const publicKey = attribute.Key("service.name")
	registerSecretKey(t, secretKey)

	stub := &captureExporter{}
	exp := redactingExporter(stub, nil)

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
	registerSecretKey(t, secretKey)

	stub := &captureExporter{}
	exp := redactingExporter(stub, nil)

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
