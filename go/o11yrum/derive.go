package o11yrum

import (
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/aggregate"
	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// Histogram bounds of the derived vitals. Every rating threshold is a
// bound, so the share of good and poor views is exact from the buckets.
var (
	secondsBounds = []float64{0.1, 0.2, 0.3, 0.5, 0.8, 1, 1.2, 1.5, 1.8, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 30}
	clsBounds     = []float64{0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1}
)

// vital ties a summary value to its metric and the rating thresholds of
// the specification's "Vital ratings" table.
type vital struct {
	attr, metric string
	good, poor   float64
}

var vitals = []vital{
	{keySummaryLCP, metricLCP, 2.5, 4},
	{keySummaryINP, metricINP, 0.2, 0.5},
	{keySummaryCLS, metricCLS, 0.1, 0.25},
	{keySummaryFCP, metricFCP, 1.8, 3},
	{keySummaryTTFB, metricTTFB, 0.8, 1.8},
}

// Rating values of o11y.rum.vital.rating.
const (
	ratingGood = "good"
	ratingNI   = "needs-improvement"
	ratingPoor = "poor"
)

// rating rates v: at or under good is good, above poor is poor, and
// anything between needs improvement.
func rating(v, good, poor float64) string {
	switch {
	case v <= good:
		return ratingGood
	case v > poor:
		return ratingPoor
	default:
		return ratingNI
	}
}

// deriver turns accepted batches into metrics in the aggregator.
type deriver struct {
	agg *aggregate.Aggregator
	// defs holds each app's operator-defined metrics, by service.name.
	defs map[string][]operatorMetric
}

// logs derives the standard metrics from every view summary in ld, and
// the app's operator-defined metrics from the events they name. The
// gateway has validated ld and the sinks have accepted it.
func (d *deriver) logs(service string, ld plog.Logs) {
	for i := range ld.ResourceLogs().Len() {
		rl := ld.ResourceLogs().At(i)
		res := rl.Resource().Attributes()
		for j := range rl.ScopeLogs().Len() {
			recs := rl.ScopeLogs().At(j).LogRecords()
			for k := range recs.Len() {
				lr := recs.At(k)
				name := eventName(lr)
				l := attrLookup{record: lr.Attributes(), resource: res}
				if name == eventViewSummary {
					d.summary(service, l)
				}
				if name != "" {
					d.operator(service, name, l)
				}
			}
		}
	}
}

// summary derives the nine standard metrics from one view summary. Each
// metric takes the labels the specification lists for it: service.name is
// the app, the error source, frustration type and rating come from the
// summary's own fields, and every other label is read from the record or
// its resource and left out when absent.
func (d *deriver) summary(service string, l attrLookup) {
	if seq, ok := intValue(l, keySummarySeq); ok && seq == 0 {
		d.add(metricViews, specLabels(metricViews, service, l), 1)
	}
	for _, src := range rumspec.Enums[keyErrorSource] {
		if n, ok := intValue(l, keySummaryErrors+src); ok && n > 0 {
			d.add(metricErrors, specLabels(metricErrors, service, l, attribute.String(keyErrorSource, src)), float64(n))
		}
	}
	for _, typ := range rumspec.Enums[keyFrustrationType] {
		if n, ok := intValue(l, keySummaryFrust+typ); ok && n > 0 {
			d.add(metricFrustration, specLabels(metricFrustration, service, l, attribute.String(keyFrustrationType, typ)), float64(n))
		}
	}
	if n, ok := intValue(l, keySummaryLoAF); ok && n > 0 {
		d.add(metricLoAF, specLabels(metricLoAF, service, l), float64(n))
	}
	for _, v := range vitals {
		x, ok := doubleValue(l, v.attr)
		if !ok {
			continue
		}
		r := attribute.String(keyVitalRating, rating(x, v.good, v.poor))
		d.record(v.metric, specLabels(v.metric, service, l, r), x)
	}
}

// specLabels builds the attribute set of one point of a standard metric
// from the labels the specification lists for it. service.name is always
// the app's; computed holds labels the gateway works out itself.
func specLabels(metric, service string, l attrLookup, computed ...attribute.KeyValue) attribute.Set {
	labels := rumspec.Metrics[metric].Labels
	kvs := make([]attribute.KeyValue, 0, len(labels))
	kvs = append(kvs, attribute.String(keyServiceName, service))
	kvs = append(kvs, computed...)
	for _, k := range labels {
		if k == keyServiceName || hasKey(computed, k) {
			continue
		}
		if v, ok := l.get(k); ok && v.Type() == pcommon.ValueTypeStr {
			kvs = append(kvs, attribute.String(k, v.Str()))
		}
	}
	return attribute.NewSet(kvs...)
}

func hasKey(kvs []attribute.KeyValue, k string) bool {
	for _, kv := range kvs {
		if string(kv.Key) == k {
			return true
		}
	}
	return false
}

// add and record measure a standard metric. Errors cannot happen for spec
// metrics with validated values, so they are dropped.
func (d *deriver) add(metric string, set attribute.Set, v float64) {
	_ = d.agg.Add(standardDesc(metric), set, v)
}

func (d *deriver) record(metric string, set attribute.Set, v float64) {
	_ = d.agg.Record(standardDesc(metric), set, v)
}

// standardDesc describes a standard metric from the spec table.
func standardDesc(metric string) aggregate.Desc {
	m := rumspec.Metrics[metric]
	desc := aggregate.Desc{Scope: scopeName, Name: metric, Unit: m.Unit, Description: m.Brief}
	switch m.Instrument {
	case "histogram":
		desc.Kind = aggregate.Histogram
		desc.Bounds = secondsBounds
		if m.Unit == "1" {
			desc.Bounds = clsBounds
		}
	default:
		desc.Kind = aggregate.Sum
		desc.Monotonic = true
	}
	return desc
}

// intValue reads an int attribute.
func intValue(l attrLookup, k string) (int64, bool) {
	v, ok := l.get(k)
	if !ok || v.Type() != pcommon.ValueTypeInt {
		return 0, false
	}
	return v.Int(), true
}

// doubleValue reads a numeric attribute as a double. Validation widens
// ints where the registry says double, so an int is accepted too.
func doubleValue(l attrLookup, k string) (float64, bool) {
	v, ok := l.get(k)
	if !ok {
		return 0, false
	}
	switch v.Type() {
	case pcommon.ValueTypeDouble:
		return v.Double(), true
	case pcommon.ValueTypeInt:
		return float64(v.Int()), true
	}
	return 0, false
}
