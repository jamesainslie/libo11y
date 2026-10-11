package o11y

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/jamesainslie/libo11y/go/spec"
)

// redactingExporter wraps inner so that span attributes the sensitivity policy
// drops (secrets always, PII under [PIIDrop]) are stripped before the payload
// leaves the process.
// otel-go delivers an ended span to a SpanProcessor as an immutable
// ReadOnlySpan, so the span leg of redaction cannot run at OnEnd; it must run
// at the exporter boundary, which is the last point we control the payload.
// Classification goes through the SDK's [sensitivityPolicy], which counts
// every stripped attribute as an o11y.schema.violations event on the traces
// signal.
func redactingExporter(inner sdktrace.SpanExporter, policy *sensitivityPolicy) sdktrace.SpanExporter {
	return &spanRedactor{inner: inner, policy: policy}
}

type spanRedactor struct {
	inner  sdktrace.SpanExporter
	policy *sensitivityPolicy
}

// ExportSpans rebuilds each span with its policy-dropped attributes removed
// and delegates the batch to the wrapped exporter. Redaction covers the span's
// own attributes plus the attributes on every span event and link, since a
// secret can be attached through span.AddEvent or a link as readily as through
// span.SetAttributes. Span attribute keys are already the flat dotted names the
// classification table is keyed on, so no group joining is needed here. When no
// span in the batch needs redacting the original slice is forwarded untouched,
// so the common path (nothing dropped) allocates nothing.
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

// redact returns a ReadOnlySpan identical to span except that policy-dropped
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

// filterAttrs removes the attributes the policy drops; the policy counts each
// as a violation. It reports whether anything was stripped; when nothing is
// dropped the input slice is returned and changed is false, so no allocation
// occurs. Every key is decided exactly once, so every violation is counted
// once. Only drops are applied to spans for now; PII rewriting is not.
func (s *spanRedactor) filterAttrs(attrs []attribute.KeyValue) ([]attribute.KeyValue, bool) {
	var kept []attribute.KeyValue
	for i, a := range attrs {
		drop := s.policy.decide(spec.SignalTraces, a.Key) == actionDrop
		switch {
		case kept == nil && !drop:
			// Nothing dropped yet: keep scanning without allocating.
		case kept == nil:
			kept = make([]attribute.KeyValue, i, len(attrs))
			copy(kept, attrs[:i])
		case !drop:
			kept = append(kept, a)
		}
	}
	if kept == nil {
		return attrs, false
	}
	return kept, true
}

// filterEvents strips policy-dropped attributes from each span event. The
// events slice is copied only when at least one event actually changes.
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

// filterLinks strips policy-dropped attributes from each span link. The links
// slice is copied only when at least one link actually changes.
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
