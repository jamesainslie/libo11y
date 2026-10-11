package o11y_test

import (
	"context"
	"log/slog"
	"net"
	"strings"
	"testing"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

func TestBridgeOnLoggerProviderIsClassified(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp), o11y.WithSensitivityForTest(secretTable))
	third := otelslog.NewLogger("thirdparty", otelslog.WithLoggerProvider(sdk.LoggerProvider()))
	third.Info("m", "host.ip", "10.1.1.1", "test.secret", "s3",
		slog.Group("host", slog.String("mac", "aa:bb:cc:dd:ee:ff")), "safe", "ok")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 {
		t.Fatalf("got %d records", len(recs))
	}
	attrs := logAttrs(recs[0])
	for _, k := range []string{"host.ip", "test.secret", "host.mac"} {
		if _, leaked := attrs[k]; leaked {
			t.Errorf("bridge record leaked %s: %v", k, attrs)
		}
	}
	if attrs["safe"] != "ok" {
		t.Errorf("unclassified attribute lost: %v", attrs)
	}
}

// Each classified attribute is counted once per sink on the logs signal: a
// bridge record by the processor, an own slog record by its OTLP leg's
// classifier and not again by the processor. The console is off here, so the
// OTLP leg is the only sink.
func TestLogProcessorCountsViolationsOnce(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, reader, _ := newHermetic(t, o11y.WithLogExporter(exp), o11y.WithoutConsoleLog(),
		o11y.WithSensitivityForTest(secretTable))
	third := otelslog.NewLogger("thirdparty", otelslog.WithLoggerProvider(sdk.LoggerProvider()))
	third.Info("bridged", "host.ip", "10.1.1.1", "test.secret", "s3")
	sdk.Logger().Info("own", "host.ip", "10.1.1.1")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	var md metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &md); err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, sm := range md.ScopeMetrics {
		for _, m := range sm.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if m.Name != "o11y.schema.violations" || !ok {
				continue
			}
			for _, p := range sum.DataPoints {
				if signal, _ := p.Attributes.Value(spec.SignalKey); signal.AsString() == string(spec.SignalLogs) {
					rule, _ := p.Attributes.Value(spec.RuleKey)
					got[rule.AsString()] += p.Value
				}
			}
		}
	}
	if got["pii_attribute"] != 2 || got["secret_attribute"] != 1 {
		t.Errorf("logs violations = %v, want pii_attribute 2 and secret_attribute 1", got)
	}
}

// A bridge converts a Go map to a map value. Under a classified key the
// whole value is judged, so its members cannot escape under keys of their own.
func TestBridgeMapUnderClassifiedKeyIsDropped(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp))
	third := otelslog.NewLogger("thirdparty", otelslog.WithLoggerProvider(sdk.LoggerProvider()))
	third.Info("m", slog.Any("host.ip", map[string]string{"v4": "10.1.1.1"}), "safe", "ok")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	attrs := logAttrs(exp.snapshot()[0])
	for k, v := range attrs {
		if strings.HasPrefix(k, "host.ip") || v == "10.1.1.1" {
			t.Errorf("map under a classified key leaked %s=%s", k, v)
		}
	}
	if attrs["safe"] != "ok" {
		t.Errorf("unclassified attribute lost: %v", attrs)
	}
}

// Maps inside a slice are judged on their holder's key, as zap.Objects and
// similar bridge encodings produce them, and an emptied element is removed.
func TestBridgeSliceOfMapsIsClassified(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp))
	logger := sdk.LoggerProvider().Logger("thirdparty")
	var rec log.Record
	rec.SetBody(attribute.StringValue("m"))
	rec.AddAttributes(attribute.KeyValue{Key: "host", Value: attribute.SliceValue(
		attribute.MapValue(attribute.String("ip", "10.1.1.1"), attribute.String("name", "web-1")),
		attribute.MapValue(attribute.String("ip", "10.1.1.2")),
	)})
	logger.Emit(context.Background(), rec)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := exp.snapshot()[0]
	var host attribute.Value
	got.WalkAttributes(func(kv attribute.KeyValue) bool {
		if kv.Key == "host" {
			host = kv.Value
		}
		return true
	})
	if host.Type() != attribute.SLICE {
		t.Fatalf("host = %v, want a slice", host)
	}
	if s := host.String(); strings.Contains(s, "10.1.1.") || !strings.Contains(s, "web-1") {
		t.Errorf("host = %s, want the ips removed and the name kept", s)
	}
	if n := len(host.AsSlice()); n != 1 {
		t.Errorf("host has %d elements, want 1 (the emptied map removed)", n)
	}
}

// Under PIIHash a bridge record carries the same token the slog pipeline
// produces for the same value, including inside a group, and a group whose
// members are all kept is forwarded intact.
func TestBridgeOnLoggerProviderTokenizesPII(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(exp),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	sdk.Logger().Info("own", slog.Group("host", slog.String("mac", "aa:bb:cc:dd:ee:ff")))
	third := otelslog.NewLogger("thirdparty", otelslog.WithLoggerProvider(sdk.LoggerProvider()))
	third.Info("bridged", slog.Group("host", slog.String("mac", "aa:bb:cc:dd:ee:ff"), slog.String("name", "web-1")),
		slog.Group("http", slog.String("route", "/x")))
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	host, _ := consoleRecords(t, console)[0]["host"].(map[string]any)
	consoleToken, _ := host["mac"].(string)
	if !strings.HasPrefix(consoleToken, "hmac-sha256:") {
		t.Fatalf("console host.mac = %q, want a token", consoleToken)
	}
	recs := exp.snapshot()
	if len(recs) != 2 {
		t.Fatalf("got %d records", len(recs))
	}
	attrs := logAttrs(recs[1])
	if attrs["host.mac"] != consoleToken {
		t.Errorf("bridge host.mac = %q, want the slog token %q", attrs["host.mac"], consoleToken)
	}
	if attrs["host.name"] != "web-1" || attrs["http.route"] != "/x" {
		t.Errorf("unclassified grouped attributes lost: %v", attrs)
	}
}

func TestOTLPLegHashesOnce(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(exp),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	sdk.Logger().Info("m", "host.ip", "10.9.8.7")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	consoleToken, _ := consoleRecords(t, console)[0]["host.ip"].(string)
	otlpToken := logAttrs(exp.snapshot()[0])["host.ip"]
	if otlpToken != consoleToken {
		t.Errorf("OTLP token %q != console token %q (double hashing?)", otlpToken, consoleToken)
	}
}

// The SDK's own slog leg is classified on slog values, before the bridge
// converts them, so a value with a text form (net.IP) tokenizes on OTLP
// exactly as on the console. Converted to an OTel value it would be a list of
// byte values and hash differently.
func TestOTLPLegTokenMatchesConsoleForTextValues(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(exp),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	sdk.Logger().Info("m", "host.ip", net.ParseIP("10.9.8.7"))
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	consoleToken, _ := consoleRecords(t, console)[0]["host.ip"].(string)
	otlpToken := logAttrs(exp.snapshot()[0])["host.ip"]
	if !strings.HasPrefix(consoleToken, "hmac-sha256:") || otlpToken != consoleToken {
		t.Errorf("OTLP token %q != console token %q", otlpToken, consoleToken)
	}
}
