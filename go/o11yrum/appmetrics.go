package o11yrum

import (
	"errors"
	"regexp"
	"slices"
	"sync"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/aggregate"
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
	reasonLabelBudget       = "label_budget"
	reasonNoProducer        = "no_producer"
)

// Caps on what one app metric series may hold. A client chooses the
// bounds and labels, so without them a few requests could pin gigabytes.
const (
	// maxAppBounds caps the bucket bounds of an app histogram.
	maxAppBounds = 64
	// maxAppLabels caps the attributes of an app metric point.
	maxAppLabels = 16
	// maxAppLabelLen caps an app metric label in bytes. A longer key
	// refuses the point; a longer value is truncated.
	maxAppLabelLen = 256
)

// keyOverflow marks the aggregator's overflow series. Only the gateway
// sets it.
const keyOverflow = "otel.metric.overflow"

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
// attributes, which then keep only the labels metricLabel allows: keys the
// specification classifies bounded or enum, and keys the app lists in
// app_metric_labels, within the label budget appMetrics applies. Exemplars
// are removed, because they carry trace and span IDs.
// Nothing is dropped here; appMetrics decides which points it can
// aggregate.
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
					// Labels the point may not keep go first, so they never
					// count against limits.max_attributes in the filter.
					attrs.RemoveIf(func(k string, _ pcommon.Value) bool {
						if v.policy.metricLabel(k) {
							return false
						}
						v.attrsRemoved++
						return true
					})
					v.filter(attrs)
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

// room reports whether service may aggregate the metric: it already has,
// or it has a slot left.
func (s *appMetricSet) room(service string, id appMetricID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	known := s.known[service]
	return known[id] || len(known) < s.max
}

// add takes a slot for a metric that aggregated a point. Requests racing
// for the last slot can each aggregate a point before one takes it; every
// one of them keeps its slot, so a metric in the aggregator never stops
// updating. The overshoot is bounded by the number of concurrent requests.
func (s *appMetricSet) add(service string, id appMetricID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	known := s.known[service]
	if known == nil {
		known = map[appMetricID]bool{}
		s.known[service] = known
	}
	known[id] = true
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
	// The owner keeps each app's metrics apart, so one app's clients cannot
	// claim another app's metric with a different definition.
	desc := aggregate.Desc{Owner: service, Scope: scope, Name: name, Unit: m.Unit(), Description: m.Description()}
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
	id := appMetricID{scope, name}
	if !d.apps.room(service, id) {
		return reasonMetricLimit
	}
	// A metric takes a slot only once a point aggregates, so junk metrics
	// whose points are all refused cannot use up the app's slots.
	aggregated := false
	defer func() {
		if aggregated {
			d.apps.add(service, id)
		}
	}()
	count := func(err error) {
		switch {
		case err == nil:
			aggregated = true
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
			set, ok := appLabels(service, p.Attributes())
			if !ok {
				drops[reasonLabelBudget]++
				continue
			}
			count(d.agg.Add(desc, set, v))
		}
		return ""
	}
	for i := range m.Histogram().DataPoints().Len() {
		p := m.Histogram().DataPoints().At(i)
		if !p.HasSum() || p.ExplicitBounds().Len() > maxAppBounds {
			// Without a sum the cumulative sum, and every mean from it, would
			// be wrong. Every series of a histogram keeps a count per bucket,
			// so the client may not choose thousands of them.
			drops[reasonInvalidValue]++
			continue
		}
		counts := p.BucketCounts().AsRaw()
		if p.Sum() == 0 && !slices.ContainsFunc(counts, func(c uint64) bool { return c > 0 }) {
			continue // an empty delta observed nothing
		}
		set, ok := appLabels(service, p.Attributes())
		if !ok {
			drops[reasonLabelBudget]++
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
		count(d.agg.Merge(pd, set, counts, p.Sum(), lo, hi))
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
// attributes, scalars rendered as strings and cut to maxAppLabelLen bytes.
// A client cannot set service.name or the overflow marker. It reports
// false for a point with more than maxAppLabels labels or a key longer
// than maxAppLabelLen.
func appLabels(service string, attrs pcommon.Map) (attribute.Set, bool) {
	kvs := make([]attribute.KeyValue, 0, attrs.Len()+1)
	kvs = append(kvs, attribute.String(keyServiceName, service))
	for k, v := range attrs.All() {
		switch {
		case len(k) > maxAppLabelLen:
			return attribute.Set{}, false
		case k == keyServiceName || k == keyOverflow:
		case v.Type() == pcommon.ValueTypeMap || v.Type() == pcommon.ValueTypeSlice || v.Type() == pcommon.ValueTypeBytes:
		default:
			kvs = append(kvs, attribute.String(k, truncateUTF8(v.AsString(), maxAppLabelLen)))
		}
	}
	if len(kvs)-1 > maxAppLabels {
		return attribute.Set{}, false
	}
	return attribute.NewSet(kvs...), true
}

// metricPoints counts every data point of md.
func metricPoints(md pmetric.Metrics) int64 {
	var n int64
	for i := range md.ResourceMetrics().Len() {
		rm := md.ResourceMetrics().At(i)
		for j := range rm.ScopeMetrics().Len() {
			ms := rm.ScopeMetrics().At(j).Metrics()
			for k := range ms.Len() {
				n += pointCount(ms.At(k))
			}
		}
	}
	return n
}
