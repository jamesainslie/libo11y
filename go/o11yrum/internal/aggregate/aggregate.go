// Package aggregate is the gateway's in-memory cumulative metric store.
//
// The gateway derives metrics from view summaries and re-aggregates app
// metrics that browsers send as deltas. Neither fits the OpenTelemetry
// instrument API: merging histogram buckets exactly needs the bucket
// counts, which an instrument cannot take. The Aggregator keeps cumulative
// sums and explicit-bucket histograms instead, and Produce renders them as
// metricdata for a metric.Producer.
//
// Every metric holds at most maxSeries attribute sets for each value of
// service.name. A measurement with a new set past its app's cap goes to an
// overflow series that keeps only the service.name and adds
// otel.metric.overflow=true, so one app's flood never hides another app's
// totals or pushes another app into overflow.
package aggregate

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
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

// Desc identifies and describes one metric. Owner, Scope and Name identify
// it; the other fields except Description must agree on every measurement.
type Desc struct {
	// Owner separates metrics that clients define, so one app cannot claim
	// another app's metric with a different definition. It is not exported.
	// Owners that define a metric the same way render as one metric.
	Owner       string
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

type metricID struct{ owner, scope, name string }

type metric struct {
	desc   Desc
	points map[attribute.Distinct]*point
	// series counts each app's attribute sets, overflow series excluded.
	series map[string]int
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
	return a.update(d, attrs, func(p *point) error {
		if !finite(p.sum + v) {
			return fmt.Errorf("%w: %s: the running sum would not be finite", ErrValue, d.Name)
		}
		p.sum += v
		return nil
	})
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
	return a.update(d, attrs, func(p *point) error {
		if !finite(p.sum+v) || p.count == math.MaxUint64 {
			return fmt.Errorf("%w: %s: the running sum or count would overflow", ErrValue, d.Name)
		}
		p.counts[sort.SearchFloat64s(d.Bounds, v)]++
		p.count++
		p.sum += v
		p.observe(v)
		return nil
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
	if min != nil && max != nil && *min > *max {
		return fmt.Errorf("%w: %s: min above max", ErrValue, d.Name)
	}
	var total uint64
	for _, c := range counts {
		if total+c < total {
			return fmt.Errorf("%w: %s: bucket counts overflow", ErrValue, d.Name)
		}
		total += c
	}
	if total == 0 {
		// An empty delta observed nothing. A sum without observations
		// would skew every mean, and an empty one changes nothing, so it
		// creates no series.
		if sum != 0 {
			return fmt.Errorf("%w: %s: a sum without observations", ErrValue, d.Name)
		}
		return nil
	}
	return a.update(d, attrs, func(p *point) error {
		if p.count+total < p.count || !finite(p.sum+sum) {
			return fmt.Errorf("%w: %s: the running sum or count would overflow", ErrValue, d.Name)
		}
		for i, c := range counts {
			p.counts[i] += c
		}
		p.count += total
		p.sum += sum
		if min != nil {
			p.observe(*min)
		}
		if max != nil {
			p.observe(*max)
		}
		return nil
	})
}

// update finds or creates the point for attrs and applies a measurement.
// apply checks before it changes anything, so a refused measurement leaves
// no trace: a point or metric created for it is removed again.
func (a *Aggregator) update(d Desc, attrs attribute.Set, apply func(*point) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := metricID{d.Owner, d.Scope, d.Name}
	m, known := a.metrics[id]
	if !known {
		m = &metric{desc: cloneDesc(d), points: map[attribute.Distinct]*point{}, series: map[string]int{}}
	} else if !sameDesc(m.desc, d) {
		return fmt.Errorf("%w: %s", ErrConflict, d.Name)
	}
	now := a.now()
	key := attrs.Equivalent()
	p, ok := m.points[key]
	created, overflow := false, false
	service := serviceOf(attrs)
	if !ok {
		if m.series[service] >= a.maxSeries {
			attrs, overflow = overflowSet(attrs), true
			key = attrs.Equivalent()
			p = m.points[key]
		}
		if p == nil {
			p = &point{attrs: attrs, start: now}
			if d.Kind == Histogram {
				p.counts = make([]uint64, len(d.Bounds)+1)
			}
			created = true
		}
	}
	if err := apply(p); err != nil {
		return err
	}
	p.last = now
	if created {
		m.points[key] = p
		if !overflow {
			m.series[service]++
		}
	}
	if !known {
		a.metrics[id] = m
		a.order = append(a.order, id)
	}
	return nil
}

// serviceOf returns the service.name of attrs, or "" without one.
func serviceOf(attrs attribute.Set) string {
	v, _ := attrs.Value(serviceKey)
	return v.AsString()
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

// snapshot is one metric copied under the lock, so rendering, sorting and
// encoding happen outside it and never stall measurements.
type snapshot struct {
	desc   Desc // never modified after creation, so it is shared
	points []point
}

// Produce renders every metric as cumulative metricdata, grouped by scope
// in first-seen order, with points sorted by their attribute encoding.
// Owners that define a metric the same way render as one metric. Owners
// that define one name differently render as separate metrics of that
// name: an OTLP backend keeps both, apart by service.name, while a
// Prometheus exporter keeps one. Refusing the second definition instead
// would let one app's clients block another app's metric. The result
// shares nothing with the Aggregator.
func (a *Aggregator) Produce() []metricdata.ScopeMetrics {
	snaps := a.snapshot()
	var out []metricdata.ScopeMetrics
	scopes := map[string]int{}
	for _, s := range snaps {
		i, ok := scopes[s.desc.Scope]
		if !ok {
			i = len(out)
			scopes[s.desc.Scope] = i
			out = append(out, metricdata.ScopeMetrics{Scope: instrumentation.Scope{Name: s.desc.Scope}})
		}
		out[i].Metrics = append(out[i].Metrics, render(s))
	}
	return out
}

// snapshot copies every metric with points, merging owners that define
// one metric the same way, in first-seen order.
func (a *Aggregator) snapshot() []snapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	var snaps []snapshot
	// byName indexes snaps by scope and name. A key holds one entry per
	// distinct definition, which is almost always one.
	byName := map[[2]string][]int{}
	for _, id := range a.order {
		m := a.metrics[id]
		if len(m.points) == 0 {
			continue
		}
		key := [2]string{m.desc.Scope, m.desc.Name}
		i := -1
		for _, j := range byName[key] {
			if sameDesc(snaps[j].desc, m.desc) {
				i = j
				break
			}
		}
		if i < 0 {
			i = len(snaps)
			snaps = append(snaps, snapshot{desc: m.desc})
			byName[key] = append(byName[key], i)
		}
		for _, p := range m.points {
			cp := *p
			cp.counts = slices.Clone(p.counts)
			snaps[i].points = append(snaps[i].points, cp)
		}
	}
	return snaps
}

func render(s snapshot) metricdata.Metrics {
	enc := attribute.DefaultEncoder()
	keys := make([]string, len(s.points))
	order := make([]int, len(s.points))
	for i := range s.points {
		keys[i] = s.points[i].attrs.Encoded(enc)
		order[i] = i
	}
	slices.SortFunc(order, func(x, y int) int { return strings.Compare(keys[x], keys[y]) })
	out := metricdata.Metrics{Name: s.desc.Name, Description: s.desc.Description, Unit: s.desc.Unit}
	switch s.desc.Kind {
	case Sum:
		dps := make([]metricdata.DataPoint[float64], len(order))
		for i, j := range order {
			p := &s.points[j]
			dps[i] = metricdata.DataPoint[float64]{Attributes: p.attrs, StartTime: p.start, Time: p.last, Value: p.sum}
		}
		out.Data = metricdata.Sum[float64]{DataPoints: dps, Temporality: metricdata.CumulativeTemporality, IsMonotonic: s.desc.Monotonic}
	case Histogram:
		bounds := slices.Clone(s.desc.Bounds)
		dps := make([]metricdata.HistogramDataPoint[float64], len(order))
		for i, j := range order {
			p := &s.points[j]
			dp := metricdata.HistogramDataPoint[float64]{
				Attributes:   p.attrs,
				StartTime:    p.start,
				Time:         p.last,
				Count:        p.count,
				Bounds:       bounds,
				BucketCounts: p.counts,
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
// overflow series included, summed across owners and scopes.
func (a *Aggregator) SeriesCounts() map[string]int {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make(map[string]int, len(a.metrics))
	for id, m := range a.metrics {
		out[id.name] += len(m.points)
	}
	return out
}
