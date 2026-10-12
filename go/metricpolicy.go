package o11y

import (
	"context"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
)

// metricViews wraps every user view so its streams also apply the
// sensitivity policy, and appends a catch-all view, matching only
// instruments no user view matched, that applies the policy to the default
// stream. User view semantics (renames, multiple matches, their own
// filters) are preserved.
//
// Every stream therefore carries an attribute filter, so the SDK never
// substitutes an instrument's advisory attribute keys (an experimental
// instrument option it applies only to streams without a filter). Those
// keys are not visible to a view, so they cannot be composed here.
func (p *sensitivityPolicy) metricViews(user []sdkmetric.View) []sdkmetric.View {
	views := make([]sdkmetric.View, 0, len(user)+1)
	for _, v := range user {
		views = append(views, func(inst sdkmetric.Instrument) (sdkmetric.Stream, bool) {
			s, ok := v(inst)
			if !ok {
				return s, false
			}
			return p.protectStream(s), true
		})
	}
	views = append(views, func(inst sdkmetric.Instrument) (sdkmetric.Stream, bool) {
		for _, v := range user {
			if _, ok := v(inst); ok {
				return sdkmetric.Stream{}, false
			}
		}
		// The SDK's implicit default stream, which a matching view replaces.
		return p.protectStream(sdkmetric.Stream{
			Name:        inst.Name,
			Description: inst.Description,
			Unit:        inst.Unit,
		}), true
	})
	return views
}

// protectStream composes the policy with a stream's own attribute filter and
// filters the attributes the SDK hands to the exemplar reservoir (the
// measurement attributes the stream filter removed), so classified values
// cannot leave through Exemplar.FilteredAttributes.
func (p *sensitivityPolicy) protectStream(s sdkmetric.Stream) sdkmetric.Stream {
	userFilter := s.AttributeFilter
	s.AttributeFilter = func(kv attribute.KeyValue) bool {
		return p.metricKeep(kv) && (userFilter == nil || userFilter(kv))
	}
	selector := s.ExemplarReservoirProviderSelector
	if selector == nil {
		selector = sdkmetric.DefaultExemplarReservoirProviderSelector
	}
	s.ExemplarReservoirProviderSelector = func(agg sdkmetric.Aggregation) exemplar.ReservoirProvider {
		provider := selector(agg)
		return func(attrs attribute.Set) exemplar.Reservoir {
			return filterReservoir(provider(attrs), p)
		}
	}
	return s
}

// filterReservoir wraps inner so classified attributes are removed from the
// filtered attributes offered to it. The SDK's built-in reservoirs carry an
// unexported marker telling the SDK they are safe for concurrent use, so it
// calls them without a lock; the wrappers for those types embed them to keep
// the marker (the policy filter itself holds no state). Any other reservoir
// is wrapped plainly and the SDK serializes calls to it as before.
func filterReservoir(inner exemplar.Reservoir, policy *sensitivityPolicy) exemplar.Reservoir {
	switch r := inner.(type) {
	case *exemplar.FixedSizeReservoir:
		return filteredFixedSizeReservoir{FixedSizeReservoir: r, policy: policy}
	case *exemplar.HistogramReservoir:
		return filteredHistogramReservoir{HistogramReservoir: r, policy: policy}
	default:
		return filteredReservoir{inner: inner, policy: policy}
	}
}

// filteredReservoir removes classified attributes from the filtered
// attributes offered to the reservoir it wraps.
type filteredReservoir struct {
	inner  exemplar.Reservoir
	policy *sensitivityPolicy
}

func (r filteredReservoir) Offer(ctx context.Context, t time.Time, v exemplar.Value, filtered []attribute.KeyValue) {
	r.inner.Offer(ctx, t, v, r.policy.metricAttrs(filtered))
}

func (r filteredReservoir) Collect(dest *[]exemplar.Exemplar) { r.inner.Collect(dest) }

// filteredFixedSizeReservoir is filteredReservoir for the SDK's fixed-size
// reservoir; embedding it promotes Collect and the concurrency marker.
type filteredFixedSizeReservoir struct {
	*exemplar.FixedSizeReservoir
	policy *sensitivityPolicy
}

func (r filteredFixedSizeReservoir) Offer(ctx context.Context, t time.Time, v exemplar.Value, filtered []attribute.KeyValue) {
	r.FixedSizeReservoir.Offer(ctx, t, v, r.policy.metricAttrs(filtered))
}

// filteredHistogramReservoir is filteredReservoir for the SDK's histogram
// reservoir; embedding it promotes Collect and the concurrency marker.
type filteredHistogramReservoir struct {
	*exemplar.HistogramReservoir
	policy *sensitivityPolicy
}

func (r filteredHistogramReservoir) Offer(ctx context.Context, t time.Time, v exemplar.Value, filtered []attribute.KeyValue) {
	r.HistogramReservoir.Offer(ctx, t, v, r.policy.metricAttrs(filtered))
}

// metricAttrs returns attrs without the attributes metricKeep rejects. The
// input slice is returned untouched when every attribute is kept, so the
// common path allocates nothing.
func (p *sensitivityPolicy) metricAttrs(attrs []attribute.KeyValue) []attribute.KeyValue {
	var kept []attribute.KeyValue
	for i, kv := range attrs {
		if kept == nil {
			if p.metricKeep(kv) {
				continue
			}
			kept = make([]attribute.KeyValue, i, len(attrs))
			copy(kept, attrs[:i])
			continue
		}
		if p.metricKeep(kv) {
			kept = append(kept, kv)
		}
	}
	if kept == nil {
		return attrs
	}
	return kept
}
