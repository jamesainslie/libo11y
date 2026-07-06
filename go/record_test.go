package o11y_test

import (
	"context"
	"log/slog"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

func TestRecordAccumulatesAndEmits(t *testing.T) {
	sdk, _, _, console := newHermetic(t)

	ctx, record := o11y.StartRecord(context.Background())
	record.Set(slog.String("user.tier", "gold"))
	record.Add("queries", 1)
	record.Add("queries", 2)
	record.Max("slowest_ms", 12)
	record.Max("slowest_ms", 8) // smaller, ignored
	record.EmitEvent(ctx, sdk, spec.EventRequestSummary, slog.String("http.request.method", "GET"))

	records := consoleRecords(t, console)
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1", len(records))
	}
	r := records[0]
	if r["event.name"] != "o11y.request.summary" {
		t.Errorf("event.name = %v", r["event.name"])
	}
	if r["user.tier"] != "gold" {
		t.Errorf("user.tier = %v, want gold", r["user.tier"])
	}
	if r["queries"] != float64(3) {
		t.Errorf("queries = %v, want 3", r["queries"])
	}
	if r["slowest_ms"] != float64(12) {
		t.Errorf("slowest_ms = %v, want 12 (max)", r["slowest_ms"])
	}
	if r["http.request.method"] != "GET" {
		t.Errorf("http.request.method = %v, want GET", r["http.request.method"])
	}
}

func TestRecordFromContextNoOpWhenAbsent(t *testing.T) {
	// Must not panic and must be usable when no record is attached.
	record := o11y.RecordFromContext(context.Background())
	record.Set(slog.String("k", "v"))
	record.Add("n", 1)
}
