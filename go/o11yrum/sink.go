package o11yrum

import (
	"context"
	"errors"
	"fmt"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// Batch is one processed request. Sinks must not modify it: the traces or
// logs are marked read-only before export and are shared by every sink.
type Batch struct {
	// Service is the app's service.name.
	Service string
	// Signal is SignalTraces or SignalLogs.
	Signal Signal
	// Traces is set when Signal is SignalTraces. It is read-only.
	Traces ptrace.Traces
	// Logs is set when Signal is SignalLogs. It is read-only.
	Logs plog.Logs
}

// Sink receives every processed batch of traces and logs. An error makes
// the gateway answer 503, so the client keeps the batch and retries it.
// The gateway has no disk buffer.
type Sink interface {
	// Name identifies the sink in logs and self-telemetry.
	Name() string
	// Export delivers one batch. It must not modify b.
	Export(ctx context.Context, b Batch) error
}

// exportAll hands b to every sink, even after one fails, and joins their
// errors.
func exportAll(ctx context.Context, sinks []Sink, b Batch) error {
	var errs []error
	for _, s := range sinks {
		if err := s.Export(ctx, b); err != nil {
			errs = append(errs, fmt.Errorf("sink %s: %w", s.Name(), err))
		}
	}
	return errors.Join(errs...)
}
