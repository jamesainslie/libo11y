package o11y

import (
	"context"
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
// [ErrAlreadySetup]. Shutting the returned SDK down releases the guard so a
// subsequent Setup succeeds (the previous providers remain installed until
// then). Use [New] for additional, isolated pipelines.
func Setup(ctx context.Context, opts ...Option) (*SDK, error) {
	setupMu.Lock()
	defer setupMu.Unlock()
	if setupActive {
		return nil, ErrAlreadySetup
	}

	s := newSettings(opts)
	sdk, err := newSDK(ctx, s)
	if err != nil {
		return nil, err
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

	setupActive = true
	return sdk, nil
}

func releaseSetupGuard() {
	setupMu.Lock()
	defer setupMu.Unlock()
	setupActive = false
}
