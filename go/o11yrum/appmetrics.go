package o11yrum

import (
	"errors"
	"regexp"
	"sync"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/aggregate"
	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// Reasons an app metric data point is dropped.
const (
	reasonReservedMetric    = "reserved_metric"
	reasonCumulative        = "cumulative"
	reasonUnsupportedMetric = "unsupported_metric"
	reasonConflict          = "conflict"
	reasonInvalidName       = "invalid_name"
	reasonInvalidValue      = "invalid_value"
	reasonMetricLimit       = "metric_limit"
)

// instrumentNamePattern is the OpenTelemetry instrument name syntax.
var instrumentNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_./-]{0,254}$`)

// Caps on the identifying strings of an app metric, from the
// OpenTelemetry API's limits for instrument units.
const (
	maxScopeNameLen = 255
	maxUnitLen      = 63
)

// metrics validates md in place for re-aggregation: the resource and scope
// attributes go through the policy like any record's, and so do data point
// attributes, which then also lose every key the specification classifies
// unbounded, so no per-browser identity reaches a series. Exemplars are
// removed, because they carry trace and span IDs. Nothing is dropped here;
// appMetrics decides which points it can aggregate.
func (v *validator) metrics(md pmetric.Metrics) dropCounts {
	for i := range md.ResourceMetrics().Len() {
		rm := md.ResourceMetrics().At(i)
		v.resource(rm.Resource())
		for j := range rm.ScopeMetrics().Len() {
			sm := rm.ScopeMetrics().At(j)
			v.filter(sm.Scope().Attributes())
			for k := range sm.Metrics().Len() {
				m := sm.Metrics().At(k)
				m.SetDescription(v.truncate(m.Description()))
				eachPoint(m, func(attrs pcommon.Map, exemplars pmetric.ExemplarSlice) {
					v.filter(attrs)
					attrs.RemoveIf(func(k string, _ pcommon.Value) bool {
						if rumspec.Cardinalities[k] == rumspec.Unbounded {
							v.attrsRemoved++
							return true
						}
						return false
					})
					exemplars.RemoveIf(func(pmetric.Exemplar) bool { return true })
				})
			}
		}
	}
	return dropCounts{}
}

// eachPoint calls f with the attributes and exemplars of every data point
// of m, whatever its type.
func eachPoint(m pmetric.Metric, f func(pcommon.Map, pmetric.ExemplarSlice)) {
	switch m.Type() {
	case pmetric.MetricTypeSum:
		for i := range m.Sum().DataPoints().Len() {
			p := m.Sum().DataPoints().At(i)
			f(p.Attributes(), p.Exemplars())
		}
	case pmetric.MetricTypeGauge:
		for i := range m.Gauge().DataPoints().Len() {
			p := m.Gauge().DataPoints().At(i)
			f(p.Attributes(), p.Exemplars())
		}
	case pmetric.MetricTypeHistogram:
		for i := range m.Histogram().DataPoints().Len() {
			p := m.Histogram().DataPoints().At(i)
			f(p.Attributes(), p.Exemplars())
		}
	case pmetric.MetricTypeExponentialHistogram:
		for i := range m.ExponentialHistogram().DataPoints().Len() {
			p := m.ExponentialHistogram().DataPoints().At(i)
			f(p.Attributes(), p.Exemplars())
		}
	case pmetric.MetricTypeSummary:
		for i := range m.Summary().DataPoints().Len() {
			f(m.Summary().DataPoints().At(i).Attributes(), pmetric.NewExemplarSlice())
		}
	}
}

// pointCount returns the number of data points of m.
func pointCount(m pmetric.Metric) int64 {
	var n int64
	eachPoint(m, func(pcommon.Map, pmetric.ExemplarSlice) { n++ })
	return n
}

// appMetricSet bounds how many metrics one app may define, so a client
// cannot grow the aggregator without limit by inventing names.
type appMetricSet struct {
	mu    sync.Mutex
	max   int
	known map[string]map[appMetricID]bool // by service.name
}

type appMetricID struct{ scope, name string }

// admit reports whether service may aggregate the metric, recording it.
func (s *appMetricSet) admit(service string, id appMetricID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	known := s.known[service]
	if known == nil {
		known = map[appMetricID]bool{}
		s.known[service] = known
	}
	if known[id] {
		return true
	}
	if len(known) >= s.max {
		return false
	}
	known[id] = true
	return true
}

// appMetrics re-aggregates an app's validated metrics into cumulative
// metrics without per-browser identity: the resource is replaced by the
// app's service.name, and only delta sums and delta explicit-bucket
// histograms are accepted, since deltas from many browsers add up and
// cumulative values from many browsers do not. It returns the data points
// it dropped, by reason.
func (d *deriver) appMetrics(service string, md pmetric.Metrics) dropCounts {
	drops := dropCounts{}
	for i := range md.ResourceMetrics().Len() {
		rm := md.ResourceMetrics().At(i)
		for j := range rm.ScopeMetrics().Len() {
			sm := rm.ScopeMetrics().At(j)
			scope := sm.Scope().Name()
			for k := range sm.Metrics().Len() {
				m := sm.Metrics().At(k)
				if reason := d.appMetric(service, scope, m, drops); reason != "" {
					drops[reason] += pointCount(m)
				}
			}
		}
	}
	return drops
}

// appMetric aggregates one metric. It returns a reason when the whole
// metric is refused, and otherwise counts refused points into drops.
func (d *deriver) appMetric(service, scope string, m pmetric.Metric, drops dropCounts) string {
	name := m.Name()
	switch {
	case hasAnyPrefix(name, reservedMetricPrefixes) || scope == scopeName:
		return reasonReservedMetric
	case !instrumentNamePattern.MatchString(name) || len(scope) > maxScopeNameLen || !validUnit(m.Unit()):
		return reasonInvalidName
	}
	desc := aggregate.Desc{Scope: scope, Name: name, Unit: m.Unit(), Description: m.Description()}
	switch m.Type() {
	case pmetric.MetricTypeSum:
		if reason := deltaOnly(m.Sum().AggregationTemporality()); reason != "" {
			return reason
		}
		desc.Kind, desc.Monotonic = aggregate.Sum, m.Sum().IsMonotonic()
	case pmetric.MetricTypeHistogram:
		if reason := deltaOnly(m.Histogram().AggregationTemporality()); reason != "" {
			return reason
		}
		desc.Kind = aggregate.Histogram
	default:
		return reasonUnsupportedMetric
	}
	if !d.apps.admit(service, appMetricID{scope, name}) {
		return reasonMetricLimit
	}
	count := func(err error) {
		switch {
		case err == nil:
		case errors.Is(err, aggregate.ErrConflict):
			drops[reasonConflict]++
		default:
			drops[reasonInvalidValue]++
		}
	}
	if desc.Kind == aggregate.Sum {
		for i := range m.Sum().DataPoints().Len() {
			p := m.Sum().DataPoints().At(i)
			var v float64
			switch p.ValueType() {
			case pmetric.NumberDataPointValueTypeInt:
				v = float64(p.IntValue())
			case pmetric.NumberDataPointValueTypeDouble:
				v = p.DoubleValue()
			default:
				drops[reasonInvalidValue]++
				continue
			}
			count(d.agg.Add(desc, appLabels(service, p.Attributes()), v))
		}
		return ""
	}
	for i := range m.Histogram().DataPoints().Len() {
		p := m.Histogram().DataPoints().At(i)
		if !p.HasSum() {
			// Without a sum the cumulative sum, and every mean from it, would
			// be wrong.
			drops[reasonInvalidValue]++
			continue
		}
		pd := desc
		pd.Bounds = p.ExplicitBounds().AsRaw()
		var lo, hi *float64
		if p.HasMin() {
			v := p.Min()
			lo = &v
		}
		if p.HasMax() {
			v := p.Max()
			hi = &v
		}
		count(d.agg.Merge(pd, appLabels(service, p.Attributes()), p.BucketCounts().AsRaw(), p.Sum(), lo, hi))
	}
	return ""
}

// deltaOnly returns the reason a temporality is refused, or "".
func deltaOnly(t pmetric.AggregationTemporality) string {
	switch t {
	case pmetric.AggregationTemporalityDelta:
		return ""
	case pmetric.AggregationTemporalityCumulative:
		return reasonCumulative
	default:
		return reasonUnsupportedMetric
	}
}

// validUnit reports whether u fits the OpenTelemetry unit limits: at most
// 63 printable ASCII characters.
func validUnit(u string) bool {
	if len(u) > maxUnitLen {
		return false
	}
	for i := range len(u) {
		if u[i] < 0x20 || u[i] > 0x7e {
			return false
		}
	}
	return true
}

// appLabels are the app's service.name plus a point's remaining
// attributes, scalars rendered as strings. A client cannot set
// service.name or the overflow marker.
func appLabels(service string, attrs pcommon.Map) attribute.Set {
	kvs := make([]attribute.KeyValue, 0, attrs.Len()+1)
	kvs = append(kvs, attribute.String(keyServiceName, service))
	for k, v := range attrs.All() {
		switch {
		case k == keyServiceName || k == "otel.metric.overflow":
		case v.Type() == pcommon.ValueTypeMap || v.Type() == pcommon.ValueTypeSlice || v.Type() == pcommon.ValueTypeBytes:
		default:
			kvs = append(kvs, attribute.String(k, v.AsString()))
		}
	}
	return attribute.NewSet(kvs...)
}
