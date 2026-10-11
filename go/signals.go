package o11y

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

// ShutdownOnSignals blocks until one of the given signals arrives (or ctx
// is canceled), then shuts the SDK down and returns the shutdown result.
// With no signals given it waits for SIGINT and SIGTERM.
//
// Signal handling is restored on the first delivery, so a second signal
// terminates the process immediately instead of waiting on the flush:
//
//	sdk, err := o11y.Setup(ctx, o11y.WithServiceName("worker"))
//	if err != nil {
//		return err
//	}
//	go server.Run()
//	return sdk.ShutdownOnSignals(ctx)
//
// The flush is bounded by the SDK's usual shutdown deadline even though the
// triggering context is, by then, canceled.
func (s *SDK) ShutdownOnSignals(ctx context.Context, signals ...os.Signal) error {
	if len(signals) == 0 {
		signals = []os.Signal{os.Interrupt, syscall.SIGTERM}
	}
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, signals...)
	return s.shutdownOn(ctx, ch)
}

// shutdownOn waits for a signal on sig or for ctx to end, then shuts down
// with a context that keeps ctx's values but not its cancellation, so the
// flush is still bounded by the SDK's own deadline.
//
// Signal delivery to sig is stopped before the flush starts, restoring the
// default handling, so a second signal terminates the process instead of
// being swallowed while the flush runs. signal.Stop is a no-op for a channel
// that was never registered with signal.Notify, which is what lets tests
// drive this seam with a plain channel and no real signal.
func (s *SDK) shutdownOn(ctx context.Context, sig chan os.Signal) error {
	select {
	case <-sig:
	case <-ctx.Done():
	}
	signal.Stop(sig)
	return s.Shutdown(context.WithoutCancel(ctx))
}
