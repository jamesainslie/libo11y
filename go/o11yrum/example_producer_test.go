package o11yrum_test

import (
	"context"
	"log"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

// The producer is registered with a metric reader before the handler
// exists. The handler then derives the standard RUM metrics from view
// summaries, evaluates the operator-defined metrics in the configuration,
// and re-aggregates app metrics, and the reader exports all of them.
func ExampleWithMetricProducer() {
	cfg, err := o11yrum.ParseConfig([]byte(`
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    metrics:
      - name: shop.rum.network_errors
        instrument: counter
        unit: "{error}"
        event: o11y.rum.error
        where: {o11y.rum.error.source: network}
        group_by: [o11y.rum.view.name, o11y.rum.platform]
`))
	if err != nil {
		log.Fatal(err)
	}
	producer := o11yrum.NewMetricProducer()
	reader := sdkmetric.NewManualReader(sdkmetric.WithProducer(producer))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))

	h, err := o11yrum.NewHandler(o11yrum.WithConfig(cfg), o11yrum.WithMetricProducer(producer))
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		_ = h.Close()
		_ = mp.Shutdown(context.Background())
	}()
	_ = h // serve it under /_o11y/ as in the NewHandler example
}
