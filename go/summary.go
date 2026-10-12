package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"

	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"

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

	// The SDK trims and lowercases the name before matching it.
	sampler := strings.ToLower(strings.TrimSpace(s.envOr("OTEL_TRACES_SAMPLER", "parentbased_always_on")))
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

	// Every resolved setting travels as an o11y.config.<key> attribute, the
	// registered contract of the o11y.telemetry.configured event.
	attrs := []slog.Attr{slog.String("service.name", serviceName)}
	if serviceVersion != "" {
		attrs = append(attrs, slog.String("service.version", serviceVersion))
	}
	attrs = append(attrs,
		configAttr("traces", traces),
		configAttr("metrics", metrics),
		configAttr("logs", logs),
		configAttr("console", console),
		configAttr("level", level.String()),
		configAttr("sampler", sampler),
		configAttr("propagators", propagators),
		configAttr("runtime_metrics", strconv.FormatBool(s.runtimeMetrics)),
	)
	if s.versionFallback {
		attrs = append(attrs, configAttr("service_version_fallback", "true"))
	}
	// Endpoints are sanitized: a URL may carry credentials in its userinfo
	// or query, and the summary is emitted to every sink. Under
	// WithoutOTELEnv getenv reports nothing, so no endpoint is listed.
	for _, ep := range []struct{ key, env string }{
		{"endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT"},
		{"traces_endpoint", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"},
		{"metrics_endpoint", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"},
		{"logs_endpoint", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"},
	} {
		if raw := s.getenv(ep.env); raw != "" {
			attrs = append(attrs, configAttr(ep.key, sanitizeEndpoint(raw)))
		}
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

// configAttr renders one o11y.config.<key> attribute for the startup event.
func configAttr(key, value string) slog.Attr {
	kv := spec.Config(key, value)
	return slog.String(string(kv.Key), kv.Value.AsString())
}

// sanitizeEndpoint renders an exporter endpoint without credentials:
// userinfo, query, and fragment are removed. Scheme-less gRPC endpoints
// (host:port) are supported; an unparseable value is withheld.
//
// A credential containing an unencoded '/', '?', or '#' ends the URL
// authority early, so the parser never sees it as userinfo and part of it
// lands in the host, path, or query. An '@' inside the password followed by
// a '?' or '#' likewise makes the parser take the password's tail as the
// host. Any '@' other than a single userinfo separator, or any '@' that
// survives into the output, therefore withholds the whole value rather than
// echoing a fragment of the secret.
func sanitizeEndpoint(raw string) string {
	const withheld = "unparseable"
	schemeless := !strings.Contains(raw, "://")
	if schemeless {
		raw = "//" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return withheld
	}
	if n := strings.Count(raw, "@"); n > 1 || (n == 1 && u.User == nil) {
		return withheld
	}
	u.User = nil
	u.RawQuery, u.ForceQuery = "", false
	u.Fragment, u.RawFragment = "", ""
	out := u.String()
	if strings.Contains(out, "@") {
		return withheld
	}
	if schemeless {
		out = strings.TrimPrefix(out, "//")
	}
	return out
}

// emitStartupSummary forces the o11y.telemetry.configured event through the
// full log pipeline. It doubles as the initialization canary: an error from
// any synchronously-rejecting sink (console writer, extra handlers) is
// returned so Setup can fail fast. The OTLP sink batches asynchronously, so
// this is a pipeline-wiring check, not a collector-connectivity check.
func (s *SDK) emitStartupSummary(ctx context.Context, attrs []slog.Attr) error {
	return s.emitEvent(ctx, slog.LevelInfo, spec.EventTelemetryConfigured, attrs)
}

// knownSampler reports whether name is a sampler the Go SDK accepts from
// OTEL_TRACES_SAMPLER (go.opentelemetry.io/otel/sdk/trace sampler_env.go).
// Names other SDKs accept, such as jaeger_remote or xray, are rejected by
// the Go SDK, which then falls back to its default.
func knownSampler(name string) bool {
	switch name {
	case "always_on", "always_off", "traceidratio",
		"parentbased_always_on", "parentbased_always_off", "parentbased_traceidratio":
		return true
	default:
		return false
	}
}
