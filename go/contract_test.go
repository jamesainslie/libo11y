package o11y_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
)

// TestEnvResourceAttributesOverrideDetectors pins the documented precedence
// contract: OTEL_RESOURCE_ATTRIBUTES (environment) must override detector
// values (library defaults) for the same key.
func TestEnvResourceAttributesOverrideDetectors(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "host.name=env-host,process.runtime.name=env-runtime")
	sdk, _, _, _ := newHermetic(t)

	got := map[string]string{}
	for _, kv := range sdk.Resource().Attributes() {
		got[string(kv.Key)] = kv.Value.AsString()
	}
	if got["host.name"] != "env-host" {
		t.Errorf("host.name = %q, want env-host (env must beat detector)", got["host.name"])
	}
	if got["process.runtime.name"] != "env-runtime" {
		t.Errorf("process.runtime.name = %q, want env-runtime (env must beat detector)", got["process.runtime.name"])
	}
}

// TestServiceNameRejectsDegenerateForms pins the refuse-unknown_service
// guarantee against whitespace and the SDK fallback shapes on every channel.
func TestServiceNameRejectsDegenerateForms(t *testing.T) {
	baseOpts := func() []o11y.Option {
		return hermeticOptions("placeholder")[1:] // drop WithServiceName
	}

	t.Run("whitespace option", func(t *testing.T) {
		opts := append(baseOpts(), o11y.WithServiceName("   "))
		if _, err := o11y.New(context.Background(), opts...); !errors.Is(err, o11y.ErrNoServiceName) {
			t.Errorf("whitespace name: err = %v, want ErrNoServiceName", err)
		}
	})
	t.Run("unknown_service env", func(t *testing.T) {
		t.Setenv("OTEL_SERVICE_NAME", "unknown_service")
		if _, err := o11y.New(context.Background(), baseOpts()...); !errors.Is(err, o11y.ErrNoServiceName) {
			t.Errorf("unknown_service: err = %v, want ErrNoServiceName", err)
		}
	})
	t.Run("unknown_service prefix via resource attrs", func(t *testing.T) {
		t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "service.name=unknown_service:bash")
		if _, err := o11y.New(context.Background(), baseOpts()...); !errors.Is(err, o11y.ErrNoServiceName) {
			t.Errorf("unknown_service:bash: err = %v, want ErrNoServiceName", err)
		}
	})
}

// TestEffectiveConfigReportsSamplerFallback pins that the summary reports
// the sampler actually in effect when OTEL_TRACES_SAMPLER is invalid.
func TestEffectiveConfigReportsSamplerFallback(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "bogus_sampler_name")
	sdk, _, _, _ := newHermetic(t)

	config := sdk.EffectiveConfig()
	if strings.Contains(config, "bogus_sampler_name") {
		t.Errorf("EffectiveConfig echoes rejected sampler: %s", config)
	}
	if !strings.Contains(config, "sampler=parentbased_always_on") {
		t.Errorf("EffectiveConfig does not report the actual fallback: %s", config)
	}
}

// TestTraceIDAttributeReserved pins that user attributes named trace_id or
// span_id cannot shadow the genuine correlation identity on the console.
func TestTraceIDAttributeReserved(t *testing.T) {
	sdk, _, _, console := newHermetic(t)

	ctx, span := sdk.TracerProvider().Tracer("test").Start(context.Background(), "op")
	sdk.Logger().InfoContext(ctx, "spoof attempt", "trace_id", "attacker-chosen", "span_id", "fake")
	span.End()

	raw := console.String()
	if strings.Contains(raw, "attacker-chosen") || strings.Contains(raw, "fake") {
		t.Errorf("spoofed correlation attribute leaked into output: %s", raw)
	}
	records := consoleRecords(t, console)
	if got := records[0]["trace_id"]; got != span.SpanContext().TraceID().String() {
		t.Errorf("trace_id = %v, want genuine %s", got, span.SpanContext().TraceID())
	}
}
