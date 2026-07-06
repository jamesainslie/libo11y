package fanout_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"testing/slogtest"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/internal/fanout"
)

func parseJSONLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var records []map[string]any
	for line := range strings.Lines(buf.String()) {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("unmarshal log line %q: %v", line, err)
		}
		records = append(records, m)
	}
	return records
}

// TestHandlerContract verifies the full slog.Handler contract via the
// standard library's slogtest suite, with a JSON sink observing the output.
func TestHandlerContract(t *testing.T) {
	var buf bytes.Buffer
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{slog.NewJSONHandler(&buf, &slog.HandlerOptions{
			Level: slog.LevelDebug,
		})},
		Level: slog.LevelDebug,
	})
	err := slogtest.TestHandler(handler, func() []map[string]any {
		return parseJSONLines(t, &buf)
	})
	if err != nil {
		t.Error(err)
	}
}

// TestHandlerContractWithReplacer verifies the contract holds when a
// passthrough replacer is installed (the replacer path rewrites records).
func TestHandlerContractWithReplacer(t *testing.T) {
	var buf bytes.Buffer
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{slog.NewJSONHandler(&buf, &slog.HandlerOptions{
			Level: slog.LevelDebug,
		})},
		Level: slog.LevelDebug,
		Replace: func(_ []string, attr slog.Attr) slog.Attr {
			return attr
		},
	})
	err := slogtest.TestHandler(handler, func() []map[string]any {
		return parseJSONLines(t, &buf)
	})
	if err != nil {
		t.Error(err)
	}
}

func spanContext(t *testing.T) trace.SpanContext {
	t.Helper()
	traceID, err := trace.TraceIDFromHex("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	spanID, err := trace.SpanIDFromHex("0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	return trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
}

func TestCorrelationAttributesTopLevel(t *testing.T) {
	var buf bytes.Buffer
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{fanout.Correlate(slog.NewJSONHandler(&buf, nil))},
	})
	ctx := trace.ContextWithSpanContext(context.Background(), spanContext(t))

	// Even inside an open group, correlation must stay top-level.
	logger := slog.New(handler).WithGroup("request").With("path", "/checkout")
	logger.InfoContext(ctx, "handled")

	records := parseJSONLines(t, &buf)
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1", len(records))
	}
	record := records[0]
	if got, want := record["trace_id"], "0123456789abcdef0123456789abcdef"; got != want {
		t.Errorf("trace_id = %v, want %v", got, want)
	}
	if got, want := record["span_id"], "0123456789abcdef"; got != want {
		t.Errorf("span_id = %v, want %v", got, want)
	}
	group, ok := record["request"].(map[string]any)
	if !ok {
		t.Fatalf("request group missing: %v", record)
	}
	if got, want := group["path"], "/checkout"; got != want {
		t.Errorf("request.path = %v, want %v", got, want)
	}
	if _, inGroup := group["trace_id"]; inGroup {
		t.Error("trace_id must not nest inside open groups")
	}
}

func TestNoCorrelationWithoutSpan(t *testing.T) {
	var buf bytes.Buffer
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{fanout.Correlate(slog.NewJSONHandler(&buf, nil))},
	})
	slog.New(handler).Info("plain")

	records := parseJSONLines(t, &buf)
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1", len(records))
	}
	if _, present := records[0]["trace_id"]; present {
		t.Error("trace_id present without a span in context")
	}
}

func TestReplacerAppliesToAllLegs(t *testing.T) {
	var first, second bytes.Buffer
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{
			slog.NewJSONHandler(&first, nil),
			slog.NewJSONHandler(&second, nil),
		},
		Replace: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == "ssn" {
				return slog.String("ssn", "REDACTED")
			}
			return attr
		},
	})
	slog.New(handler).Info("event", "ssn", "123-45-6789", "ok", "yes")

	for name, buf := range map[string]*bytes.Buffer{"first": &first, "second": &second} {
		records := parseJSONLines(t, buf)
		if len(records) != 1 {
			t.Fatalf("%s: got %d records, want 1", name, len(records))
		}
		if got, want := records[0]["ssn"], "REDACTED"; got != want {
			t.Errorf("%s: ssn = %v, want %v", name, got, want)
		}
		if got, want := records[0]["ok"], "yes"; got != want {
			t.Errorf("%s: ok = %v, want %v", name, got, want)
		}
	}
}

