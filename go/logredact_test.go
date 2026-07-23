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
	h := classifyingHandler(inner, sinkOTLP, PIIDrop, nil)
	rec := slog.NewRecord(time.Now(), slog.LevelInfo, "m", 0)
	rec.AddAttrs(slog.String("host.ip", "10.0.0.1")) // PII
	if err := h.Handle(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "10.0.0.1") {
		t.Fatalf("PII reached the sink: %s", buf.String())
	}
}
