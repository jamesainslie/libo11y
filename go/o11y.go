// Package o11y is an opinionated, one-call setup layer for OpenTelemetry in
// Go: traces, metrics, and logs over OTLP with unified configuration, W3C
// context propagation, and log/trace correlation.
//
// The package wraps OpenTelemetry setup, never instrumentation. After
// [Setup] (or [New]) your application uses the vanilla OTEL API for traces
// and metrics and the standard [log/slog] facade for logs; every signal is
// correlated through the active span context and exported over OTLP.
//
//	sdk, err := o11y.Setup(ctx,
//		o11y.WithServiceName("checkout"),
//		o11y.WithEnvironment(spec.EnvironmentProduction),
//	)
//	if err != nil {
//		return err
//	}
//	defer sdk.Shutdown(context.Background())
//
//	slog.InfoContext(ctx, "ready")     // correlated, exported
//	tracer := otel.Tracer("checkout")  // vanilla OTEL from here on
//
// A deployment environment is required. Set it with [WithEnvironment] or
// OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production; the
// option wins over the variable. Allowed values: production, staging,
// development, test (extend with [WithEnvironmentValues]).
//
// Configuration follows a strict precedence: explicit options override the
// standard OTEL_* environment variables, which override library defaults.
// The package defines no environment variables of its own.
//
// One standard variable beats code options: OTEL_SDK_DISABLED=true (in any
// case) switches telemetry off from outside the process. Nothing is
// exported on any signal, including through exporters, readers, and
// processors injected with options, and runtime metrics do not start.
// Tracer providers are the OpenTelemetry no-op provider, so no span is
// recorded, while context propagation and the console and extra log sinks
// keep working, and identity is validated as usual. The meter provider
// stays a real provider with no readers, so instruments can be created and
// nothing is collected. The SDK still owns what options injected and shuts
// it down exactly once: an injected metric reader when [New] builds the
// SDK, everything else in [SDK.Shutdown]. The effective configuration
// reports each signal as none. A value that is neither true nor false is
// reported once through the SDK's error handler and counts as false.
// [WithoutOTELEnv] ignores the variable.
package o11y

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/exporters/autoexport"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel/log"
	lognoop "go.opentelemetry.io/otel/log/noop"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"

	"github.com/jamesainslie/libo11y/go/internal/fanout"
	"github.com/jamesainslie/libo11y/go/spec"
)

// scopeName identifies telemetry emitted by this library itself.
const scopeName = "github.com/jamesainslie/libo11y/go"

// defaultShutdownTimeout bounds Shutdown and ForceFlush when the caller's
// context carries no deadline of its own.
const defaultShutdownTimeout = 5 * time.Second

// SDK is an initialized telemetry pipeline: tracer, meter, and logger
// providers sharing one resource and one propagator. Build one with [New]
// (no global side effects) or [Setup] (also installs process globals).
//
// A nil *SDK, and the zero value, is an inert handle: every method is safe
// to call and does nothing useful but nothing harmful. [New] and [Setup]
// return a nil *SDK with their error, so a host may log the error and carry
// on without telemetry:
//
//	sdk, err := o11y.Setup(ctx, opts...)
//	if err != nil {
//		log.Printf("telemetry disabled: %v", err)
//	}
//	defer sdk.Shutdown(context.Background())
//
// On an inert handle Shutdown and ForceFlush return nil, and Event does
// nothing. EffectiveConfig returns "". The provider accessors return the
// OpenTelemetry no-op providers, and Propagator returns a propagator that
// injects and extracts nothing. Resource returns an empty resource.
// Handler returns a handler of the library's own that writes text records
// at Info and above to os.Stderr and never goes through the log package,
// and Logger returns a logger over it, so a host that carries on still
// sees its logs, and may wrap the handler and install it with
// [slog.SetDefault] safely. Capture returns the zero [Carrier], StartLinked
// starts a no-op span, and ShutdownOnSignals still waits for a signal or
// ctx, then returns nil. Only an SDK returned by New or Setup without error
// is live.
type SDK struct {
	res            *resource.Resource
	tracerProvider *sdktrace.TracerProvider
	meterProvider  *sdkmetric.MeterProvider
	loggerProvider *sdklog.LoggerProvider
	// spanProcessors and logProcessors are the processors the providers
	// own, kept so abandon can stop them directly.
	spanProcessors []sdktrace.SpanProcessor
	logProcessors  []sdklog.Processor
	// spanFailures and logFailures observe the span and log exporters, so
	// Shutdown and ForceFlush report exports that fail while they run.
	spanFailures *exportFailures
	logFailures  *exportFailures
	// injected are the parts options injected; see injectedPart.
	injected   []*injectedPart
	propagator propagation.TextMapPropagator
	// propagatorFields is what the effective configuration reports for
	// the propagator (see buildPropagator).
	propagatorFields string
	// disabled records that OTEL_SDK_DISABLED switched the SDK off.
	disabled     bool
	handler      slog.Handler
	logger       *slog.Logger
	errorHandler ErrorHandler
	global       bool

	effectiveConfig string
	summaryAttrs    []slog.Attr

	// shutdownStarted elects the one caller that runs the shutdown;
	// shutdownDone is closed once it has finished and shutdownErr is set.
	shutdownStarted atomic.Bool
	shutdownDone    chan struct{}
	shutdownErr     error
}

