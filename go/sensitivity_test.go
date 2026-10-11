package o11y_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// The forbidden PII attributes (host.ip, device.id, ...) are classified pii
// by the spec, so they are dropped by default (PIIDrop) and tokenized under
// PIIHash with a key. TestPIIAttributesDroppedByDefault is in
// piihash_test.go.

func TestPIIModeHashLeavesOtherAttributes(t *testing.T) {
	sdk, _, _, console := newHermetic(t, o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	sdk.Logger().Info("event", "host.ip", "10.1.2.3", "ok", "yes")

	records := consoleRecords(t, console)
	if got := records[0]["host.ip"]; got == "10.1.2.3" {
		t.Error("PII attribute host.ip emitted in the clear")
	}
	if got, _ := records[0]["host.ip"].(string); !strings.HasPrefix(got, "hmac-sha256:") {
		t.Errorf("host.ip = %v, want an hmac-sha256 token", records[0]["host.ip"])
	}
	if records[0]["ok"] != "yes" {
		t.Error("unrelated attribute altered")
	}
}

func TestPIIModeDrop(t *testing.T) {
	sdk, _, _, console := newHermetic(t, o11y.WithPIIMode(o11y.PIIDrop))
	sdk.Logger().Info("event", "device.id", "device-xyz")

	records := consoleRecords(t, console)
	if _, present := records[0]["device.id"]; present {
		t.Error("PII attribute present under PIIDrop")
	}
}

func TestPIIModeAllow(t *testing.T) {
	sdk, _, _, console := newHermetic(t, o11y.WithPIIMode(o11y.PIIAllow))
	sdk.Logger().Info("event", "host.ip", "10.1.2.3")

	records := consoleRecords(t, console)
	if got := records[0]["host.ip"]; got != "10.1.2.3" {
		t.Errorf("host.ip = %v, want 10.1.2.3 under explicit PIIAllow", got)
	}
}

func TestSpecReplacerRunsAfterUserReplacer(t *testing.T) {
	// A user replacer renames a benign key to a PII-classified one; the
	// spec layer must still catch it (cannot be bypassed by renaming).
	sdk, _, _, console := newHermetic(t, o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey), o11y.WithAttrReplacer(
		func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == "addr" {
				a.Key = "host.ip"
			}
			return a
		},
	))
	sdk.Logger().Info("event", "addr", "10.9.9.9")

	records := consoleRecords(t, console)
	if got, _ := records[0]["host.ip"].(string); !strings.HasPrefix(got, "hmac-sha256:") {
		t.Errorf("renamed-to-PII attribute not caught by spec layer: %v", records[0]["host.ip"])
	}
}

func TestViolationsSelfMetric(t *testing.T) {
	sdk, _, reader, _ := newHermetic(t)
	sdk.Logger().Info("event", "host.ip", "10.1.2.3")

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	var found bool
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name == "o11y.schema.violations" {
				found = true
			}
		}
	}
	if !found {
		t.Error("o11y.schema.violations not recorded for a PII attribute")
	}
}

func TestEventEmitsWithName(t *testing.T) {
	sdk, _, _, console := newHermetic(t)
	sdk.Event(context.Background(), spec.EventRequestSummary,
		slog.String("http.request.method", "GET"),
	)

	records := consoleRecords(t, console)
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1", len(records))
	}
	if got := records[0]["event.name"]; got != "o11y.request.summary" {
		t.Errorf("event.name = %v, want o11y.request.summary", got)
	}
	if got := records[0]["msg"]; got != "o11y.request.summary" {
		t.Errorf("msg = %v, want the event name", got)
	}
}

func TestEventBypassesLevelGate(t *testing.T) {
	sdk, _, _, console := newHermetic(t, o11y.WithLogLevel(slog.LevelError))
	sdk.Event(context.Background(), spec.EventTelemetryDropped,
		slog.String(string(spec.SignalKey), string(spec.SignalLogs)),
	)

	records := consoleRecords(t, console)
	if len(records) != 1 {
		t.Fatalf("event did not bypass the level gate: got %d records", len(records))
	}
}
