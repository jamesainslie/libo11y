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
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/internal/fanout"
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
	res, err := buildResource(ctx, s)
	if err != nil {
		return nil, err
	}

	propagator := s.propagator
	if propagator == nil {
		propagator = propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
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

	tracerProvider, err := buildTracerProvider(ctx, s, res)
	if err != nil {
		return nil, err
	}
	cleanups = append(cleanups, tracerProvider.Shutdown)

	meterProvider, err := buildMeterProvider(ctx, s, res)
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
	loggerProvider, handler, err := buildLogPipeline(ctx, s, res, violations)
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

func buildTracerProvider(ctx context.Context, s *settings, res *resource.Resource) (*sdktrace.TracerProvider, error) {
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if s.sampler != nil {
		opts = append(opts, sdktrace.WithSampler(s.sampler))
	}
	switch {
	case s.spanProcessor != nil:
		opts = append(opts, sdktrace.WithSpanProcessor(s.spanProcessor))
	case s.spanExporter != nil:
		opts = append(opts, sdktrace.WithBatcher(s.spanExporter))
	default:
		exporter, err := autoexport.NewSpanExporter(ctx)
		if err != nil {
			return nil, fmt.Errorf("o11y: building span exporter: %w", err)
		}
		opts = append(opts, sdktrace.WithBatcher(exporter))
	}
	return sdktrace.NewTracerProvider(opts...), nil
}

func buildMeterProvider(ctx context.Context, s *settings, res *resource.Resource) (*sdkmetric.MeterProvider, error) {
	reader := s.metricReader
	if reader == nil {
		var err error
		reader, err = autoexport.NewMetricReader(ctx)
		if err != nil {
			return nil, fmt.Errorf("o11y: building metric reader: %w", err)
		}
	}
	opts := []sdkmetric.Option{
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(reader),
	}
	if s.exemplarFilter != nil {
		opts = append(opts, sdkmetric.WithExemplarFilter(s.exemplarFilter))
	}
	for _, view := range s.views {
		opts = append(opts, sdkmetric.WithView(view))
	}
	return sdkmetric.NewMeterProvider(opts...), nil
}

// buildLogPipeline assembles the slog fan-out: an optional console sink, an
// optional OTLP sink (through the otelslog bridge), and any extra sinks.
// Console and extra sinks receive top-level trace correlation attributes;
// the OTLP sink derives trace context natively from the record context.
func buildLogPipeline(ctx context.Context, s *settings, res *resource.Resource, violations *violationRecorder) (*sdklog.LoggerProvider, slog.Handler, error) {
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
		legs = append(legs, classifyingHandler(fanout.Correlate(console), sinkConsole, s.piiMode, violations))
	}

	var loggerProvider *sdklog.LoggerProvider
	if s.logExport {
		exporter, err := autoexport.NewLogExporter(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("o11y: building log exporter: %w", err)
		}
		loggerProvider = sdklog.NewLoggerProvider(
			sdklog.WithResource(res),
			sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
		)
		otlp := otelslog.NewHandler(scopeName,
			otelslog.WithLoggerProvider(loggerProvider),
			otelslog.WithSource(true),
		)
		legs = append(legs, classifyingHandler(otlp, sinkOTLP, s.piiMode, violations))
	}

	for _, extra := range s.extraLogHandler {
		legs = append(legs, classifyingHandler(fanout.Correlate(extra), sinkConsole, s.piiMode, violations))
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
