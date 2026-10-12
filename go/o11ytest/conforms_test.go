package o11ytest_test

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11ytest"
	"github.com/jamesainslie/libo11y/go/spec"
)

// recordingTB captures Errorf calls so AssertConforms failures can be asserted.
type recordingTB struct {
	testing.TB
	mu     sync.Mutex
	errors []string
}

func (r *recordingTB) Helper()             {}
func (r *recordingTB) Logf(string, ...any) {}
func (r *recordingTB) Errorf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.errors = append(r.errors, fmt.Sprintf(format, args...))
}

func TestAssertConformsPassesCleanService(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t)
	ctx := context.Background()
	rec.SDK.Logger().InfoContext(ctx, "ok", "safe", "v")
	rec.SDK.Event(ctx, spec.EventRequestSummary,
		slog.String("http.request.method", "GET"), slog.Int("http.response.status_code", 200),
		slog.String(string(spec.OutcomeKey), string(spec.OutcomeSuccess)), slog.Float64(string(spec.DurationKey), 0.01))
	tb := &recordingTB{TB: t}
	rec.AssertConforms(tb)
	if len(tb.errors) != 0 {
		t.Errorf("clean service reported: %v", tb.errors)
	}
}

func TestAssertConformsCatchesServiceViolations(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		emit func(*o11ytest.Recorder)
		want string
	}{
		"secret in a log": {func(r *o11ytest.Recorder) {
			r.SDK.Logger().Info("m", "http.request.header.authorization", "Bearer x")
		}, "emitted secret-classified"},
		"secret on a span": {func(r *o11ytest.Recorder) {
			_, span := r.SDK.TracerProvider().Tracer("t").Start(context.Background(), "op",
				trace.WithAttributes(attribute.String("http.request.header.cookie", "c")))
			span.End()
		}, "emitted secret-classified"},
		"event missing its contract": {func(r *o11ytest.Recorder) {
			r.SDK.Event(context.Background(), spec.EventTelemetryConfigured)
		}, "o11y.config"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			rec := o11ytest.Start(t)
			tc.emit(rec)
			tb := &recordingTB{TB: t}
			rec.AssertConforms(tb)
			joined := strings.Join(tb.errors, "\n")
			if !strings.Contains(joined, tc.want) {
				t.Errorf("AssertConforms did not report %q; got %q", tc.want, joined)
			}
		})
	}
}
