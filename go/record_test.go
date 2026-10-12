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

func TestEventAttributesAreDeduplicated(t *testing.T) {
	t.Parallel()
	extra, captured := newSlogCapture()
	sdk, _, _, _ := newHermetic(t, o11y.WithExtraLogHandler(extra))
	ctx, rec := o11y.StartRecord(context.Background())
	rec.Set(slog.Int("http.response.status_code", 200))
	rec.EmitEvent(ctx, sdk, spec.EventRequestSummary,
		slog.Int("http.response.status_code", 500), slog.String(spec.EventNameKey, "spoofed"))
	r := captured()[0]
	counts := map[string]int{}
	var status int64
	var name string
	r.Attrs(func(a slog.Attr) bool {
		counts[a.Key]++
		switch a.Key {
		case "http.response.status_code":
			status = a.Value.Int64()
		case spec.EventNameKey:
			name = a.Value.String()
		}
		return true
	})
	if counts["http.response.status_code"] != 1 || status != 500 {
		t.Errorf("status appears %d times, value %d; want once, 500", counts["http.response.status_code"], status)
	}
	if counts[spec.EventNameKey] != 1 || name != spec.EventRequestSummary {
		t.Errorf("event.name appears %d times as %q; want once as %s", counts[spec.EventNameKey], name, spec.EventRequestSummary)
	}
}
