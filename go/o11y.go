// Package o11y is an opinionated, one-call setup layer for OpenTelemetry in
// Go: traces, metrics, and logs over OTLP with unified configuration, W3C
// context propagation, and log/trace correlation.
//
// The package wraps OpenTelemetry setup, never instrumentation. After
// [Setup] (or [New]) your application uses the vanilla OTEL API for traces
// and metrics and the standard [log/slog] facade for logs; every signal is
// correlated through the active span context and exported over OTLP.
//
//	sdk, err := o11y.Setup(ctx, o11y.WithServiceName("checkout"))
//	if err != nil {
//		return err
//	}
//	defer sdk.Shutdown(context.Background())
//
//	slog.InfoContext(ctx, "ready")     // correlated, exported
//	tracer := otel.Tracer("checkout")  // vanilla OTEL from here on
//
// Configuration follows a strict precedence: explicit options override the
// standard OTEL_* environment variables, which override library defaults.
// The package defines no environment variables of its own.
package o11y

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/exporters/autoexport"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel/log"
	lognoop "go.opentelemetry.io/otel/log/noop"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

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
// The zero value is not usable.
type SDK struct {
	res            *resource.Resource
	tracerProvider *sdktrace.TracerProvider
	meterProvider  *sdkmetric.MeterProvider
	loggerProvider *sdklog.LoggerProvider
	propagator     propagation.TextMapPropagator
	handler        slog.Handler
	logger         *slog.Logger
	errorHandler   ErrorHandler
	global         bool

	effectiveConfig string
	summaryAttrs    []slog.Attr

	shutdownOnce sync.Once
	shutdownErr  error
}

// New builds an SDK without touching any process-global state: no global
// providers, no global propagator, no default logger. Use it for tests,
// dependency injection, or hosting several isolated pipelines in one
// process. Most applications want [Setup] instead.
func New(ctx context.Context, opts ...Option) (*SDK, error) {
	return newSDK(ctx, newSettings(opts))
}

func newSDK(ctx context.Context, s *settings) (_ *SDK, err error) {
	if s.piiMode == PIIHash && len(s.piiHashKey) < minPIIHashKeyLen {
		return nil, ErrPIIHashKey
	}
	// One policy serves every signal. The resource and the meter provider's
	// views need it before the violation counter (built on that provider)
	// exists, so the recorder is attached below, before any provider is
	// handed out or used concurrently. Resource classification counts its
	// violations separately, and metric filtering never records any.
	policy := newSensitivityPolicy(s, nil)
	res, resourceViolations, err := buildResource(ctx, s, policy)
	if err != nil {
		return nil, err
	}

	propagator := s.propagator
	if propagator == nil {
		propagator = propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			filterBaggageEgress(propagation.Baggage{}, func(string) bool { return true }),
		)
	}

	// Tear down partially constructed providers if a later step fails.
	var cleanups []func(context.Context) error
	defer func() {
		if err == nil {
			return
		}
		for _, cleanup := range cleanups {
			_ = cleanup(ctx) // best effort: the constructor error is what matters
		}
	}()

	meterProvider, err := buildMeterProvider(ctx, s, res, policy)
	if err != nil {
		return nil, err
	}
	cleanups = append(cleanups, meterProvider.Shutdown)

	if s.runtimeMetrics {
		if err := runtime.Start(runtime.WithMeterProvider(meterProvider)); err != nil {
			return nil, fmt.Errorf("o11y: starting runtime metrics: %w", err)
		}
	}

	violations := newViolationRecorder(meterProvider)
	policy.rec = violations
	// The resource was classified before the violation counter existed.
	for rule, n := range resourceViolations {
		violations.add(spec.SignalResource, rule, int64(n))
	}

	tracerProvider, err := buildTracerProvider(ctx, s, res, policy)
	if err != nil {
		return nil, err
	}
	cleanups = append(cleanups, tracerProvider.Shutdown)

	loggerProvider, handler, err := buildLogPipeline(ctx, s, res, policy)
	if err != nil {
		return nil, err
	}

	errorHandler := s.errorHandler
	if errorHandler == nil {
		errorHandler = newRateLimitedErrorHandler(nil)
	}

	sdk := &SDK{
		res:            res,
		tracerProvider: tracerProvider,
		meterProvider:  meterProvider,
		loggerProvider: loggerProvider,
		propagator:     propagator,
		handler:        handler,
		logger:         slog.New(handler),
		errorHandler:   errorHandler,
	}
	sdk.summaryAttrs, sdk.effectiveConfig = buildSummary(s, sdk)
	return sdk, nil
}

func buildTracerProvider(ctx context.Context, s *settings, res *resource.Resource, policy *sensitivityPolicy) (*sdktrace.TracerProvider, error) {
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
	batch := traceBatchOptions(s)
	if s.spanProcessor != nil {
		// The injected processor sees the live span at OnStart and a
		// redacted view of the ended span at OnEnd.
		opts = append(opts, sdktrace.WithSpanProcessor(redactingProcessor(s.spanProcessor, policy)))
	}
	switch {
	case s.spanExporter != nil:
		opts = append(opts, sdktrace.WithBatcher(redactingExporter(s.spanExporter, policy), batch...))
	case s.spanProcessor != nil, s.ignoreEnv:
		// A caller-supplied processor owns the export path, or the
		// environment is ignored: build no environment exporter. Spans are
		// still sampled and visible to in-process processors.
	default:
		exporter, err := autoexport.NewSpanExporter(ctx)
		if err != nil {
			return nil, fmt.Errorf("o11y: building span exporter: %w", err)
		}
		opts = append(opts, sdktrace.WithBatcher(redactingExporter(exporter, policy), batch...))
	}
	return sdktrace.NewTracerProvider(opts...), nil
}