// New builds an SDK without touching any process-global state: no global
// providers, no global propagator, no default logger. Use it for tests,
// dependency injection, or hosting several isolated pipelines in one
// process. Most applications want [Setup] instead.
func New(ctx context.Context, opts ...Option) (*SDK, error) {
	return newSDK(ctx, newSettings(opts))
}

func newSDK(ctx context.Context, s *settings) (_ *SDK, err error) {
	s.disabled = s.sdkDisabled()
	// The SDK owns what options injected from here on, so it exists before
	// the first check that can fail, and is filled in as construction goes.
	// Any exit before it is complete, an error or a panic, abandons what
	// exists so far without flushing it, injected parts included.
	sdk := &SDK{
		injected:     injectedParts(s),
		disabled:     s.disabled,
		spanFailures: &exportFailures{},
		logFailures:  &exportFailures{},
		shutdownDone: make(chan struct{}),
	}
	built := false
	defer func() {
		if !built {
			sdk.abandon(ctx)
		}
	}()
	if s.piiMode == PIIHash && len(s.piiHashKey) < minPIIHashKeyLen {
		return nil, ErrPIIHashKey
	}
	appClasses, err := loadAppRegistries(s.appRegistries)
	if err != nil {
		return nil, err
	}
	// One policy serves every signal. The resource and the meter provider's
	// views need it before the violation counter (built on that provider)
	// exists, so the recorder is attached below, before any provider is
	// handed out or used concurrently. Resource classification counts its
	// violations separately, and metric filtering never records any.
	policy := newSensitivityPolicy(s, appClasses, nil)
	res, resourceViolations, err := buildResource(ctx, s, policy)
	if err != nil {
		return nil, err
	}

	builtProp, err := buildPropagator(s)
	if err != nil {
		return nil, err
	}
	allow := s.baggageAllow
	if allow == nil {
		allow = func(string) bool { return true } // by default every baggage key may leave the process
	}
	// The egress filter wraps whichever propagator is configured, so the
	// baggage choke point cannot be bypassed by WithPropagators.
	propagator := filterBaggageEgress(builtProp.propagator, allow)

	sdk.res = res
	sdk.propagator = propagator
	sdk.propagatorFields = builtProp.fields

	sdk.meterProvider, err = buildMeterProvider(ctx, s, res, policy)
	if err != nil {
		return nil, err
	}
	if s.disabled {
		// An injected reader is not registered while the SDK is disabled. A
		// periodic reader runs from its constructor and would report that it
		// is not registered on every interval, so it is shut down now.
		sdk.stopInjectedNow(ctx, "metrics")
	} else {
		sdk.handOver("metrics")
	}

	if s.runtimeMetricsEnabled() {
		if err := runtime.Start(runtime.WithMeterProvider(sdk.meterProvider)); err != nil {
			return nil, fmt.Errorf("o11y: starting runtime metrics: %w", err)
		}
	}

	violations := newViolationRecorder(sdk.meterProvider)
	policy.rec = violations
	// The resource was classified before the violation counter existed.
	for rule, n := range resourceViolations {
		violations.add(spec.SignalResource, rule, int64(n))
	}

	sdk.tracerProvider, sdk.spanProcessors, err = buildTracerProvider(ctx, s, res, policy, sdk.spanFailures)
	if err != nil {
		return nil, err
	}
	if !s.disabled {
		sdk.handOver("traces")
	}

	var handler slog.Handler
	sdk.loggerProvider, sdk.logProcessors, handler, err = buildLogPipeline(ctx, s, res, policy, sdk.logFailures)
	if err != nil {
		return nil, err
	}
	if s.logExportEnabled() {
		sdk.handOver("logs")
	}

	errorHandler := s.errorHandler
	if errorHandler == nil {
		errorHandler = newRateLimitedErrorHandler(nil)
	}

	sdk.handler = handler
	sdk.logger = slog.New(handler)
	sdk.errorHandler = errorHandler
	if value := s.getenv(envSDKDisabled); value != "" && !s.disabled && !strings.EqualFold(value, "false") {
		// The specification asks an SDK to warn on a boolean variable that
		// is neither true nor false. Such a value counts as false.
		errorHandler(fmt.Errorf("o11y: %s=%q is neither true nor false; the SDK stays enabled", envSDKDisabled, value))
	}
	sdk.summaryAttrs, sdk.effectiveConfig = buildSummary(s, sdk)
	built = true
	return sdk, nil
}

