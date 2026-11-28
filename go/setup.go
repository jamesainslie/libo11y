package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"go.opentelemetry.io/otel"
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
		// The caller still handed over what its options injected, so this
		// exit stops it too, after the mutex is released (it is user code)
		// and without touching the installed SDK.
		discardInjected(ctx, newSettings(opts))
		return nil, ErrAlreadySetup
	}
	setupActive = true
	setupMu.Unlock()

	// Every exit but success releases the guard and abandons whatever was
	// built, without flushing it, including a panic from a user-supplied
	// sink unwinding through here. The panic is not recovered: it reaches
	// the caller unchanged.
	var sdk *SDK
	succeeded := false
	defer func() {
		if succeeded {
			return
		}
		defer releaseSetupGuard()
		if sdk != nil {
			sdk.abandon(ctx)
		}
	}()

	s := newSettings(opts)
	sdk, err := newSDK(ctx, s)
	if err != nil {
		return nil, err
	}

	// The startup summary doubles as the initialization canary: it is
	// forced through the full pipeline before any global is installed, so
	// a rejecting sink fails Setup instead of dropping records later.
	if s.startupSummary {
		if err := sdk.emitStartupSummary(ctx, sdk.summaryAttrs); err != nil {
			return nil, fmt.Errorf("o11y: startup canary rejected by log pipeline: %w", err)
		}
	}
	sdk.global = true

	otel.SetTracerProvider(sdk.TracerProvider())
	otel.SetMeterProvider(sdk.meterProvider)
	// Always installed, as a no-op provider when the SDK exports no logs,
	// so a provider installed earlier does not go on receiving records.
	otel.SetLoggerProvider(sdk.LoggerProvider())
	otel.SetTextMapPropagator(sdk.propagator)
	otel.SetErrorHandler(otel.ErrorHandlerFunc(sdk.errorHandler))
	if s.installSlogDefault {
		slog.SetDefault(sdk.logger)
	}

	succeeded = true
	return sdk, nil
}

func releaseSetupGuard() {
	setupMu.Lock()
	defer setupMu.Unlock()
	setupActive = false
}