func buildMeterProvider(ctx context.Context, s *settings, res *resource.Resource, policy *sensitivityPolicy) (*sdkmetric.MeterProvider, error) {
	opts := []sdkmetric.Option{sdkmetric.WithResource(res)}
	opts = append(opts, meterProviderOptions(s)...)
	switch {
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
func buildLogPipeline(ctx context.Context, s *settings, res *resource.Resource, policy *sensitivityPolicy) (*sdklog.LoggerProvider, slog.Handler, error) {
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
	if s.logExportEnabled() {
		exporter := s.logExporter
		if exporter == nil {
			var err error
			exporter, err = autoexport.NewLogExporter(ctx)
			if err != nil {
				return nil, nil, fmt.Errorf("o11y: building log exporter: %w", err)
			}
		}
		providerOpts := []sdklog.LoggerProviderOption{
			sdklog.WithResource(res),
			sdklog.WithProcessor(redactingLogProcessor{policy: policy}),
			sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter, logBatchOptions(s)...)),
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
	return loggerProvider, handler, nil
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

// TracerProvider returns the SDK's tracer provider.
func (s *SDK) TracerProvider() trace.TracerProvider { return s.tracerProvider }

// MeterProvider returns the SDK's meter provider.
func (s *SDK) MeterProvider() metric.MeterProvider { return s.meterProvider }

// Propagator returns the SDK's context propagator (by default a composite
// of W3C Trace Context and W3C Baggage).
func (s *SDK) Propagator() propagation.TextMapPropagator { return s.propagator }

// Resource returns the resource describing this process's telemetry
// identity.
func (s *SDK) Resource() *resource.Resource { return s.res }

// Handler returns the correlated slog handler backing [SDK.Logger]. Use it
// to construct additional loggers that share the SDK's log pipeline.
func (s *SDK) Handler() slog.Handler { return s.handler }

// LoggerProvider returns the SDK's OpenTelemetry logger provider, for log
// bridges other than slog (otelzap, otellogr, and so on). Records emitted
// through it receive the same sensitivity enforcement as the slog pipeline:
// secret and PII attributes, including those nested in map values, are
// dropped or tokenized per [WithPIIMode]. When log export is disabled it
// returns a no-op provider.
func (s *SDK) LoggerProvider() log.LoggerProvider {
	if s.loggerProvider == nil {
		return lognoop.NewLoggerProvider()
	}
	return s.loggerProvider
}

// Logger returns a logger that writes to every configured log sink with
// trace correlation.
func (s *SDK) Logger() *slog.Logger { return s.logger }

// Shutdown flushes and stops all telemetry pipelines: logs, then metrics,
// then traces. It is idempotent; concurrent and repeated calls return the
// first result. If ctx carries no deadline a 5 second timeout is applied.
// The returned error aggregates per-signal failures and can be inspected
// with [errors.Is]/[errors.As]; a non-nil error means buffered telemetry may
// have been dropped, never that the host application is broken.
func (s *SDK) Shutdown(ctx context.Context) error {
	s.shutdownOnce.Do(func() {
		ctx, cancel := ensureDeadline(ctx)
		defer cancel()

		var errs []error
		if s.loggerProvider != nil {
			if err := s.loggerProvider.Shutdown(ctx); err != nil {
				errs = append(errs, fmt.Errorf("o11y: shutdown logs: %w", err))
				s.emitDropped(ctx, "logs", err)
			}
		}
		if err := s.meterProvider.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("o11y: shutdown metrics: %w", err))
			s.emitDropped(ctx, "metrics", err)
		}
		if err := s.tracerProvider.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("o11y: shutdown traces: %w", err))
			s.emitDropped(ctx, "traces", err)
		}
		s.shutdownErr = errors.Join(errs...)

		if s.global {
			releaseSetupGuard()
		}
	})
	return s.shutdownErr
}

// ForceFlush exports all buffered telemetry without stopping the pipelines.
// If ctx carries no deadline a 5 second timeout is applied.
func (s *SDK) ForceFlush(ctx context.Context) error {
	ctx, cancel := ensureDeadline(ctx)
	defer cancel()

	var errs []error
	if s.loggerProvider != nil {
		if err := s.loggerProvider.ForceFlush(ctx); err != nil {
			errs = append(errs, fmt.Errorf("o11y: flush logs: %w", err))
		}
	}
	if err := s.meterProvider.ForceFlush(ctx); err != nil {
		errs = append(errs, fmt.Errorf("o11y: flush metrics: %w", err))
	}
	if err := s.tracerProvider.ForceFlush(ctx); err != nil {
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
