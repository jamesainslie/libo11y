package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"

	"github.com/jamesainslie/libo11y/go/internal/fanout"
	"github.com/jamesainslie/libo11y/go/spec"
)

// EffectiveConfig returns a single-line rendering of the fully resolved
// configuration: service identity, the exporter chosen per signal, sampler,
// log level, and propagator fields. [Setup] also emits it as the startup
// summary record unless [WithoutStartupSummary] is given.
func (s *SDK) EffectiveConfig() string { return s.effectiveConfig }

// buildSummary resolves the observable configuration into log attributes
// and a one-line string. It reports what will actually happen, after
// option-over-environment precedence has been applied.
func buildSummary(s *settings, sdk *SDK) ([]slog.Attr, string) {
	serviceName, serviceVersion := "", ""
	for _, kv := range sdk.res.Attributes() {
		switch kv.Key {
		case semconv.ServiceNameKey:
			serviceName = kv.Value.AsString()
		case semconv.ServiceVersionKey:
			serviceVersion = kv.Value.AsString()
		}
	}

	// Under WithoutOTELEnv a signal with nothing injected is disabled rather
	// than built from the environment.
	traces := "injected"
	switch {
	case s.spanProcessor != nil || s.spanExporter != nil:
	case s.ignoreEnv:
		traces = "none"
	default:
		traces = s.envOr("OTEL_TRACES_EXPORTER", "otlp")
	}
	metrics := "injected"
	switch {
	case s.metricReader != nil:
	case s.ignoreEnv:
		metrics = "none"
	default:
		metrics = s.envOr("OTEL_METRICS_EXPORTER", "otlp")
	}
	logs := "none"
	switch {
	case !s.logExportEnabled():
	case s.logExporter != nil:
		logs = "injected"
	default:
		logs = s.envOr("OTEL_LOGS_EXPORTER", "otlp")
	}
	console := "off"
	if s.consoleEnabled {
		console = "json"
		if s.consoleFormat == ConsoleText {
			console = "text"
		}
	}

	sampler := s.envOr("OTEL_TRACES_SAMPLER", "parentbased_always_on")
	if !knownSampler(sampler) {
		// The SDK rejects unknown sampler names and falls back; the
		// summary must report what actually happens, not echo the typo.
		sampler = "parentbased_always_on"
	}
	if s.sampler != nil {
		sampler = s.sampler.Description()
	}

	level := slog.LevelInfo
	if s.logLevel != nil {
		level = s.logLevel.Level()
	}

	propagators := strings.Join(sdk.propagator.Fields(), ",")

	attrs := []slog.Attr{
		slog.String("service.name", serviceName),
	}
	if serviceVersion != "" {
		attrs = append(attrs, slog.String("service.version", serviceVersion))
	}
	attrs = append(attrs,
		slog.String("traces", traces),
		slog.String("metrics", metrics),
		slog.String("logs", logs),
		slog.String("console", console),
		slog.String("level", level.String()),
		slog.String("sampler", sampler),
		slog.String("propagators", propagators),
		slog.Bool("runtime_metrics", s.runtimeMetrics),
	)
	if endpoint := s.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"); endpoint != "" {
		attrs = append(attrs, slog.String("endpoint", endpoint))
	}

	var line strings.Builder
	for i, attr := range attrs {
		if i > 0 {
			line.WriteByte(' ')
		}
		fmt.Fprintf(&line, "%s=%s", attr.Key, attr.Value)
	}
	return attrs, line.String()
}

// emitStartupSummary forces the o11y.telemetry.configured event through the
// full log pipeline. It doubles as the initialization canary: an error from
// any synchronously-rejecting sink (console writer, extra handlers) is
// returned so Setup can fail fast. The OTLP sink batches asynchronously, so
// this is a pipeline-wiring check, not a collector-connectivity check.
func (s *SDK) emitStartupSummary(ctx context.Context, attrs []slog.Attr) error {
	record := slog.NewRecord(time.Now(), slog.LevelInfo, spec.EventTelemetryConfigured, 0)
	record.AddAttrs(slog.String(spec.EventNameKey, spec.EventTelemetryConfigured))
	record.AddAttrs(attrs...)
	return s.handler.Handle(fanout.WithForce(ctx), record)
}

// knownSampler reports whether name is a sampler the SDK accepts from
// OTEL_TRACES_SAMPLER.
func knownSampler(name string) bool {
	switch name {
	case "always_on", "always_off", "traceidratio",
		"parentbased_always_on", "parentbased_always_off", "parentbased_traceidratio",
		"jaeger_remote", "parentbased_jaeger_remote", "xray":
		return true
	default:
		return false
	}
}
