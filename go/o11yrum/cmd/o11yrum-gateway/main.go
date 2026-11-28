// Command o11yrum-gateway runs the libo11y RUM gateway. It reads one YAML
// configuration file, and the standard OTEL_* environment variables for
// its own telemetry.
//
//	o11yrum-gateway -config /etc/o11yrum/config.yaml
//
// It serves the gateway under /_o11y/v1/, liveness at /healthz and
// readiness at /readyz, and drains in-flight requests on SIGINT or
// SIGTERM. SIGHUP reloads replay.read_token_file. Once shutdown begins
// /readyz answers 503, and the gateway keeps serving for the
// configuration's shutdown_delay before it drains. When
// the configuration sets no sinks.otlp.endpoint, batches go to
// OTEL_EXPORTER_OTLP_ENDPOINT if that is set.
//
// The metrics the gateway derives leave with its own metrics, through the
// reader OTEL_METRICS_EXPORTER selects. When OTEL_METRICS_PRODUCERS is
// set it must include o11yrum.
//
// With an object_store configured, the gateway accepts source map uploads
// at /_o11y/v1/sourcemaps and symbolicates error stacks, and stores the
// session replay segments of apps that enable replay at
// /_o11y/v1/replay. Every replay.sweep_interval it deletes the stored
// replay segments older than replay.retention. With replay.read_listen
// set, it also serves the replay read API (list, read and erase a
// session's recording) on that address, behind the bearer tokens in
// replay.read_token_file. That
// listener is cluster-internal only: never route the ingress to it. On
// shutdown both listeners drain together. An s3 store authenticates with
// the AWS SDK's default credential chain, so on EKS Pod Identity or IRSA
// supplies credentials and no static key is needed.
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
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yrum"
	"github.com/jamesainslie/libo11y/go/o11yrum/s3store"
	"github.com/jamesainslie/libo11y/go/spec"
)

// version is set at build time with -ldflags "-X main.version=...". When
// it is not, resolveVersion falls back to the module version Go records in
// the binary, so `go install ...@v0.1.0` reports v0.1.0.
var version = "dev"

