package o11y

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/jamesainslie/libo11y/go/spec"
)

// redactingExporter wraps inner so that span attributes are classified by the
// SDK's [sensitivityPolicy] before the payload leaves the process: secrets are
// always dropped, and PII is dropped, replaced by a token, or kept per the PII
// mode. otel-go delivers an ended span to a SpanProcessor as an immutable
// ReadOnlySpan, so the span leg of redaction cannot run at OnEnd; it must run
// at the exporter boundary, which is the last point we control the payload.
// The policy counts every dropped or rewritten attribute as an
// o11y.schema.violations event on the traces signal.
func redactingExporter(inner sdktrace.SpanExporter, policy *sensitivityPolicy) sdktrace.SpanExporter {
	return &spanRedactor{inner: inner, policy: policy}
}

type spanRedactor struct {
	inner  sdktrace.SpanExporter
	policy *sensitivityPolicy
}

// ExportSpans rebuilds each span with the policy applied to its attributes
// and delegates the batch to the wrapped exporter. Redaction covers the span's
// own attributes plus the attributes on every span event and link, since a
// secret can be attached through span.AddEvent or a link as readily as through
// span.SetAttributes. Span attribute keys are already the flat dotted names the
// classification table is keyed on, so no group joining is needed here. When no
// span in the batch needs redacting the original slice is forwarded untouched,
// so the common path (nothing dropped or rewritten) allocates nothing.
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

// redact returns a ReadOnlySpan identical to span except that the policy has
// been applied to the attributes of the span, its events, and its links. When
// nothing changes the original span is returned unchanged so the common path
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

// filterAttrs applies the sensitivity policy to attrs: kept attributes pass
// through, dropped ones are removed, and rewritten ones are replaced by the
// policy's token. The policy counts each drop or rewrite as a violation, and
// every key is decided exactly once, so each violation is counted once. It
// reports whether anything changed; when nothing does, the input slice is
// returned and no allocation occurs.
func (s *spanRedactor) filterAttrs(attrs []attribute.KeyValue) ([]attribute.KeyValue, bool) {
	var out []attribute.KeyValue
	for i, a := range attrs {
		res, act := s.policy.kv(spec.SignalTraces, a)
		if out == nil {
			if act == actionKeep {
				continue // nothing changed yet: keep scanning without allocating
			}
			out = make([]attribute.KeyValue, i, len(attrs))
			copy(out, attrs[:i])
		}
		if act != actionDrop {
			out = append(out, res)
		}
	}
	if out == nil {
		return attrs, false
	}
	return out, true
}

// filterEvents applies the policy to each span event's attributes. The
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

// filterLinks applies the policy to each span link's attributes. The links
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
