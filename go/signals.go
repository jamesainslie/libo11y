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
	notifyCtx, stop := signal.NotifyContext(ctx, signals...)
	<-notifyCtx.Done()
	stop()
	return s.Shutdown(context.WithoutCancel(ctx))
}