func TestReplacerReceivesGroupPath(t *testing.T) {
	var buf bytes.Buffer
	var seen [][]string
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{slog.NewJSONHandler(&buf, nil)},
		Replace: func(groups []string, attr slog.Attr) slog.Attr {
			seen = append(seen, groups)
			return attr
		},
	})
	slog.New(handler).WithGroup("outer").Info("event", slog.Group("inner", "leaf", 1))

	want := [][]string{{"outer", "inner"}}
	if len(seen) != 1 || len(seen[0]) != 2 || seen[0][0] != "outer" || seen[0][1] != "inner" {
		t.Errorf("replacer group paths = %v, want %v", seen, want)
	}
}

func TestReplacerCanDropAttributes(t *testing.T) {
	var buf bytes.Buffer
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{slog.NewJSONHandler(&buf, nil)},
		Replace: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == "secret" {
				return slog.Attr{}
			}
			return attr
		},
	})
	slog.New(handler).Info("event", "secret", "hidden", "kept", true)

	records := parseJSONLines(t, &buf)
	if _, present := records[0]["secret"]; present {
		t.Error("dropped attribute still present")
	}
	if _, present := records[0]["kept"]; !present {
		t.Error("unrelated attribute lost")
	}
}

func TestReplacerNotCalledForCorrelation(t *testing.T) {
	var buf bytes.Buffer
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{fanout.Correlate(slog.NewJSONHandler(&buf, nil))},
		Replace: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == fanout.TraceIDKey || attr.Key == fanout.SpanIDKey {
				t.Errorf("replacer called for correlation attribute %q", attr.Key)
			}
			return attr
		},
	})
	ctx := trace.ContextWithSpanContext(context.Background(), spanContext(t))
	slog.New(handler).InfoContext(ctx, "event", "key", "value")

	records := parseJSONLines(t, &buf)
	if _, present := records[0]["trace_id"]; !present {
		t.Error("correlation attribute missing")
	}
}

func TestLevelGate(t *testing.T) {
	var buf bytes.Buffer
	level := new(slog.LevelVar)
	level.Set(slog.LevelWarn)
	handler := fanout.New(fanout.Config{
		Legs:  []slog.Handler{slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})},
		Level: level,
	})
	logger := slog.New(handler)
	logger.Info("filtered")
	logger.Warn("emitted")

	records := parseJSONLines(t, &buf)
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1", len(records))
	}
	if got, want := records[0]["msg"], "emitted"; got != want {
		t.Errorf("msg = %v, want %v", got, want)
	}

	// Runtime level change through the LevelVar takes effect immediately.
	level.Set(slog.LevelDebug)
	logger.Debug("now visible")
	if got := len(parseJSONLines(t, &buf)); got != 2 {
		t.Errorf("after lowering level got %d records, want 2", got)
	}
}

type failingHandler struct{ err error }

func (f failingHandler) Enabled(context.Context, slog.Level) bool  { return true }
func (f failingHandler) Handle(context.Context, slog.Record) error { return f.err }
func (f failingHandler) WithAttrs([]slog.Attr) slog.Handler        { return f }
func (f failingHandler) WithGroup(string) slog.Handler             { return f }

func TestLegErrorsJoined(t *testing.T) {
	var buf bytes.Buffer
	sinkErr := errors.New("sink exploded")
	handler := fanout.New(fanout.Config{
		Legs: []slog.Handler{
			failingHandler{err: sinkErr},
			slog.NewJSONHandler(&buf, nil),
		},
	})
	err := handler.Handle(context.Background(), slog.NewRecord(time.Time{}, slog.LevelInfo, "event", 0))
	if !errors.Is(err, sinkErr) {
		t.Errorf("Handle error = %v, want wrapped %v", err, sinkErr)
	}
	// The healthy leg must still have received the record.
	if got := len(parseJSONLines(t, &buf)); got != 1 {
		t.Errorf("healthy leg got %d records, want 1", got)
	}
}
