package o11y

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestClassifyingHandlerDropsSecretPerLeg(t *testing.T) {
	var buf bytes.Buffer
	inner := slog.NewJSONHandler(&buf, nil)
	h := classifyingHandler(inner, sinkOTLP, dropPolicy())
	rec := slog.NewRecord(time.Now(), slog.LevelInfo, "m", 0)
	rec.AddAttrs(slog.String("host.ip", "10.0.0.1")) // PII
	if err := h.Handle(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "10.0.0.1") {
		t.Fatalf("PII reached the sink: %s", buf.String())
	}
}

func TestClassifierWithGroupClassifiesEffectiveKey(t *testing.T) {
	var buf bytes.Buffer
	h := classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, dropPolicy())
	slog.New(h.WithGroup("host")).Info("m", "ip", "10.0.0.1")
	if strings.Contains(buf.String(), "10.0.0.1") {
		t.Fatalf("grouped PII leaked through WithGroup: %s", buf.String())
	}
}

func TestClassifierWithAttrsClassifies(t *testing.T) {
	var buf bytes.Buffer
	h := classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, dropPolicy())
	slog.New(h.WithAttrs([]slog.Attr{slog.String("host.ip", "10.0.0.1")})).Info("m")
	if strings.Contains(buf.String(), "10.0.0.1") {
		t.Fatalf("PII leaked through WithAttrs: %s", buf.String())
	}
}

func TestClassifierUncomparableValueDoesNotPanic(t *testing.T) {
	var buf bytes.Buffer
	h := classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, dropPolicy())
	slog.New(h).Info("m", "v", []string{"value"}, "w", map[string]int{"n": 1})
	if !strings.Contains(buf.String(), `["value"]`) {
		t.Fatalf("value not serialized: %s", buf.String())
	}
}

// dropPolicy is a PIIDrop policy with no violation recorder, built from
// the generated classification table.
func dropPolicy() *sensitivityPolicy {
	return newSensitivityPolicy(newSettings([]Option{WithPIIMode(PIIDrop)}), nil)
}
