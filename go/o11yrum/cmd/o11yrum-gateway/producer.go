package main

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"sync"

	"go.opentelemetry.io/contrib/exporters/autoexport"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

// producerName is the gateway's entry in OTEL_METRICS_PRODUCERS.
const producerName = "o11yrum"

// checkProducersEnv refuses an OTEL_METRICS_PRODUCERS that leaves the
// gateway's producer out. autoexport uses only the producers that variable
// names once it is set, so the derived metrics would never be exported.
// The names are compared exactly, as autoexport compares them.
func checkProducersEnv() error {
	env := os.Getenv("OTEL_METRICS_PRODUCERS")
	if env == "" || slices.Contains(strings.Split(env, ","), producerName) {
		return nil
	}
	return errors.New("OTEL_METRICS_PRODUCERS must include " + producerName + ", or the derived RUM metrics are never exported")
}

// forwardingProducer hands every Produce call to the gateway's current
// MetricProducer.
type forwardingProducer struct {
	mu sync.RWMutex
	p  *o11yrum.MetricProducer
}

func (f *forwardingProducer) set(p *o11yrum.MetricProducer) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.p = p
}

func (f *forwardingProducer) Produce(ctx context.Context) ([]metricdata.ScopeMetrics, error) {
	f.mu.RLock()
	p := f.p
	f.mu.RUnlock()
	if p == nil {
		return nil, nil
	}
	return p.Produce(ctx)
}

var (
	forwarding   = &forwardingProducer{}
	registerOnce sync.Once
)

// registerProducer hands p to every metric reader autoexport builds for
// OTEL_METRICS_EXPORTER: as the fallback when OTEL_METRICS_PRODUCERS is
// unset, and under the name o11yrum when it is set. autoexport keeps
// registrations in package state and panics on a duplicate name, so the
// registration happens once per process and points at a forwarding shell;
// each call only swaps the producer the shell forwards to.
func registerProducer(p *o11yrum.MetricProducer) {
	registerOnce.Do(func() {
		factory := func(context.Context) (sdkmetric.Producer, error) { return forwarding, nil }
		autoexport.RegisterMetricProducer(producerName, factory)
		autoexport.WithFallbackMetricProducer(factory)
	})
	forwarding.set(p)
}
