// Command o11yrum-gateway runs the libo11y RUM gateway. It reads one YAML
// configuration file, and the standard OTEL_* environment variables for
// its own telemetry.
//
//	o11yrum-gateway -config /etc/o11yrum/gateway.yaml
//
// It serves the gateway under /_o11y/v1/, liveness at /healthz and
// readiness at /readyz, and drains in-flight requests on SIGINT or
// SIGTERM. When the configuration sets no sinks.otlp.endpoint, batches go
// to OTEL_EXPORTER_OTLP_ENDPOINT if that is set.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"slices"
	"syscall"
	"time"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yrum"
	"github.com/jamesainslie/libo11y/go/spec"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

// shutdownTimeout bounds draining in-flight requests on shutdown.
const shutdownTimeout = 20 * time.Second

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// run is the command, minus process concerns, so tests can drive it. It
// returns the exit code: 0 on a clean shutdown, 1 on a failure, 2 on a
// usage error.
func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("o11yrum-gateway", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "path to the gateway configuration file")
	check := fs.Bool("check-config", false, "validate the configuration and exit")
	showVersion := fs.Bool("version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	}
	if *configPath == "" {
		_, _ = fmt.Fprintln(stderr, "o11yrum-gateway: -config is required")
		return 2
	}
	fail := func(err error) int {
		_, _ = fmt.Fprintln(stderr, "o11yrum-gateway:", err)
		return 1
	}
	cfg, sink, err := load(*configPath)
	if err != nil {
		return fail(err)
	}
	if *check {
		// Building a handler also reads every remote configuration file.
		h, err := o11yrum.NewHandler(o11yrum.WithConfig(cfg))
		if err != nil {
			return fail(err)
		}
		_ = h.Close()
		_, _ = fmt.Fprintln(stdout, "ok")
		return 0
	}
	if err := serve(ctx, cfg, sink, stderr); err != nil {
		return fail(err)
	}
	return 0
}

// environments is the closed set the core accepts for
// deployment.environment.name.
var environments = []spec.Environment{
	spec.EnvironmentProduction, spec.EnvironmentStaging, spec.EnvironmentDevelopment, spec.EnvironmentTest,
}

// load reads and checks the configuration and builds the OTLP sink, which
// is nil when neither the configuration nor OTEL_EXPORTER_OTLP_ENDPOINT
// names a collector.
func load(path string) (*o11yrum.Config, *o11yrum.OTLPSink, error) {
	cfg, err := o11yrum.LoadConfig(path)
	if err != nil {
		return nil, nil, err
	}
	switch {
	case cfg.Environment == "":
		return nil, nil, errors.New("config: environment is required")
	case !slices.Contains(environments, spec.Environment(cfg.Environment)):
		return nil, nil, fmt.Errorf("config: environment %q must be production, staging, development or test", cfg.Environment)
	}
	if cfg.Sinks.OTLP.Endpoint == "" {
		cfg.Sinks.OTLP.Endpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	}
	if cfg.Sinks.OTLP.Endpoint == "" {
		return cfg, nil, nil
	}
	sink, err := o11yrum.NewOTLPSink(cfg.Sinks.OTLP)
	if err != nil {
		return nil, nil, err
	}
	return cfg, sink, nil
}

// serve runs the gateway until ctx ends, then drains it.
func serve(ctx context.Context, cfg *o11yrum.Config, sink *o11yrum.OTLPSink, stderr io.Writer) (err error) {
	sdk, err := o11y.New(ctx,
		o11y.WithServiceName(cfg.Telemetry.ServiceName),
		o11y.WithServiceVersion(version),
		o11y.WithEnvironment(spec.Environment(cfg.Environment)))
	if err != nil {
		return fmt.Errorf("telemetry: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
		defer cancel()
		if serr := sdk.Shutdown(shutdownCtx); serr != nil && err == nil {
			err = fmt.Errorf("telemetry shutdown: %w", serr)
		}
	}()
	opts := []o11yrum.Option{o11yrum.WithConfig(cfg), o11yrum.WithSDK(sdk)}
	if sink != nil {
		opts = append(opts, o11yrum.WithSinks(sink))
	}
	h, err := o11yrum.NewHandler(opts...)
	if err != nil {
		return err
	}
	defer func() { _ = h.Close() }()

	mux := http.NewServeMux()
	mux.Handle("/_o11y/", h)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          serverLog(stderr),
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.Listen)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stderr, "o11yrum-gateway: listening on %s\n", ln.Addr())
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

// peerAddress matches the client address net/http puts in its server log
// lines ("panic serving 203.0.113.5:41234:", "error from [::1]:443:").
var peerAddress = regexp.MustCompile(`(serving|from) (\[[^\]]*\]|[^\s\[]+):[0-9]+`)

// serverLog returns the net/http server's error log. It writes to w with
// the peer address removed, because the gateway never logs a client
// address.
func serverLog(w io.Writer) *log.Logger {
	return log.New(redactingWriter{w: w}, "o11yrum-gateway: ", 0)
}

type redactingWriter struct{ w io.Writer }

func (r redactingWriter) Write(p []byte) (int, error) {
	if _, err := r.w.Write(peerAddress.ReplaceAll(p, []byte("$1 [client]"))); err != nil {
		return 0, err
	}
	return len(p), nil
}