// abandon stops a pipeline that New or Setup is discarding because
// construction failed. Nothing in it is worth flushing, so the parts it
// holds are stopped directly, each exactly once, with a context that is
// already past its deadline: the log processors, the span processors
// (including one from [WithSpanProcessor]), and the meter provider. The
// trace and log providers are not shut down, so how they would treat a
// done context does not matter; they are dropped with the SDK. Fields not
// yet built are skipped.
//
// What is guaranteed: abandon itself does not wait on the network, so the
// constructor returns promptly, and every processor and reader has been
// told to stop. A batch processor's goroutine may outlive abandon while it
// drains its queue into an exporter that honours the expired context, and
// a periodic metric export already in flight can hold the reader's
// shutdown until that export returns.
//
// Each call runs user code (an injected processor, reader, or exporter),
// so a panic from one is recovered and discarded: abandon may run while a
// panic is already unwinding through Setup, and that panic must reach the
// caller unchanged. abandon claims the one shutdown, so a later
// [SDK.Shutdown] reports a clean, finished shutdown.
func (s *SDK) abandon(ctx context.Context) {
	if !s.shutdownStarted.CompareAndSwap(false, true) {
		return
	}
	defer close(s.shutdownDone)
	ctx, cancel := context.WithDeadline(context.WithoutCancel(ctx), time.Unix(0, 0))
	defer cancel()

	for _, p := range s.logProcessors {
		stopQuietly(ctx, p.Shutdown)
	}
	for _, p := range s.spanProcessors {
		stopQuietly(ctx, p.Shutdown)
	}
	if s.meterProvider != nil {
		stopQuietly(ctx, s.meterProvider.Shutdown)
	}
	for _, p := range s.injected {
		stopQuietly(ctx, p.stop)
	}
}

// stopQuietly calls stop, discarding its error and recovering a panic it
// raises. The deferred recover only sees a panic raised by stop: one
// already unwinding through the caller is not handed to it.
func stopQuietly(ctx context.Context, stop func(context.Context) error) {
	defer func() { _ = recover() }()
	_ = stop(ctx)
}

// buildTracerProvider returns the tracer provider and the span processors
// registered on it, in registration order.
func buildTracerProvider(ctx context.Context, s *settings, res *resource.Resource, policy *sensitivityPolicy, failures *exportFailures) (*sdktrace.TracerProvider, []sdktrace.SpanProcessor, error) {
	var processors []sdktrace.SpanProcessor
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if s.ignoreEnv {
		opts = append(opts, sdktrace.WithRawSpanLimits(defaultSpanLimits()))
	}
	switch {
	case s.sampler != nil:
		opts = append(opts, sdktrace.WithSampler(s.sampler))
	case s.ignoreEnv:
		opts = append(opts, sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample())))
	}
	if s.disabled {
		// OTEL_SDK_DISABLED: no processor at all, so nothing is exported.
		// The provider still exists for the SDK's lifecycle; the SDK hands
		// out a no-op tracer provider instead (see SDK.TracerProvider), so
		// no span is recorded either.
		return sdktrace.NewTracerProvider(opts...), nil, nil
	}
	batch := traceBatchOptions(s)
	if s.spanProcessor != nil {
		// The injected processor sees the live span at OnStart and a
		// redacted view of the ended span at OnEnd. When an injected
		// exporter also runs, the exporter path counts the span's
		// violations, so the processor's redaction records none.
		procPolicy := policy
		if s.spanExporter != nil {
			procPolicy = policy.silent()
		}
		processors = append(processors, redactingProcessor(s.spanProcessor, procPolicy))
	}
	switch {
	case s.spanExporter != nil:
		processors = append(processors, sdktrace.NewBatchSpanProcessor(observedSpanExporter{redactingExporter(s.spanExporter, policy), failures}, batch...))
	case s.spanProcessor != nil, s.ignoreEnv:
		// A caller-supplied processor owns the export path, or the
		// environment is ignored: build no environment exporter. Spans are
		// still sampled and visible to in-process processors.
	default:
		exporter, err := autoexport.NewSpanExporter(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("o11y: building span exporter: %w", err)
		}
		processors = append(processors, sdktrace.NewBatchSpanProcessor(observedSpanExporter{redactingExporter(exporter, policy), failures}, batch...))
	}
	for _, p := range processors {
		opts = append(opts, sdktrace.WithSpanProcessor(p))
	}
	return sdktrace.NewTracerProvider(opts...), processors, nil
}

