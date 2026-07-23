package o11y

import (
	"context"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
)

// baggageEgress wraps a TextMapPropagator and filters baggage members on
// Inject only: a member survives egress when allow(key) reports true. Extract
// and Fields delegate to the inner propagator untouched, so ingress is never
// altered. This makes baggage egress a fail-closed choke point once allow is
// tightened; the Phase 0 wiring passes an allow-all predicate, preserving
// behavior.
type baggageEgress struct {
	inner propagation.TextMapPropagator
	allow func(key string) bool
}

// filterBaggageEgress wraps inner so that on Inject only baggage members whose
// key satisfies allow are propagated. Extract and Fields pass through to inner.
func filterBaggageEgress(inner propagation.TextMapPropagator, allow func(string) bool) propagation.TextMapPropagator {
	return baggageEgress{inner: inner, allow: allow}
}

// Inject rebuilds the context's baggage with only the allowed members, then
// delegates to the inner propagator. A member the predicate rejects never
// reaches the carrier.
func (b baggageEgress) Inject(ctx context.Context, carrier propagation.TextMapCarrier) {
	bag := baggage.FromContext(ctx)
	if bag.Len() > 0 {
		filtered := baggage.Baggage{}
		for _, m := range bag.Members() {
			if !b.allow(m.Key()) {
				continue
			}
			next, err := filtered.SetMember(m)
			if err != nil {
				// A member that already validated on the way in cannot fail to
				// set; skip defensively rather than propagate a bad member.
				continue
			}
			filtered = next
		}
		ctx = baggage.ContextWithBaggage(ctx, filtered)
	}
	b.inner.Inject(ctx, carrier)
}

// Extract delegates to the inner propagator unchanged: ingress is not filtered.
func (b baggageEgress) Extract(ctx context.Context, carrier propagation.TextMapCarrier) context.Context {
	return b.inner.Extract(ctx, carrier)
}

// Fields delegates to the inner propagator unchanged.
func (b baggageEgress) Fields() []string {
	return b.inner.Fields()
}
