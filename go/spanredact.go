package o11y

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

// redactingExporter wraps inner so that span attributes the specification
// classifies as secret are stripped before the payload leaves the process.
// otel-go delivers an ended span to a SpanProcessor as an immutable
// ReadOnlySpan, so the span leg of redaction cannot run at OnEnd; it must run
// at the exporter boundary, which is the last point we control the payload.
// Every stripped attribute is counted as an o11y.schema.violations event on
// the traces signal.
func redactingExporter(inner sdktrace.SpanExporter, rec *violationRecorder) sdktrace.SpanExporter {
	return &spanRedactor{inner: inner, rec: rec}
}

type spanRedactor struct {
	inner sdktrace.SpanExporter
	rec   *violationRecorder
}

// ExportSpans rebuilds each span with its secret-classified attributes removed
// and delegates the redacted batch to the wrapped exporter. Span attribute
// keys are already the flat dotted names the classification table is keyed on,
// so no group joining is needed here.
func (s *spanRedactor) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	redacted := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, span := range spans {
		redacted[i] = s.redact(span)
	}
	return s.inner.ExportSpans(ctx, redacted)
}

func (s *spanRedactor) Shutdown(ctx context.Context) error {
	return s.inner.Shutdown(ctx)
}

// redact returns a ReadOnlySpan identical to span except that secret-classified
// attributes are absent. When nothing needs stripping the original span is
// returned unchanged so the common path allocates nothing.
func (s *spanRedactor) redact(span sdktrace.ReadOnlySpan) sdktrace.ReadOnlySpan {
	attrs := span.Attributes()
	kept := attrs[:0:0] // nil until the first attribute is retained
	stripped := false
	for _, a := range attrs {
		if spectables.SensitivityOf[a.Key] == spectables.Secret {
			s.rec.record(spec.SignalTraces, "secret_attribute")
			stripped = true
			continue
		}
		kept = append(kept, a)
	}
	if !stripped {
		return span
	}

	stub := tracetest.SpanStubFromReadOnlySpan(span)
	stub.Attributes = kept
	if kept == nil {
		stub.Attributes = []attribute.KeyValue{}
	}
	return stub.Snapshot()
}
