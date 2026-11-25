package o11y

import (
	"context"
	"errors"
	"sync"
	"time"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
)

// injectedPart is a span processor, exporter, or metric reader an option
// injected. The SDK owns it from the moment New starts: when it is
// registered with a provider or processor (handed), that owner shuts it
// down; when it is not, because OTEL_SDK_DISABLED switched the SDK off,
// WithoutLogExport left a log exporter unused, or construction failed
// first, the SDK shuts it down itself, exactly once.
type injectedPart struct {
	signal   string
	shutdown func(context.Context) error
	handed   bool
	once     sync.Once
}

// stop shuts p down unless it was handed to an owner or already stopped.
// An unregistered reader that reports [sdkmetric.ErrReaderNotRegistered]
// has stopped as asked, so that is not an error.
func (p *injectedPart) stop(ctx context.Context) error {
	if p.handed {
		return nil
	}
	var err error
	p.once.Do(func() { err = p.shutdown(ctx) })
	if errors.Is(err, sdkmetric.ErrReaderNotRegistered) {
		return nil
	}
	return err
}

// injectedParts lists what s injects, in a fixed order.
func injectedParts(s *settings) []*injectedPart {
	var parts []*injectedPart
	if s.spanProcessor != nil {
		parts = append(parts, &injectedPart{signal: "traces", shutdown: s.spanProcessor.Shutdown})
	}
	if s.spanExporter != nil {
		parts = append(parts, &injectedPart{signal: "traces", shutdown: s.spanExporter.Shutdown})
	}
	if s.logExporter != nil {
		parts = append(parts, &injectedPart{signal: "logs", shutdown: s.logExporter.Shutdown})
	}
	if s.metricReader != nil {
		parts = append(parts, &injectedPart{signal: "metrics", shutdown: s.metricReader.Shutdown})
	}
	return parts
}

// handOver marks the injected parts of signal as owned by the provider or
// processor that was just built around them.
func (s *SDK) handOver(signal string) {
	for _, p := range s.injected {
		if p.signal == signal {
			p.handed = true
		}
	}
}

// stopInjected stops the injected parts of signal that no provider owns,
// and returns their errors joined. An empty signal stops every signal's.
func (s *SDK) stopInjected(ctx context.Context, signal string) error {
	var errs []error
	for _, p := range s.injected {
		if signal == "" || p.signal == signal {
			errs = append(errs, p.stop(ctx))
		}
	}
	return errors.Join(errs...)
}

// stopInjectedNow stops the unowned injected parts of signal during
// construction. Nothing was registered with them, so there is nothing to
// flush: the context is already past its deadline, errors are dropped, and
// a panic from the part is recovered.
func (s *SDK) stopInjectedNow(ctx context.Context, signal string) {
	ctx, cancel := context.WithDeadline(context.WithoutCancel(ctx), time.Unix(0, 0))
	defer cancel()
	for _, p := range s.injected {
		if p.signal == signal {
			stopQuietly(ctx, p.stop)
		}
	}
}

// discardInjected stops every part s injects, for a call that returns
// before an SDK exists to own them: each exactly once, with a context that
// is already past its deadline so nothing waits on the network, and with a
// panic from a part recovered.
func discardInjected(ctx context.Context, s *settings) {
	sdk := &SDK{injected: injectedParts(s)}
	sdk.stopInjectedNow(ctx, "traces")
	sdk.stopInjectedNow(ctx, "logs")
	sdk.stopInjectedNow(ctx, "metrics")
}
