package o11yrum

import (
	"fmt"
	"maps"
	"math"
	"regexp"
	"slices"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/aggregate"
	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// MetricDefinition is an operator-defined metric: a counter or histogram
// the gateway derives from one event of one app. Its labels are limited to
// attributes the specification classifies as bounded or enum, so a
// definition cannot create a series per user, session or URL.
type MetricDefinition struct {
	// Name is the metric name, lowercase dotted segments such as
	// shop.rum.network_errors. Names under o11y. and o11yrum. are reserved.
	Name string `yaml:"name"`
	// Description is the metric description.
	Description string `yaml:"description"`
	// Instrument is counter or histogram.
	Instrument string `yaml:"instrument"`
	// Unit is the UCUM unit, such as s or {error}.
	Unit string `yaml:"unit"`
	// Event is the event name the metric counts, such as o11y.rum.error.
	Event string `yaml:"event"`
	// Where keeps only records whose attributes have these values. A
	// missing attribute does not match.
	Where map[string]string `yaml:"where"`
	// Value names the numeric attribute to add or record. A histogram
	// requires it; a counter without it adds 1 per record.
	Value string `yaml:"value"`
	// Buckets are a histogram's increasing bucket bounds. The default is
	// the bounds of the standard vitals in seconds.
	Buckets []float64 `yaml:"buckets"`
	// GroupBy names the attributes that label the metric, read from the
	// record or its resource. service.name is always a label.
	GroupBy []string `yaml:"group_by"`
}

// Instruments of an operator-defined metric.
const (
	instrumentCounter   = "counter"
	instrumentHistogram = "histogram"
)

var (
	metricNamePattern      = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`)
	reservedMetricPrefixes = []string{"o11y.", "o11yrum."}
)

// applyMetricDefaults gives histograms without buckets the default bounds.
func applyMetricDefaults(defs []MetricDefinition) {
	for i := range defs {
		if defs[i].Instrument == instrumentHistogram && defs[i].Buckets == nil {
			defs[i].Buckets = slices.Clone(secondsBounds)
		}
	}
}

// validateMetric checks one definition of app.
func validateMetric(app string, m MetricDefinition) error {
	wrap := func(format string, args ...any) error {
		return fmt.Errorf("app %s: metric %s: %s", app, m.Name, fmt.Sprintf(format, args...))
	}
	if hasAnyPrefix(m.Name, reservedMetricPrefixes) {
		return wrap("the name is reserved for the specification and the gateway")
	}
	if !metricNamePattern.MatchString(m.Name) {
		return fmt.Errorf("app %s: metric name %q must be lowercase dotted segments such as shop.rum.network_errors", app, m.Name)
	}
	switch m.Instrument {
	case instrumentCounter:
		if m.Buckets != nil {
			return wrap("buckets apply only to histograms")
		}
	case instrumentHistogram:
		if m.Value == "" {
			return wrap("value is required for a histogram")
		}
		for i, b := range m.Buckets {
			if math.IsNaN(b) || math.IsInf(b, 0) || (i > 0 && b <= m.Buckets[i-1]) {
				return wrap("buckets must increase and be finite")
			}
		}
	default:
		return wrap("instrument %q must be counter or histogram", m.Instrument)
	}
	if m.Event == "" {
		return wrap("event is empty")
	}
	if typ, ok := rumspec.Types[m.Value]; ok && typ != "int" && typ != "double" {
		return wrap("value %s is not numeric", m.Value)
	}
	seen := make(map[string]bool, len(m.GroupBy))
	for _, k := range m.GroupBy {
		if seen[k] {
			return wrap("group_by %s is repeated", k)
		}
		seen[k] = true
		switch c, ok := rumspec.Cardinalities[k]; {
		case ok && (c == rumspec.Enum || c == rumspec.Bounded):
		case ok && c == rumspec.Unbounded:
			return wrap("group_by %s is unbounded", k)
		default:
			return wrap("group_by %s is not classified bounded or enum by the specification", k)
		}
	}
	return nil
}

// validateMetrics checks every app's definitions, then that apps sharing a
// metric name define it the same way, since they share one metric.
func validateMetrics(apps []AppConfig) error {
	first := map[string]struct {
		app string
		def MetricDefinition
	}{}
	for _, a := range apps {
		names := map[string]bool{}
		for _, m := range a.Metrics {
			if err := validateMetric(a.ServiceName, m); err != nil {
				return err
			}
			if names[m.Name] {
				return fmt.Errorf("app %s: duplicate metric %s", a.ServiceName, m.Name)
			}
			names[m.Name] = true
			prev, ok := first[m.Name]
			if !ok {
				first[m.Name] = struct {
					app string
					def MetricDefinition
				}{a.ServiceName, m}
				continue
			}
			if prev.def.Instrument != m.Instrument || prev.def.Unit != m.Unit || !slices.Equal(prev.def.Buckets, m.Buckets) {
				return fmt.Errorf("metric %s is defined differently by apps %s and %s", m.Name, prev.app, a.ServiceName)
			}
		}
	}
	return nil
}

// cloneMetrics deep-copies definitions.
func cloneMetrics(defs []MetricDefinition) []MetricDefinition {
	if defs == nil {
		return nil
	}
	out := make([]MetricDefinition, len(defs))
	for i, m := range defs {
		m.Where = maps.Clone(m.Where)
		m.Buckets = slices.Clone(m.Buckets)
		m.GroupBy = slices.Clone(m.GroupBy)
		out[i] = m
	}
	return out
}

// operatorMetric is a validated definition prepared for evaluation.
type operatorMetric struct {
	desc    aggregate.Desc
	event   string
	where   map[string]string
	value   string
	groupBy []string
}

// compileMetrics prepares each app's definitions, keyed by service.name.
func compileMetrics(apps []AppConfig) map[string][]operatorMetric {
	out := map[string][]operatorMetric{}
	for _, a := range apps {
		for _, m := range cloneMetrics(a.Metrics) {
			desc := aggregate.Desc{Scope: scopeName, Name: m.Name, Unit: m.Unit, Description: m.Description}
			if m.Instrument == instrumentHistogram {
				desc.Kind, desc.Bounds = aggregate.Histogram, m.Buckets
			} else {
				desc.Kind, desc.Monotonic = aggregate.Sum, true
			}
			out[a.ServiceName] = append(out[a.ServiceName], operatorMetric{
				desc: desc, event: m.Event, where: m.Where, value: m.Value, groupBy: m.GroupBy,
			})
		}
	}
	return out
}

// operator evaluates the app's definitions for one record named event.
func (d *deriver) operator(service, event string, l attrLookup) {
	for _, m := range d.defs[service] {
		if m.event != event || !m.matches(l) {
			continue
		}
		set := m.labels(service, l)
		// The configuration check guarantees a consistent definition, so a
		// refused measurement is a value the aggregator cannot hold, such as
		// a negative counter value or a sum that would overflow. It is
		// dropped like a record without the value attribute.
		switch {
		case m.desc.Kind == aggregate.Histogram:
			if v, ok := doubleValue(l, m.value); ok {
				_ = d.agg.Record(m.desc, set, v)
			}
		case m.value == "":
			_ = d.agg.Add(m.desc, set, 1)
		default:
			if v, ok := doubleValue(l, m.value); ok {
				_ = d.agg.Add(m.desc, set, v)
			}
		}
	}
}

func (m operatorMetric) matches(l attrLookup) bool {
	for k, want := range m.where {
		v, ok := l.get(k)
		if !ok || v.AsString() != want {
			return false
		}
	}
	return true
}

// labels are service.name plus each present group_by attribute, rendered
// as a string. A map or array value is left out.
func (m operatorMetric) labels(service string, l attrLookup) attribute.Set {
	kvs := make([]attribute.KeyValue, 0, len(m.groupBy)+1)
	kvs = append(kvs, attribute.String(keyServiceName, service))
	for _, k := range m.groupBy {
		if k == keyServiceName {
			continue
		}
		v, ok := l.get(k)
		if !ok || v.Type() == pcommon.ValueTypeMap || v.Type() == pcommon.ValueTypeSlice || v.Type() == pcommon.ValueTypeBytes {
			continue
		}
		kvs = append(kvs, attribute.String(k, v.AsString()))
	}
	return attribute.NewSet(kvs...)
}
