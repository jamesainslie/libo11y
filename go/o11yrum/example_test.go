package o11yrum_test

import (
	"context"
	"log"
	"net/http"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

// stdoutSink stands in for a real sink, such as the OTLP sink.
type stdoutSink struct{}

func (stdoutSink) Name() string { return "stdout" }

func (stdoutSink) Export(_ context.Context, b o11yrum.Batch) error {
	log.Printf("%s: %s batch", b.Service, b.Signal)
	return nil
}

func ExampleNewHandler() {
	cfg, err := o11yrum.ParseConfig([]byte(`
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
`))
	if err != nil {
		log.Fatal(err)
	}
	h, err := o11yrum.NewHandler(o11yrum.WithConfig(cfg), o11yrum.WithSinks(stdoutSink{}))
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = h.Close() }()

	mux := http.NewServeMux()
	mux.Handle("/_o11y/", h)
	_ = &http.Server{Addr: ":8080", Handler: mux}
}