func buildMeterProvider(ctx context.Context, s *settings, res *resource.Resource, policy *sensitivityPolicy) (*sdkmetric.MeterProvider, error) {
	opts := []sdkmetric.Option{sdkmetric.WithResource(res)}
	opts = append(opts, meterProviderOptions(s)...)
	switch {
	case s.disabled:
		// OTEL_SDK_DISABLED: no reader, even an injected one, so nothing
		// is collected or exported.
	case s.metricReader != nil:
		opts = append(opts, sdkmetric.WithReader(s.metricReader))
	case s.ignoreEnv:
		// No injected reader and the environment is ignored: instruments
		// work but nothing is collected or exported.
	default:
		reader, err := autoexport.NewMetricReader(ctx)
		if err != nil {
			return nil, fmt.Errorf("o11y: building metric reader: %w", err)
		}
		opts = append(opts, sdkmetric.WithReader(reader))
	}
	switch {
	case s.exemplarFilter != nil:
		opts = append(opts, sdkmetric.WithExemplarFilter(s.exemplarFilter))
	case s.ignoreEnv:
		opts = append(opts, sdkmetric.WithExemplarFilter(exemplar.TraceBasedFilter))
	}
	// Every stream, user-defined or default, applies the sensitivity policy.
	for _, view := range policy.metricViews(s.views) {
		opts = append(opts, sdkmetric.WithView(view))
	}
	return sdkmetric.NewMeterProvider(opts...), nil
}

// buildLogPipeline assembles the slog fan-out: an optional console sink, an
// optional OTLP sink (through the otelslog bridge), and any extra sinks.
// Console and extra sinks receive top-level trace correlation attributes;
// the OTLP sink derives trace context natively from the record context.
func buildLogPipeline(ctx context.Context, s *settings, res *resource.Resource, policy *sensitivityPolicy, failures *exportFailures) (*sdklog.LoggerProvider, []sdklog.Processor, slog.Handler, error) {
	var legs []slog.Handler

	if s.consoleEnabled {
		handlerOpts := &slog.HandlerOptions{Level: s.logLevel}
		var console slog.Handler
		switch s.consoleFormat {
		case ConsoleText:
			console = slog.NewTextHandler(s.consoleWriter, handlerOpts)
		default:
			console = slog.NewJSONHandler(s.consoleWriter, handlerOpts)
		}
		legs = append(legs, classifyingHandler(fanout.Correlate(console), sinkConsole, policy))
	}

	var loggerProvider *sdklog.LoggerProvider
	var processors []sdklog.Processor
	if s.logExportEnabled() {
		exporter := s.logExporter
		if exporter == nil {
			var err error
			exporter, err = autoexport.NewLogExporter(ctx)
			if err != nil {
				return nil, nil, nil, fmt.Errorf("o11y: building log exporter: %w", err)
			}
		}
		processors = []sdklog.Processor{
			redactingLogProcessor{policy: policy},
			sdklog.NewBatchProcessor(observedLogExporter{exporter, failures}, logBatchOptions(s)...),
		}
		providerOpts := []sdklog.LoggerProviderOption{sdklog.WithResource(res)}
		for _, p := range processors {
			providerOpts = append(providerOpts, sdklog.WithProcessor(p))
		}
		providerOpts = append(providerOpts, logProviderOptions(s)...)
		loggerProvider = sdklog.NewLoggerProvider(providerOpts...)
		otlp := otelslog.NewHandler(scopeName,
			otelslog.WithLoggerProvider(loggerProvider),
			otelslog.WithSource(true),
		)
		// Records from this leg are classified on slog values, before the
		// bridge converts them, and marked so the provider's redacting
		// processor (which covers every other bridge) does not classify
		// them again.
		legs = append(legs, classifyingHandler(otlp, sinkOTLP, policy))
	}

	for _, extra := range s.extraLogHandler {
		legs = append(legs, classifyingHandler(fanout.Correlate(extra), sinkConsole, policy))
	}

	// Spec classification now runs per leg (see classifyingHandler); the shared
	// fan-out replacer carries only the user-supplied replacer, so every sink
	// still sees identical attributes before per-sink classification.
	handler := fanout.New(fanout.Config{
		Legs:    legs,
		Level:   s.logLevel,
		Replace: userReplaceFunc(s.attrReplacer),
	})
	return loggerProvider, processors, handler, nil
}

