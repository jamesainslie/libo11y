package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"go.opentelemetry.io/otel"
	logglobal "go.opentelemetry.io/otel/log/global"
)

var (
	setupMu     sync.Mutex
	setupActive bool
)

// Setup builds an SDK with [New] and installs it as the process default:
// the OTEL global tracer, meter, and logger providers, the global text map
// propagator, the global OTEL error handler, and (unless
// [WithoutSlogDefault] is given) the slog default logger. Third-party
// OTEL-instrumented libraries work untouched afterwards.
//
// Only one global SDK may be active at a time; a second call returns
// [ErrAlreadySetup], including calls racing an in-flight Setup that has
// not finished constructing. Shutting the returned SDK down releases the
// guard so a subsequent Setup succeeds (the previous providers remain
// installed until then). Use [New] for additional, isolated pipelines.
func Setup(ctx context.Context, opts ...Option) (*SDK, error) {
	// Claim the guard, then construct outside the lock: user-supplied
	// sinks run during the startup canary, and no user code may ever
	// execute under the process-wide mutex. A sink that itself calls
	// Setup gets ErrAlreadySetup instead of deadlocking the guard, and
	// losers of a Setup race fail fast instead of queueing behind a slow
	// winner.
	setupMu.Lock()
	if setupActive {
		setupMu.Unlock()
		return nil, ErrAlreadySetup
	}
	setupActive = true
	setupMu.Unlock()

	s := newSettings(opts)
	sdk, err := newSDK(ctx, s)
	if err != nil {
		releaseSetupGuard()
		return nil, err
	}

	// The startup summary doubles as the initialization canary: it is
	// forced through the full pipeline before any global is installed, so
	// a rejecting sink fails Setup instead of dropping records later.
	if s.startupSummary {
		if err := sdk.emitStartupSummary(ctx, sdk.summaryAttrs); err != nil {
			_ = sdk.Shutdown(ctx) // best effort: the canary error is what matters
			releaseSetupGuard()
			return nil, fmt.Errorf("o11y: startup canary rejected by log pipeline: %w", err)
		}
	}
	sdk.global = true

	otel.SetTracerProvider(sdk.tracerProvider)
	otel.SetMeterProvider(sdk.meterProvider)
	if sdk.loggerProvider != nil {
		logglobal.SetLoggerProvider(sdk.loggerProvider)
	}
	otel.SetTextMapPropagator(sdk.propagator)
	otel.SetErrorHandler(otel.ErrorHandlerFunc(sdk.errorHandler))
	if s.installSlogDefault {
		slog.SetDefault(sdk.logger)
	}

	return sdk, nil
}

func releaseSetupGuard() {
	setupMu.Lock()
	defer setupMu.Unlock()
	setupActive = false
}
