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
// and delegates the batch to the wrapped exporter. Redaction covers the span's
// own attributes plus the attributes on every span event and link, since a
// secret can be attached through span.AddEvent or a link as readily as through
// span.SetAttributes. Span attribute keys are already the flat dotted names the
// classification table is keyed on, so no group joining is needed here. When no
// span in the batch needs redacting the original slice is forwarded untouched,
// so the common path (nothing classified secret) allocates nothing.
func (s *spanRedactor) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	var redacted []sdktrace.ReadOnlySpan
	for i, span := range spans {
		r := s.redact(span)
		if r == span {
			continue
		}
		if redacted == nil {
			redacted = make([]sdktrace.ReadOnlySpan, len(spans))
			copy(redacted, spans)
		}
		redacted[i] = r
	}
	if redacted == nil {
		return s.inner.ExportSpans(ctx, spans)
	}
	return s.inner.ExportSpans(ctx, redacted)
}

func (s *spanRedactor) Shutdown(ctx context.Context) error {
	return s.inner.Shutdown(ctx)
}

// redact returns a ReadOnlySpan identical to span except that secret-classified
// attributes are absent from the span, its events, and its links. When nothing
// needs stripping the original span is returned unchanged so the common path
// allocates nothing.
func (s *spanRedactor) redact(span sdktrace.ReadOnlySpan) sdktrace.ReadOnlySpan {
	attrs, attrsChanged := s.filterAttrs(span.Attributes())
	events, eventsChanged := s.filterEvents(span.Events())
	links, linksChanged := s.filterLinks(span.Links())
	if !attrsChanged && !eventsChanged && !linksChanged {
		return span
	}

	stub := tracetest.SpanStubFromReadOnlySpan(span)
	if attrsChanged {
		if attrs == nil {
			attrs = []attribute.KeyValue{}
		}
		stub.Attributes = attrs
	}
	if eventsChanged {
		stub.Events = events
	}
	if linksChanged {
		stub.Links = links
	}
	return stub.Snapshot()
}

// filterAttrs removes secret-classified attributes, counting each as a
// violation. It reports whether anything was stripped; when nothing is secret
// the input slice is returned and changed is false, so no allocation occurs.
func (s *spanRedactor) filterAttrs(attrs []attribute.KeyValue) ([]attribute.KeyValue, bool) {
	first := -1
	for i, a := range attrs {
		if spectables.SensitivityOf[a.Key] == spectables.Secret {
			first = i
			break
		}
	}
	if first == -1 {
		return attrs, false
	}
	kept := make([]attribute.KeyValue, first, len(attrs))
	copy(kept, attrs[:first])
	for _, a := range attrs[first:] {
		if spectables.SensitivityOf[a.Key] == spectables.Secret {
			s.rec.record(spec.SignalTraces, "secret_attribute")
			continue
		}
		kept = append(kept, a)
	}
	return kept, true
}

// filterEvents strips secret attributes from each span event. The events slice
// is copied only when at least one event actually changes.
func (s *spanRedactor) filterEvents(events []sdktrace.Event) ([]sdktrace.Event, bool) {
	var out []sdktrace.Event
	for i, e := range events {
		kept, changed := s.filterAttrs(e.Attributes)
		if !changed {
			continue
		}
		if out == nil {
			out = make([]sdktrace.Event, len(events))
			copy(out, events)
		}
		out[i].Attributes = kept
	}
	if out == nil {
		return events, false
	}
	return out, true
}

// filterLinks strips secret attributes from each span link. The links slice is
// copied only when at least one link actually changes.
func (s *spanRedactor) filterLinks(links []sdktrace.Link) ([]sdktrace.Link, bool) {
	var out []sdktrace.Link
	for i, l := range links {
		kept, changed := s.filterAttrs(l.Attributes)
		if !changed {
			continue
		}
		if out == nil {
			out = make([]sdktrace.Link, len(links))
			copy(out, links)
		}
		out[i].Attributes = kept
	}
	if out == nil {
		return links, false
	}
	return out, true
}