// userReplaceFunc adapts an optional user [AttrReplacer] to the fan-out
// replacer contract, returning nil when the caller supplied none so the
// fan-out skips the replace pass entirely.
func userReplaceFunc(user AttrReplacer) fanout.ReplaceFunc {
	if user == nil {
		return nil
	}
	return fanout.ReplaceFunc(user)
}

// live reports whether s was built by [New] or [Setup], rather than being a
// nil pointer or the zero value. newSDK sets the handler only once every
// provider is built, and a zero SDK has none.
func (s *SDK) live() bool { return s != nil && s.handler != nil }

// inertHandler returns the handler an inert handle logs through: slog's
// text handler over os.Stderr, looked up at each write. It never touches
// the log package.
func inertHandler() slog.Handler { return slog.NewTextHandler(stderrWriter{}, nil) }

// stderrWriter writes to whatever os.Stderr is at the time of the write.
type stderrWriter struct{}

func (stderrWriter) Write(p []byte) (int, error) { return os.Stderr.Write(p) }

// TracerProvider returns the SDK's tracer provider, or the OpenTelemetry
// no-op tracer provider on an inert handle and while OTEL_SDK_DISABLED
// switches the SDK off. The no-op provider records nothing, and a span it
// starts carries the parent's span context, so context still propagates
// and logs stay correlated with an inbound trace.
func (s *SDK) TracerProvider() trace.TracerProvider {
	if !s.live() || s.disabled {
		return tracenoop.NewTracerProvider()
	}
	return s.tracerProvider
}

// MeterProvider returns the SDK's meter provider, or the OpenTelemetry
// no-op meter provider on an inert handle.
func (s *SDK) MeterProvider() metric.MeterProvider {
	if !s.live() {
		return metricnoop.NewMeterProvider()
	}
	return s.meterProvider
}

// Propagator returns the SDK's context propagator (by default a composite
// of W3C Trace Context and W3C Baggage). Whichever propagator is
// configured, it is wrapped by the baggage egress filter, so the value
// returned is not the one passed to [WithPropagators]. On an inert handle
// it returns a propagator that injects and extracts nothing.
func (s *SDK) Propagator() propagation.TextMapPropagator {
	if !s.live() {
		return propagation.NewCompositeTextMapPropagator()
	}
	return s.propagator
}

// Resource returns the resource describing this process's telemetry
// identity, or an empty resource on an inert handle.
func (s *SDK) Resource() *resource.Resource {
	if !s.live() {
		return resource.Empty()
	}
	return s.res
}

// Handler returns the correlated slog handler backing [SDK.Logger]. Use it
// to construct additional loggers that share the SDK's log pipeline.
//
// On an inert handle it returns a text handler that writes records at Info
// and above to os.Stderr, so the host's logs are not lost; Debug records
// are dropped. It is not slog.Default().Handler():
// slog's built-in default writes through the log package, so a host that
// wrapped it and installed the wrapper with [slog.SetDefault] would route
// every record back into the wrapper and hang. This handler is safe to wrap
// and install as the default.
func (s *SDK) Handler() slog.Handler {
	if !s.live() {
		return inertHandler()
	}
	return s.handler
}

