package o11yrum

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yrum/internal/aggregate"
)

// MetricProducer exposes the metrics the gateway derives (the standard RUM
// metrics, operator-defined metrics and re-aggregated app metrics) to an
// OpenTelemetry metric reader. Register it with the reader before the
// handler exists, then pass it to NewHandler with WithMetricProducer,
// which binds it to that handler. Data points are cumulative.
type MetricProducer struct {
	mu  sync.RWMutex
	agg *aggregate.Aggregator
}

// NewMetricProducer returns an unbound producer. It produces nothing until
// a handler binds it.
func NewMetricProducer() *MetricProducer { return &MetricProducer{} }

// Produce returns the current cumulative state of every derived metric. It
// implements go.opentelemetry.io/otel/sdk/metric.Producer.
func (p *MetricProducer) Produce(context.Context) ([]metricdata.ScopeMetrics, error) {
	p.mu.RLock()
	agg := p.agg
	p.mu.RUnlock()
	if agg == nil {
		return nil, nil
	}
	return agg.Produce(), nil
}

var errProducerBound = errors.New("o11yrum: MetricProducer is already bound to a handler")

// bind attaches the producer to one handler's aggregator.
func (p *MetricProducer) bind(agg *aggregate.Aggregator) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.agg != nil {
		return errProducerBound
	}
	p.agg = agg
	return nil
}

// WithMetricProducer makes the handler derive metrics and expose them
// through p. Without it the handler derives nothing. A producer binds to
// one handler only.
func WithMetricProducer(p *MetricProducer) Option {
	return func(s *settings) { s.producer = p }
}

// Self-telemetry of the aggregator.
const (
	metricAggregatorSeries = "o11yrum.aggregator.series"
	keyO11yrumMetric       = "o11yrum.metric"
)

// newDeriver builds the aggregator for p, registers its series gauge on
// the SDK's meter provider when there is one, and binds p last, so a
// failure leaves p unbound. The returned function unregisters the gauge.
func newDeriver(p *MetricProducer, sdk *o11y.SDK, maxSeries int, now func() time.Time) (*deriver, func() error, error) {
	agg := aggregate.New(maxSeries, now)
	unregister := func() error { return nil }
	if sdk != nil {
		reg, err := registerSeriesGauge(sdk.MeterProvider(), agg)
		if err != nil {
			return nil, nil, err
		}
		unregister = reg.Unregister
	}
	if err := p.bind(agg); err != nil {
		return nil, nil, errors.Join(err, unregister())
	}
	return &deriver{agg: agg}, unregister, nil
}

// registerSeriesGauge reports the number of attribute sets each derived
// metric holds, overflow series included, so an operator sees a metric
// approach its cap.
func registerSeriesGauge(mp metric.MeterProvider, agg *aggregate.Aggregator) (metric.Registration, error) {
	meter := mp.Meter(scopeName)
	gauge, err := meter.Int64ObservableGauge(metricAggregatorSeries,
		metric.WithUnit("{series}"),
		metric.WithDescription("Attribute sets each derived metric holds, overflow series included."))
	if err != nil {
		return nil, fmt.Errorf("o11yrum: series gauge: %w", err)
	}
	reg, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		for name, n := range agg.SeriesCounts() {
			o.ObserveInt64(gauge, int64(n), metric.WithAttributes(attribute.String(keyO11yrumMetric, name)))
		}
		return nil
	}, gauge)
	if err != nil {
		return nil, fmt.Errorf("o11yrum: series gauge: %w", err)
	}
	return reg, nil
}

// derived feeds an exported batch to the deriver. Only logs carry view
// summaries and the events operator metrics count.
func (h *Handler) derived(b Batch) {
	if h.derive != nil && b.Signal == SignalLogs {
		h.derive.logs(b.Service, b.Logs)
	}
}
