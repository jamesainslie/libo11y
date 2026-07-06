package o11y

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestRateLimitedErrorHandlerBurstThenSuppress(t *testing.T) {
	var buf bytes.Buffer
	handler := newRateLimitedErrorHandler(slog.New(slog.NewTextHandler(&buf, nil)))

	for range errorBurst + 3 {
		handler(errors.New("exporter unreachable"))
	}

	got := strings.Count(buf.String(), "telemetry error")
	if got != errorBurst {
		t.Errorf("logged %d errors, want burst of %d then suppression", got, errorBurst)
	}
}

func TestRateLimitedErrorHandlerIgnoresNil(t *testing.T) {
	var buf bytes.Buffer
	handler := newRateLimitedErrorHandler(slog.New(slog.NewTextHandler(&buf, nil)))
	handler(nil)
	if buf.Len() != 0 {
		t.Errorf("nil error produced output: %s", buf.String())
	}
}