// LoggerProvider returns the SDK's OpenTelemetry logger provider, for log
// bridges other than slog (otelzap, otellogr, and so on). Records emitted
// through it receive the same sensitivity enforcement as the slog pipeline:
// secret and PII attributes, including those nested in map values, are
// dropped or tokenized per [WithPIIMode]. When log export is disabled it
// returns a no-op provider, as it does on an inert handle.
func (s *SDK) LoggerProvider() log.LoggerProvider {
	if !s.live() || s.loggerProvider == nil {
		return lognoop.NewLoggerProvider()
	}
	return s.loggerProvider
}

// Logger returns a logger that writes to every configured log sink with
// trace correlation. On an inert handle it returns a logger over the same
// stderr text handler [SDK.Handler] returns, which writes at Info and above,
// rather than [slog.Default], so the two agree and the logger is safe
// however the host sets its default.
func (s *SDK) Logger() *slog.Logger {
	if !s.live() {
		return slog.New(inertHandler())
	}
	return s.logger
}

// Shutdown flushes and stops all telemetry pipelines concurrently under one
// deadline, so a hung exporter on one signal cannot consume the budget of
// the others. It is idempotent: the first call performs the shutdown and
// every call returns its result, but a concurrent caller stops waiting when
// its own ctx ends. If ctx carries no deadline a 5 second timeout is
// applied. The returned error aggregates per-signal failures and can be
// inspected with [errors.Is]/[errors.As]; a non-nil error means buffered
// telemetry may have been dropped, never that the host application is
// broken.
//
// Shutdown does not wait past the deadline. The signals stop under a
// deadline a little ahead of it (a tenth of the time left, at most 100 ms),
// so a signal that runs out of time reports its own error, with the
// exports that failed. A signal that still has not returned when ctx ends
// is reported as "did not finish", wrapping the context's error, and that
// is the result every later call returns. This covers an injected
// processor, reader, or exporter that ignores its context: its own
// shutdown keeps running on a goroutine of its own until it returns, so do
// not hand that same instance to another SDK while it does. A ctx that is
// cancelled, or already past its deadline, can end the wait while a signal
// is still reporting, and that signal is then reported as unfinished.
//
// The first caller writes an o11y.telemetry.dropped event for each failed
// signal before it returns, synchronously, as any log call on the console
// and extra sinks is. A concurrent caller gets the result as soon as it is
// known and can return before those events are written.
//
// The error covers every span and log export that fails while the call
// runs, including a batch the processors export on their own goroutines
// that the call did not start, as well as the final flush. Two overlapping
// Shutdown or ForceFlush calls each report the same failure. The first
// five distinct failures are reported in full and the rest are counted.
// Each failure also still reaches the error handler.
func (s *SDK) Shutdown(ctx context.Context) error {
	if !s.live() {
		return nil
	}
	if s.shutdownStarted.CompareAndSwap(false, true) {
		s.runShutdown(ctx)
		return s.shutdownErr
	}
	// A finished shutdown wins over a done ctx; select alone would choose
	// between two ready cases at random.
	select {
	case <-s.shutdownDone:
		return s.shutdownErr
	default:
	}
	select {
	case <-s.shutdownDone:
		return s.shutdownErr
	case <-ctx.Done():
		return fmt.Errorf("o11y: waiting for shutdown: %w", ctx.Err())
	}
}

