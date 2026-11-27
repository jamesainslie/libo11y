// Package aggregate is the gateway's in-memory cumulative metric store.
//
// The gateway derives metrics from view summaries and re-aggregates app
// metrics that browsers send as deltas. Neither fits the OpenTelemetry
// instrument API: merging histogram buckets exactly needs the bucket
// counts, which an instrument cannot take. The Aggregator keeps cumulative
// sums and explicit-bucket histograms instead, and Produce renders them as
// metricdata for a metric.Producer.
//
// Every metric holds at most maxSeries attribute sets. A measurement with a
// new set past the cap goes to an overflow series that keeps only the
// measurement's service.name and adds otel.metric.overflow=true, so one
// app's flood never hides another app's totals.
package aggregate

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/instrumentation"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// Kind is the aggregation of a metric.
type Kind uint8

const (
	// Sum is a cumulative sum.
	Sum Kind = iota
	// Histogram is a cumulative explicit-bucket histogram.
	Histogram
)

// Desc identifies and describes one metric. Scope and Name identify it;
// the other fields except Description must agree on every measurement.
type Desc struct {
	Scope       string
	Name        string
	Unit        string
	Description string
	Kind        Kind
	// Monotonic marks a Sum that only grows. It refuses negative values.
	Monotonic bool
	// Bounds are a Histogram's increasing bucket boundaries. Bucket i holds
	// values in (Bounds[i-1], Bounds[i]], and the last bucket everything
	// above the last bound.
	Bounds []float64
}

var (
	// ErrConflict is returned when a measurement's Desc disagrees with the
	// one its metric was first seen with.
	ErrConflict = errors.New("aggregate: metric already defined differently")
	// ErrValue is returned for a value the metric cannot hold: NaN, an
	// infinity, or a negative value for a monotonic sum.
	ErrValue = errors.New("aggregate: invalid value")
	// errKind is returned when a measurement does not fit its Desc's kind.
	errKind = errors.New("aggregate: measurement does not match the metric kind")
)

// Attribute keys the overflow series carries.
const (
	overflowKey = attribute.Key("otel.metric.overflow")
	serviceKey  = attribute.Key("service.name")
)

type metricID struct{ scope, name string }

type metric struct {
	desc   Desc
	points map[attribute.Distinct]*point
}

type point struct {
	attrs    attribute.Set
	start    time.Time
	last     time.Time
	sum      float64
	count    uint64
	counts   []uint64
	min, max float64
	extrema  bool // min and max hold an observed value
}

func (p *point) observe(v float64) {
	if !p.extrema {
		p.min, p.max, p.extrema = v, v, true
		return
	}
	p.min = math.Min(p.min, v)
	p.max = math.Max(p.max, v)
}

// Aggregator holds cumulative metrics. It is safe for concurrent use.
type Aggregator struct {
	mu        sync.Mutex
	now       func() time.Time
	maxSeries int
	metrics   map[metricID]*metric
	order     []metricID // first-seen order, for stable output
}

// New returns an Aggregator that keeps at most maxSeries attribute sets per
// metric, plus one overflow series per service, and stamps points with now.
func New(maxSeries int, now func() time.Time) *Aggregator {
	return &Aggregator{now: now, maxSeries: maxSeries, metrics: map[metricID]*metric{}}
}

// Add adds v to the Sum d for attrs.
func (a *Aggregator) Add(d Desc, attrs attribute.Set, v float64) error {
	if d.Kind != Sum {
		return fmt.Errorf("%w: Add to %s", errKind, d.Name)
	}
	if !finite(v) || (d.Monotonic && v < 0) {
		return fmt.Errorf("%w: %s: %v", ErrValue, d.Name, v)
	}
	return a.update(d, attrs, func(p *point) { p.sum += v })
}

// Record records one observation v in the Histogram d for attrs.
func (a *Aggregator) Record(d Desc, attrs attribute.Set, v float64) error {
	if d.Kind != Histogram {
		return fmt.Errorf("%w: Record to %s", errKind, d.Name)
	}
	if err := checkBounds(d); err != nil {
		return err
	}
	if !finite(v) {
		return fmt.Errorf("%w: %s: %v", ErrValue, d.Name, v)
	}
	return a.update(d, attrs, func(p *point) {
		p.counts[sort.SearchFloat64s(d.Bounds, v)]++
		p.count++
		p.sum += v
		p.observe(v)
	})
}

// Merge adds a delta histogram point to the Histogram d for attrs. counts
// must have one more element than d.Bounds. min and max are optional.
func (a *Aggregator) Merge(d Desc, attrs attribute.Set, counts []uint64, sum float64, min, max *float64) error {
	if d.Kind != Histogram {
		return fmt.Errorf("%w: Merge to %s", errKind, d.Name)
	}
	if err := checkBounds(d); err != nil {
		return err
	}
	if len(counts) != len(d.Bounds)+1 {
		return fmt.Errorf("aggregate: %s: %d buckets for %d bounds", d.Name, len(counts), len(d.Bounds))
	}
	for _, v := range []*float64{&sum, min, max} {
		if v != nil && !finite(*v) {
			return fmt.Errorf("%w: %s: %v", ErrValue, d.Name, *v)
		}
	}
	return a.update(d, attrs, func(p *point) {
		for i, c := range counts {
			p.counts[i] += c
			p.count += c
		}
		p.sum += sum
		if min != nil {
			p.observe(*min)
		}
		if max != nil {
			p.observe(*max)
		}
	})
}

