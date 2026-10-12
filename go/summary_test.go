package o11y_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/conformance"
	"github.com/jamesainslie/libo11y/go/spec"
)

func TestStartupSummaryConformsAndHidesCredentials(t *testing.T) {
	restoreGlobals(t)
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://user:tok3n@collector.example:4318/v1?api_key=k3y#frag")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "collector.example:4317")
	extra, captured := newSlogCapture()
	sdk, err := o11y.Setup(context.Background(), append(hermeticOptions("summary-contract"), o11y.WithExtraLogHandler(extra))...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })

	var summary *slog.Record
	for _, r := range captured() {
		if r.Message == spec.EventTelemetryConfigured {
			summary = &r
		}
	}
	if summary == nil {
		t.Fatal("no startup summary captured")
	}
	var keys []string
	var rendered strings.Builder
	summary.Attrs(func(a slog.Attr) bool {
		keys = append(keys, a.Key)
		rendered.WriteString(a.Key + "=" + a.Value.String() + " ")
		return true
	})
	if problems := conformance.CheckEvent(spec.EventTelemetryConfigured, keys); len(problems) > 0 {
		t.Errorf("startup summary violates its contract: %v", problems)
	}
	all := rendered.String() + sdk.EffectiveConfig()
	for _, leak := range []string{"tok3n", "k3y", "frag", "user:"} {
		if strings.Contains(all, leak) {
			t.Errorf("summary leaked %q: %s", leak, all)
		}
	}
	// Both the emitted record (after the sinks' classification) and the
	// EffectiveConfig line carry the sanitized endpoints.
	for _, want := range []string{"o11y.config.endpoint=https://collector.example:4318/v1", "o11y.config.traces_endpoint=collector.example:4317"} {
		if !strings.Contains(rendered.String(), want) {
			t.Errorf("summary record missing %q: %s", want, rendered.String())
		}
		if !strings.Contains(sdk.EffectiveConfig(), want) {
			t.Errorf("EffectiveConfig missing %q: %s", want, sdk.EffectiveConfig())
		}
	}
}

// TestSummaryReportsPerSignalEndpointsSanitized pins that the metrics and
// logs endpoints are reported, and sanitized, like the generic one.
func TestSummaryReportsPerSignalEndpointsSanitized(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "https://m:pw1@metrics.example:4318/v1/metrics?token=t1")
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "https://logs.example:4318/v1/logs#l0g")
	sdk, _, _, _ := newHermetic(t)

	config := sdk.EffectiveConfig()
	for _, want := range []string{
		"o11y.config.metrics_endpoint=https://metrics.example:4318/v1/metrics",
		"o11y.config.logs_endpoint=https://logs.example:4318/v1/logs",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("EffectiveConfig missing %q: %s", want, config)
		}
	}
	for _, leak := range []string{"pw1", "t1", "l0g"} {
		if strings.Contains(config, leak) {
			t.Errorf("EffectiveConfig leaked %q: %s", leak, config)
		}
	}
}

// TestSummaryListsNoEndpointsWithoutOTELEnv pins that WithoutOTELEnv,
// which never builds an exporter from the environment, reports no
// environment endpoint.
func TestSummaryListsNoEndpointsWithoutOTELEnv(t *testing.T) {
	for _, env := range []string{
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	} {
		t.Setenv(env, "https://collector.example:4318")
	}
	sdk, _, _, _ := newHermetic(t, o11y.WithoutOTELEnv())

	if config := sdk.EffectiveConfig(); strings.Contains(config, "endpoint=") {
		t.Errorf("EffectiveConfig lists an endpoint under WithoutOTELEnv: %s", config)
	}
}

// TestEffectiveConfigReportsFallbackForUnsupportedSampler pins that a
// sampler name other SDKs accept but the Go SDK rejects is reported as the
// fallback the Go SDK actually applies.
func TestEffectiveConfigReportsFallbackForUnsupportedSampler(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "xray")
	sdk, _, _, _ := newHermetic(t)

	config := sdk.EffectiveConfig()
	if !strings.Contains(config, "o11y.config.sampler=parentbased_always_on") {
		t.Errorf("EffectiveConfig does not report the actual fallback: %s", config)
	}
}

// TestEffectiveConfigFlagsVersionFallback pins that the summary reports when
// service.version fell back to the placeholder, and only then.
func TestEffectiveConfigFlagsVersionFallback(t *testing.T) {
	const flag = "o11y.config.service_version_fallback=true"
	fallback, _, _, _ := newHermetic(t, o11y.WithoutBuildInfo())
	if !strings.Contains(fallback.EffectiveConfig(), flag) {
		t.Errorf("EffectiveConfig without a version missing %q: %s", flag, fallback.EffectiveConfig())
	}
	versioned, _, _, _ := newHermetic(t, o11y.WithServiceVersion("1.2.3"))
	if strings.Contains(versioned.EffectiveConfig(), flag) {
		t.Errorf("EffectiveConfig with a version carries %q: %s", flag, versioned.EffectiveConfig())
	}
}

func TestSanitizeEndpoint(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"https://user:tok3n@collector.example:4318/v1?api_key=k3y#frag", "https://collector.example:4318/v1"},
		{"http://collector.example:4318", "http://collector.example:4318"},
		{"collector.example:4317", "collector.example:4317"},
		{"user:pw@collector.example:4317", "collector.example:4317"},
		{"https://collector.example/?", "https://collector.example/"},
		{"https://[::1]:4318/v1", "https://[::1]:4318/v1"},
		{"://bad", "unparseable"},
		{"http://%zz", "unparseable"},
		// An unencoded '/', '?', or '#' in userinfo ends the authority
		// early, so the credential would land in the host or path: such
		// values are withheld rather than partially echoed.
		{"https://AbC/x+y@collector.example:4318", "unparseable"},
		{"AbC/x+y@collector.example:4317", "unparseable"},
		{"https://user:/s3cr3t@collector.example", "unparseable"},
		{"https://user:12?ab@collector.example:4318", "unparseable"},
		{"https://u:p@x/y@collector.example", "unparseable"},
		// An '@' inside the password followed by '?' or '#' makes the
		// parser take the password tail as the host.
		{"https://u:p@ss?word@collector.example:4318", "unparseable"},
		{"https://u:S3cr3t@abc?x@collector.example:4318/v1", "unparseable"},
		{"u:p@ss?word@collector.example:4317", "unparseable"},
	}
	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			if got := o11y.SanitizeEndpoint(tc.raw); got != tc.want {
				t.Errorf("sanitizeEndpoint(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestEffectiveConfigNormalizesSampler pins that the summary reports the
// sampler the Go SDK actually applies, which trims and lowercases the name.
func TestEffectiveConfigNormalizesSampler(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", " ALWAYS_OFF ")
	sdk, _, _, _ := newHermetic(t)

	if want := "o11y.config.sampler=always_off"; !strings.Contains(sdk.EffectiveConfig(), want) {
		t.Errorf("EffectiveConfig missing %q: %s", want, sdk.EffectiveConfig())
	}
}
