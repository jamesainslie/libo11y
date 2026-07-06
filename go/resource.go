package o11y

import (
	"context"
	"fmt"
	"runtime/debug"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
)

// buildResource composes the telemetry resource from detectors and explicit
// options. Precedence, lowest to highest: build info, environment
// (OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME), telemetry SDK identity,
// host, process runtime, and container detectors, then explicit option
// attributes.
func buildResource(ctx context.Context, s *settings) (*resource.Resource, error) {
	explicit := make([]attribute.KeyValue, 0, len(s.resourceAttrs)+2)
	if s.serviceName != "" {
		explicit = append(explicit, semconv.ServiceName(s.serviceName))
	}
	if s.serviceVersion != "" {
		explicit = append(explicit, semconv.ServiceVersion(s.serviceVersion))
	}
	explicit = append(explicit, s.resourceAttrs...)

	opts := make([]resource.Option, 0, 8)
	if s.buildInfo {
		opts = append(opts, resource.WithDetectors(buildInfoDetector{}))
	}
	opts = append(opts,
		resource.WithFromEnv(),
		resource.WithTelemetrySDK(),
		resource.WithHost(),
		resource.WithProcessRuntimeName(),
		resource.WithProcessRuntimeVersion(),
		resource.WithContainer(),
		resource.WithAttributes(explicit...),
	)

	res, err := resource.New(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("o11y: building resource: %w", err)
	}
	if !hasServiceName(res) {
		return nil, ErrNoServiceName
	}
	return res, nil
}

// buildInfoDetector records the compiled binary's identity from the Go
// build info embedded by the toolchain: the main module version (as
// service.version, when it carries a real version) and the VCS stamp
// (vcs.revision, vcs.time, vcs.modified).
type buildInfoDetector struct{}

// Detect implements [resource.Detector].
func (buildInfoDetector) Detect(context.Context) (*resource.Resource, error) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return resource.Empty(), nil
	}
	return resource.NewSchemaless(buildInfoAttrs(info)...), nil
}

func buildInfoAttrs(info *debug.BuildInfo) []attribute.KeyValue {
	var attrs []attribute.KeyValue
	if version := info.Main.Version; version != "" && version != "(devel)" {
		attrs = append(attrs, semconv.ServiceVersion(version))
	}
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision", "vcs.time", "vcs.modified":
			if setting.Value != "" {
				attrs = append(attrs, attribute.String(setting.Key, setting.Value))
			}
		}
	}
	return attrs
}

func hasServiceName(res *resource.Resource) bool {
	for _, kv := range res.Attributes() {
		if kv.Key == semconv.ServiceNameKey && kv.Value.AsString() != "" {
			return true
		}
	}
	return false
}
