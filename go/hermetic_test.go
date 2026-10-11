package o11y_test

import (
	"context"
	"strings"
	"testing"

	sdklog "go.opentelemetry.io/otel/sdk/log"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

func TestWithoutOTELEnvBuildsNoEnvExporters(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1") // nothing listens
	t.Setenv("OTEL_SERVICE_NAME", "ambient")
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cfg := sdk.EffectiveConfig()
	for _, leak := range []string{"127.0.0.1:1", "ambient"} {
		if strings.Contains(cfg, leak) {
			t.Errorf("EffectiveConfig %q leaked ambient %q", cfg, leak)
		}
	}
	for _, want := range []string{"traces=none", "metrics=none", "logs=none"} {
		if !strings.Contains(cfg, want) {
			t.Errorf("EffectiveConfig %q does not report %q for a signal with no injected exporter", cfg, want)
		}
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown with no exporters: %v", err)
	}
}

func TestWithoutOTELEnvDisablesLogExportWithoutExporter(t *testing.T) {
	t.Setenv("OTEL_LOGS_EXPORTER", "console")
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if _, ok := sdk.LoggerProvider().(*sdklog.LoggerProvider); ok {
		t.Error("LoggerProvider is an SDK provider; want the no-op provider when no log exporter is injected")
	}
}

// The log provider merges the environment resource underneath the one it is
// given; ambient keys must be shadowed so none reaches an exported record.
func TestWithoutOTELEnvShadowsAmbientResourceOnLogs(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "team=ambient-team,host.name=ambient-host")
	exp := &memLogExporter{}
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(exp))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })

	sdk.Logger().Info("hello")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 {
		t.Fatalf("exported %d records, want 1", len(recs))
	}
	for _, kv := range recs[0].Resource().Attributes() {
		if v := kv.Value.String(); v == "ambient-team" || v == "ambient-host" {
			t.Errorf("log record resource carries ambient %s=%q from OTEL_RESOURCE_ATTRIBUTES", kv.Key, v)
		}
	}
	for _, kv := range sdk.Resource().Attributes() {
		if v := kv.Value.String(); v == "ambient-team" || v == "ambient-host" {
			t.Errorf("SDK resource carries ambient %s=%q", kv.Key, v)
		}
	}
}

func TestWithoutOTELEnvPinsLogRecordLimits(t *testing.T) {
	t.Setenv("OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "1")
	t.Setenv("OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT", "1")
	exp := &memLogExporter{}
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("hermetic"), o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
		o11y.WithLogExporter(exp))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if want := "logs=injected"; !strings.Contains(sdk.EffectiveConfig(), want) {
		t.Errorf("EffectiveConfig %q missing %q", sdk.EffectiveConfig(), want)
	}

	sdk.Logger().Info("hello", "first", "alpha", "second", "beta")
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 {
		t.Fatalf("exported %d records, want 1", len(recs))
	}
	attrs := logAttrs(recs[0])
	if attrs["first"] != "alpha" || attrs["second"] != "beta" {
		t.Errorf("record attributes %v truncated: ambient OTEL_LOGRECORD_* limits leaked in", attrs)
	}
}