// resolveVersion returns the version the gateway reports: the linker flag
// when one was given, else the main module's version from info, else dev.
func resolveVersion(linked string, info *debug.BuildInfo) string {
	if linked != "" && linked != "dev" {
		return linked
	}
	if info != nil && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

// buildVersion is resolveVersion for this binary.
func buildVersion() string {
	info, _ := debug.ReadBuildInfo() // nil when the binary carries none
	return resolveVersion(version, info)
}

// Shutdown budget. With shutdown_delay 0 and no preStop sleep, they stay
// inside Kubernetes' default 30s termination grace period, so the final
// telemetry flush is not killed. A delay or a sleep adds to the budget.
const (
	serverDrain    = 15 * time.Second // in-flight requests and their exports
	telemetryFlush = 10 * time.Second // the gateway's own telemetry
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// After the first signal, restore the default handling so a second
	// one ends the process at once instead of waiting for the drain.
	go func() {
		<-ctx.Done()
		stop()
	}()
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
		_, _ = fmt.Fprintln(stdout, buildVersion())
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
	if err := checkProducersEnv(); err != nil {
		return fail(err)
	}
	cfg, sink, err := load(*configPath)
	if err != nil {
		return fail(err)
	}
	store, err := objectStore(ctx, cfg)
	if err != nil {
		return fail(err)
	}
	if *check {
		// Building a handler also reads every remote configuration file
		// and upload token.
		h, err := o11yrum.NewHandler(o11yrum.WithConfig(cfg), o11yrum.WithObjectStore(store))
		if err != nil {
			return fail(err)
		}
		_ = h.Close()
		_, _ = fmt.Fprintln(stdout, "ok")
		return 0
	}
	if err := serve(ctx, cfg, sink, store, stderr); err != nil {
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
		if err := sinkFromEnvironment(&cfg.Sinks.OTLP); err != nil {
			return nil, nil, err
		}
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

// objectStore builds the S3 store the configuration names, with the AWS
// SDK's default credential chain. It returns nil otherwise: the handler
// builds a filesystem store itself.
func objectStore(ctx context.Context, cfg *o11yrum.Config) (o11yrum.ObjectStore, error) {
	c := cfg.ObjectStore.S3
	if c == nil {
		return nil, nil
	}
	store, err := s3store.New(ctx, s3store.Config{
		Bucket: c.Bucket, Prefix: c.Prefix, Region: c.Region, Endpoint: c.Endpoint, UsePathStyle: c.UsePathStyle,
	})
	if err != nil {
		return nil, err
	}
	return store, nil
}

// sinkFromEnvironment fills the OTLP sink from the standard exporter
// variables the gateway's own telemetry also reads: the endpoint, the
// headers (a header the configuration sets wins), and the protocol, which
// must be http/protobuf because that is what the sink speaks.
func sinkFromEnvironment(c *o11yrum.OTLPSinkConfig) error {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		return nil
	}
	if p := os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL"); p != "" && p != "http/protobuf" {
		return fmt.Errorf("OTEL_EXPORTER_OTLP_PROTOCOL=%s: the sink speaks OTLP/HTTP protobuf; set sinks.otlp.endpoint", p)
	}
	headers, err := parseOTLPHeaders(os.Getenv("OTEL_EXPORTER_OTLP_HEADERS"))
	if err != nil {
		return err
	}
	if c.Headers == nil {
		c.Headers = map[string]string{}
	}
	for k, v := range headers {
		if _, set := c.Headers[k]; !set {
			c.Headers[k] = v
		}
	}
	c.Endpoint = endpoint
	return nil
}

// parseOTLPHeaders reads OTEL_EXPORTER_OTLP_HEADERS: comma-separated
// key=value pairs with URL-encoded values.
func parseOTLPHeaders(raw string) (map[string]string, error) {
	out := map[string]string{}
	for pair := range strings.SplitSeq(raw, ",") {
		if strings.TrimSpace(pair) == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			return nil, fmt.Errorf("OTEL_EXPORTER_OTLP_HEADERS: %q is not key=value", strings.TrimSpace(pair))
		}
		value, err := url.PathUnescape(strings.TrimSpace(v))
		if err != nil {
			return nil, fmt.Errorf("OTEL_EXPORTER_OTLP_HEADERS: the value of %s: %w", k, err)
		}
		out[k] = value
	}
	return out, nil
}

