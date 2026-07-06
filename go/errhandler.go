package o11y

import (
	"log/slog"
	"os"
	"sync"
	"time"
)

// errorBurst and errorRefill shape the default error handler's rate limit:
// a burst of errorBurst reports, refilling one report per errorRefill.
const (
	errorBurst  = 5
	errorRefill = 30 * time.Second
)

// newRateLimitedErrorHandler returns the default [ErrorHandler]: it logs
// asynchronous telemetry errors at Warn level, rate limited so a flapping
// exporter cannot flood the process's output. Errors are reported to logger,
// or to a plain text stderr logger when logger is nil. The handler must not
// feed back into the OTLP pipeline, or a failing exporter would recurse.
func newRateLimitedErrorHandler(logger *slog.Logger) ErrorHandler {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	limiter := &rateLimiter{tokens: errorBurst, last: time.Now()}
	return func(err error) {
		if err == nil {
			return
		}
		if suppressed := limiter.take(); suppressed > 0 {
			logger.Warn("o11y: telemetry error", "error", err, "suppressed", suppressed)
		} else if suppressed == 0 {
			logger.Warn("o11y: telemetry error", "error", err)
		}
	}
}

// rateLimiter is a minimal token bucket. take reports -1 when the call is
// suppressed, otherwise the number of calls suppressed since the last
// permitted one.
type rateLimiter struct {
	mu         sync.Mutex
	tokens     float64
	last       time.Time
	suppressed int
}

func (r *rateLimiter) take() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	r.tokens += now.Sub(r.last).Seconds() / errorRefill.Seconds()
	if r.tokens > errorBurst {
		r.tokens = errorBurst
	}
	r.last = now

	if r.tokens < 1 {
		r.suppressed++
		return -1
	}
	r.tokens--
	count := r.suppressed
	r.suppressed = 0
	return count
}