func (a *Aggregator) update(d Desc, attrs attribute.Set, apply func(*point)) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := metricID{d.Scope, d.Name}
	m, ok := a.metrics[id]
	if !ok {
		m = &metric{desc: cloneDesc(d), points: map[attribute.Distinct]*point{}}
		a.metrics[id] = m
		a.order = append(a.order, id)
	} else if !sameDesc(m.desc, d) {
		return fmt.Errorf("%w: %s", ErrConflict, d.Name)
	}
	now := a.now()
	key := attrs.Equivalent()
	p, ok := m.points[key]
	if !ok {
		if len(m.points) >= a.maxSeries {
			attrs = overflowSet(attrs)
			key = attrs.Equivalent()
			p = m.points[key]
		}
		if p == nil {
			p = &point{attrs: attrs, start: now}
			if d.Kind == Histogram {
				p.counts = make([]uint64, len(d.Bounds)+1)
			}
			m.points[key] = p
		}
	}
	apply(p)
	p.last = now
	return nil
}

// overflowSet keeps the service.name of attrs and marks the overflow.
func overflowSet(attrs attribute.Set) attribute.Set {
	kvs := []attribute.KeyValue{overflowKey.Bool(true)}
	if v, ok := attrs.Value(serviceKey); ok {
		kvs = append(kvs, attribute.KeyValue{Key: serviceKey, Value: v})
	}
	return attribute.NewSet(kvs...)
}

// checkBounds refuses histogram bounds that are not finite and strictly
// increasing, which would put observations in the wrong buckets.
func checkBounds(d Desc) error {
	for i, b := range d.Bounds {
		if !finite(b) || (i > 0 && b <= d.Bounds[i-1]) {
			return fmt.Errorf("aggregate: %s: bounds must be finite and increasing", d.Name)
		}
	}
	return nil
}

func cloneDesc(d Desc) Desc {
	d.Bounds = slices.Clone(d.Bounds)
	return d
}

// sameDesc reports whether two descriptions define the same metric. The
// description text may differ.
func sameDesc(a, b Desc) bool {
	return a.Kind == b.Kind && a.Unit == b.Unit && a.Monotonic == b.Monotonic && slices.Equal(a.Bounds, b.Bounds)
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// Produce renders every metric as cumulative metricdata, grouped by scope
// in first-seen order, with points sorted by their attribute encoding. The
// result shares nothing with the Aggregator.
func (a *Aggregator) Produce() []metricdata.ScopeMetrics {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []metricdata.ScopeMetrics
	scopes := map[string]int{}
	for _, id := range a.order {
		m := a.metrics[id]
		if len(m.points) == 0 {
			continue
		}
		i, ok := scopes[id.scope]
		if !ok {
			i = len(out)
			scopes[id.scope] = i
			out = append(out, metricdata.ScopeMetrics{Scope: instrumentation.Scope{Name: id.scope}})
		}
		out[i].Metrics = append(out[i].Metrics, m.render())
	}
	return out
}

func (m *metric) render() metricdata.Metrics {
	pts := make([]*point, 0, len(m.points))
	for _, p := range m.points {
		pts = append(pts, p)
	}
	enc := attribute.DefaultEncoder()
	keys := make(map[*point]string, len(pts))
	for _, p := range pts {
		keys[p] = p.attrs.Encoded(enc)
	}
	slices.SortFunc(pts, func(x, y *point) int { return bytes.Compare([]byte(keys[x]), []byte(keys[y])) })
	out := metricdata.Metrics{Name: m.desc.Name, Description: m.desc.Description, Unit: m.desc.Unit}
	switch m.desc.Kind {
	case Sum:
		dps := make([]metricdata.DataPoint[float64], len(pts))
		for i, p := range pts {
			dps[i] = metricdata.DataPoint[float64]{Attributes: p.attrs, StartTime: p.start, Time: p.last, Value: p.sum}
		}
		out.Data = metricdata.Sum[float64]{DataPoints: dps, Temporality: metricdata.CumulativeTemporality, IsMonotonic: m.desc.Monotonic}
	case Histogram:
		dps := make([]metricdata.HistogramDataPoint[float64], len(pts))
		for i, p := range pts {
			dp := metricdata.HistogramDataPoint[float64]{
				Attributes:   p.attrs,
				StartTime:    p.start,
				Time:         p.last,
				Count:        p.count,
				Bounds:       slices.Clone(m.desc.Bounds),
				BucketCounts: slices.Clone(p.counts),
				Sum:          p.sum,
			}
			if p.extrema {
				dp.Min = metricdata.NewExtrema(p.min)
				dp.Max = metricdata.NewExtrema(p.max)
			}
			dps[i] = dp
		}
		out.Data = metricdata.Histogram[float64]{DataPoints: dps, Temporality: metricdata.CumulativeTemporality}
	}
	return out
}

// SeriesCounts returns each metric name's number of attribute sets,
// overflow series included, summed across scopes.
func (a *Aggregator) SeriesCounts() map[string]int {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make(map[string]int, len(a.metrics))
	for id, m := range a.metrics {
		out[id.name] += len(m.points)
	}
	return out
}