// serve runs the gateway until ctx ends, then drains it.
func serve(ctx context.Context, cfg *o11yrum.Config, sink *o11yrum.OTLPSink, store o11yrum.ObjectStore, stderr io.Writer) (err error) {
	// SIGHUP reloads the read API's tokens, so they rotate without a
	// restart. It is caught from the start, so a signal sent while the
	// gateway starts never ends it; one that arrives before the handler
	// exists is handled once it does. During the drain it is ignored.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	// The producer is registered before o11y.New builds the metric reader,
	// which asks autoexport for its producers.
	producer := o11yrum.NewMetricProducer()
	registerProducer(producer)
	sdk, err := o11y.New(ctx,
		o11y.WithServiceName(cfg.Telemetry.ServiceName),
		o11y.WithServiceVersion(buildVersion()),
		o11y.WithEnvironment(spec.Environment(cfg.Environment)))
	if err != nil {
		return fmt.Errorf("telemetry: %w", err)
	}
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), telemetryFlush)
		defer cancel()
		if serr := sdk.Shutdown(flushCtx); serr != nil && err == nil {
			err = fmt.Errorf("telemetry shutdown: %w", serr)
		}
	}()
	opts := []o11yrum.Option{
		o11yrum.WithConfig(cfg), o11yrum.WithSDK(sdk), o11yrum.WithMetricProducer(producer),
		o11yrum.WithObjectStore(store),
	}
	if sink != nil {
		defer func() { _ = sink.Close() }()
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
	// Readiness fails from the moment shutdown begins, before the
	// listener closes, so a load balancer probing it stops sending traffic.
	var draining atomic.Bool
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if draining.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	srv := newServer(mux, stderr)
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.Listen)
	if err != nil {
		return err
	}
	servers := []*http.Server{srv}
	serveErr := make(chan error, 2)
	// The replay read API gets its own listener, bound before anything is
	// served so a failure stops the command at once. It is never mounted
	// on mux, which the public ingress routes to.
	var readLn net.Listener
	if cfg.Replay.ReadListen != "" {
		if readLn, err = (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.Replay.ReadListen); err != nil {
			_ = ln.Close()
			return fmt.Errorf("replay read API: %w", err)
		}
		readSrv := newServer(h.ReplayReadHandler(), stderr)
		servers = append(servers, readSrv)
		go func() { serveErr <- readSrv.Serve(readLn) }()
	}
	_, _ = fmt.Fprintf(stderr, "o11yrum-gateway: listening on %s\n", ln.Addr())
	if readLn != nil {
		_, _ = fmt.Fprintf(stderr, "o11yrum-gateway: replay read API listening on %s\n", readLn.Addr())
	}
	go func() { serveErr <- srv.Serve(ln) }()
	// The reloader stops before serve returns, and so before the handler
	// closes and before run's caller reads stderr.
	reloadCtx, stopReload := context.WithCancel(ctx)
	var reloader sync.WaitGroup
	reloader.Go(func() { reloadOnHangup(reloadCtx, hup, h, cfg.Replay.ReadTokenFile != "", stderr) })
	defer func() {
		stopReload()
		reloader.Wait()
	}()
	select {
	case err := <-serveErr:
		return errors.Join(err, shutdown(ctx, servers))
	case <-ctx.Done():
	}
	draining.Store(true)
	if cfg.ShutdownDelay > 0 {
		_, _ = fmt.Fprintf(stderr, "o11yrum-gateway: shutting down; /readyz answers 503, draining in %v\n", cfg.ShutdownDelay)
		delay := time.NewTimer(cfg.ShutdownDelay)
		select {
		case err := <-serveErr:
			delay.Stop()
			return errors.Join(err, shutdown(ctx, servers))
		case <-delay.C:
		}
	}
	return shutdown(ctx, servers)
}

// reloadOnHangup reloads the replay read API's tokens on each signal from
// hup until ctx ends, and reports the result on stderr. A failed reload
// keeps the tokens in use.
func reloadOnHangup(ctx context.Context, hup <-chan os.Signal, h *o11yrum.Handler, tokenFile bool, stderr io.Writer) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-hup:
		}
		switch err := h.ReloadReplayReadTokens(); {
		case !tokenFile:
			_, _ = fmt.Fprintln(stderr, "o11yrum-gateway: SIGHUP: no replay.read_token_file to reload")
		case err != nil:
			_, _ = fmt.Fprintf(stderr, "o11yrum-gateway: SIGHUP: keeping the tokens in use: %v\n", err)
		default:
			_, _ = fmt.Fprintln(stderr, "o11yrum-gateway: SIGHUP: reloaded replay.read_token_file")
		}
	}
}

// newServer returns an HTTP server for handler with the gateway's
// timeouts and its redacting error log.
func newServer(handler http.Handler, stderr io.Writer) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          serverLog(stderr),
	}
}

// shutdown drains every server at once, within serverDrain, and returns
// the first error.
func shutdown(ctx context.Context, servers []*http.Server) error {
	drainCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), serverDrain)
	defer cancel()
	errs := make(chan error, len(servers))
	for _, srv := range servers {
		go func() { errs <- srv.Shutdown(drainCtx) }()
	}
	var first error
	for range servers {
		if err := <-errs; err != nil && first == nil {
			first = fmt.Errorf("shutdown: %w", err)
		}
	}
	return first
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
