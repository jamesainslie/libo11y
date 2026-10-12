package o11y_test

import (
	"context"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"

	o11y "github.com/jamesainslie/libo11y/go"
)

func TestWithLogExporterReceivesSlogRecords(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp))

	sdk.Logger().Info("hello", "k", "v")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}

	recs := exp.snapshot()
	if len(recs) != 1 {
		t.Fatalf("exported %d records, want 1", len(recs))
	}
	if got := recs[0].Body().AsString(); got != "hello" {
		t.Errorf("body = %q, want hello", got)
	}
	if got := logAttrs(recs[0])["k"]; got != "v" {
		t.Errorf("attr k = %q, want v", got)
	}
}

func TestLoggerProviderAccessorExports(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp))

	var r log.Record
	r.SetBody(attribute.StringValue("bridged"))
	sdk.LoggerProvider().Logger("third-party").Emit(context.Background(), r)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 || recs[0].Body().AsString() != "bridged" {
		t.Fatalf("bridged record not exported: %+v", recs)
	}
}

func TestLoggerProviderNoopWithoutLogExport(t *testing.T) {
	t.Parallel()
	sdk, _, _, _ := newHermetic(t) // newHermetic passes WithoutLogExport
	if sdk.LoggerProvider() == nil {
		t.Fatal("LoggerProvider returned nil; want a no-op provider")
	}
	sdk.LoggerProvider().Logger("x").Emit(context.Background(), log.Record{}) // must not panic
}

func TestEffectiveConfigReportsInjectedLogExporter(t *testing.T) {
	t.Parallel()
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(&memLogExporter{}))
	if want := "o11y.config.logs=injected"; !strings.Contains(sdk.EffectiveConfig(), want) {
		t.Errorf("EffectiveConfig %q missing %q", sdk.EffectiveConfig(), want)
	}
}
