package o11ytest

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"
)

// errorsTB captures Errorf calls so AssertConforms failures can be asserted.
type errorsTB struct {
	testing.TB
	mu     sync.Mutex
	errors []string
}

func (e *errorsTB) Helper() {}
func (e *errorsTB) Errorf(format string, args ...any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.errors = append(e.errors, fmt.Sprintf(format, args...))
}

// TestAssertConformsScansGroupedLogAttributes plants a record that bypassed
// redaction, standing in for a redaction regression, with the secret nested
// in a group. The clear-text scan must read the dotted key, as the
// library's classification does, rather than only the top-level group name.
func TestAssertConformsScansGroupedLogAttributes(t *testing.T) {
	rec := Start(t)
	record := slog.NewRecord(time.Now(), slog.LevelInfo, "planted", 0)
	record.AddAttrs(slog.Group("http", slog.Group("request.header", slog.String("authorization", "Bearer x"))))
	rec.logs.records = append(rec.logs.records, LogRecord{Record: record})

	tb := &errorsTB{TB: t}
	rec.AssertConforms(tb)
	joined := strings.Join(tb.errors, "\n")
	if want := `"http.request.header.authorization" in the clear`; !strings.Contains(joined, want) {
		t.Errorf("AssertConforms did not report %q; got %q", want, joined)
	}
}

func TestAssertCorrelatedChecksSpanID(t *testing.T) {
	traceID, err := trace.TraceIDFromHex("0af7651916cd43dd8448eb211c80319c")
	if err != nil {
		t.Fatal(err)
	}
	spanID, err := trace.SpanIDFromHex("b7ad6b7169203331")
	if err != nil {
		t.Fatal(err)
	}
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})

	cases := []struct {
		name  string
		attrs []slog.Attr
		want  string
	}{
		{
			name:  "missing span_id",
			attrs: []slog.Attr{slog.String("trace_id", traceID.String())},
			want:  "no span_id attribute",
		},
		{
			name: "mismatched span_id",
			attrs: []slog.Attr{
				slog.String("trace_id", traceID.String()),
				slog.String("span_id", "0000000000000001"),
			},
			want: `span_id "0000000000000001" does not match its span`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rec := Start(t)
			record := slog.NewRecord(time.Now(), slog.LevelInfo, "planted", 0)
			record.AddAttrs(tc.attrs...)
			rec.logs.records = append(rec.logs.records, LogRecord{Record: record, SpanContext: sc})

			tb := &errorsTB{TB: t}
			rec.AssertCorrelated(tb)
			if len(tb.errors) != 1 {
				t.Fatalf("got %d errors %v, want 1", len(tb.errors), tb.errors)
			}
			if !strings.Contains(tb.errors[0], tc.want) {
				t.Errorf("AssertCorrelated reported %q, want %q", tb.errors[0], tc.want)
			}
		})
	}
}