// runShutdown performs the one shutdown, records its result in shutdownErr,
// and closes shutdownDone so waiting callers observe it. It returns when
// every signal has stopped or ctx ends, whichever comes first.
func (s *SDK) runShutdown(ctx context.Context) {
	ctx, cancel := ensureDeadline(ctx)
	defer cancel()
	// The signals stop under a deadline a little ahead of the caller's
	// (see shutdownReserve), so one that runs out of time reports its own
	// error, with the exports that failed, before this call stops waiting.
	stepCtx, cancelSteps := withReserve(ctx)
	defer cancelSteps()

	type step struct {
		signal   string
		shutdown func(context.Context) error
	}
	// Each signal's step also shuts down the injected parts of that signal
	// that no provider owns (see injectedPart).
	steps := []step{
		{"logs", func(ctx context.Context) error {
			var err error
			if s.loggerProvider != nil {
				err = s.logFailures.during(ctx, s.loggerProvider.Shutdown)
			}
			return errors.Join(err, s.stopInjected(ctx, "logs"))
		}},
		{"metrics", func(ctx context.Context) error {
			return errors.Join(s.meterProvider.Shutdown(ctx), s.stopInjected(ctx, "metrics"))
		}},
		{"traces", func(ctx context.Context) error {
			return errors.Join(s.spanFailures.during(ctx, s.tracerProvider.Shutdown), s.stopInjected(ctx, "traces"))
		}},
	}
	// Each step reports on a channel with room for every result, so a step
	// that outlives the wait below still finishes and its goroutine ends.
	type result struct {
		step int
		err  error
	}
	results := make(chan result, len(steps))
	for i, st := range steps {
		go func() { results <- result{step: i, err: st.shutdown(stepCtx)} }()
	}
	causes := make([]error, len(steps)) // what each signal reported, unwrapped
	finished := make([]bool, len(steps))
	record := func(r result) { finished[r.step], causes[r.step] = true, r.err }
wait:
	for range steps {
		select {
		case r := <-results:
			record(r)
		case <-ctx.Done():
			break wait
		}
	}
	// The caller's context ended with steps still running. Take the
	// results that are already in (this goroutine is the only receiver, so
	// len is exact), and report every other step as unfinished. Its
	// goroutine keeps running until the part it is stopping returns, which
	// a part that ignores its context decides, not the SDK.
	for len(results) > 0 {
		record(<-results)
	}
	errs := make([]error, len(steps))
	for i, st := range steps {
		if !finished[i] {
			causes[i] = fmt.Errorf("did not finish: %w", ctx.Err())
		}
		if causes[i] != nil {
			errs[i] = fmt.Errorf("o11y: shutdown %s: %w", st.signal, causes[i])
		}
	}
	// Publish the result before the dropped events go out, so a slow log
	// sink holds no other caller. Release the Setup guard before closing
	// shutdownDone so a concurrent caller that wakes up can call Setup
	// immediately without racing ErrAlreadySetup.
	s.shutdownErr = errors.Join(errs...)
	if s.global {
		releaseSetupGuard()
	}
	close(s.shutdownDone)
	// The OTLP log leg is down here, or still stopping, so dropped events
	// reach the console and extra sinks only; delivery is best effort by
	// design. It is synchronous, like every log call on those sinks, so the
	// event is written before a host that exits after Shutdown is gone. The
	// context may have ended by now, and a sink that checks it must still
	// take the event, so the event goes out on one that cannot end.
	emitCtx := context.WithoutCancel(ctx)
	for i, st := range steps {
		if causes[i] != nil {
			s.emitDropped(emitCtx, st.signal, causes[i])
		}
	}
}

// shutdownReserve is the most [SDK.Shutdown] keeps back from the signals'
// deadline: a tenth of the time left, up to this much.
const shutdownReserve = 100 * time.Millisecond

// withReserve returns a context that ends shortly before ctx does, by a
// tenth of the time ctx has left and at most shutdownReserve. A signal
// stopped under it that runs out of time returns while the caller of
// Shutdown is still waiting, so its own error is the one reported. ctx must
// carry a deadline. With none left to share, withReserve returns ctx.
func withReserve(ctx context.Context) (context.Context, context.CancelFunc) {
	deadline, ok := ctx.Deadline()
	if !ok {
		return ctx, func() {}
	}
	reserve := min(time.Until(deadline)/10, shutdownReserve)
	if reserve <= 0 {
		return ctx, func() {}
	}
	return context.WithDeadline(ctx, deadline.Add(-reserve))
}

// ForceFlush exports all buffered telemetry without stopping the pipelines.
// If ctx carries no deadline a 5 second timeout is applied. The returned
// error covers failed exports as [SDK.Shutdown] describes: every span and
// log export that fails while the call runs, including a background batch
// export the call did not start, and two overlapping calls each report the
// same failure.
func (s *SDK) ForceFlush(ctx context.Context) error {
	if !s.live() {
		return nil
	}
	ctx, cancel := ensureDeadline(ctx)
	defer cancel()

	var errs []error
	if s.loggerProvider != nil {
		if err := s.logFailures.during(ctx, s.loggerProvider.ForceFlush); err != nil {
			errs = append(errs, fmt.Errorf("o11y: flush logs: %w", err))
		}
	}
	if err := s.meterProvider.ForceFlush(ctx); err != nil {
		errs = append(errs, fmt.Errorf("o11y: flush metrics: %w", err))
	}
	if err := s.spanFailures.during(ctx, s.tracerProvider.ForceFlush); err != nil {
		errs = append(errs, fmt.Errorf("o11y: flush traces: %w", err))
	}
	return errors.Join(errs...)
}

func ensureDeadline(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, defaultShutdownTimeout)
}
