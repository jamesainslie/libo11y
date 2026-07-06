package o11y

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
)

// buildResource composes the telemetry resource from detectors and explicit
// options. Precedence, lowest to highest: build info, telemetry SDK
// identity, host, process runtime, and container detectors, then the
// environment (OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME), then explicit
// option attributes. Detected values are library defaults, so the
// environment must override them per the documented
// option-over-environment-over-default contract.
func buildResource(ctx context.Context, s *settings) (*resource.Resource, error) {
	explicit := make([]attribute.KeyValue, 0, len(s.resourceAttrs)+2)
	if name := strings.TrimSpace(s.serviceName); name != "" {
		explicit = append(explicit, semconv.ServiceName(name))
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
		resource.WithTelemetrySDK(),
		resource.WithHost(),
		resource.WithProcessRuntimeName(),
		resource.WithProcessRuntimeVersion(),
		resource.WithContainer(),
		resource.WithFromEnv(),
		resource.WithAttributes(explicit...),
	)

	res, err := resource.New(ctx, opts...)
	if err != nil {
		// A partial resource (a detector failed, the rest succeeded) is
		// usable telemetry identity; refusing to start over a missing
		// container ID would violate the never-break-the-host contract.
		if res == nil || !errors.Is(err, resource.ErrPartialResource) {
			return nil, fmt.Errorf("o11y: building resource: %w", err)
		}
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

// hasServiceName reports whether the resource carries a usable service
// identity: non-blank after trimming and not the SDK's unknown_service
// fallback shape, regardless of which channel supplied it.
func hasServiceName(res *resource.Resource) bool {
	for _, kv := range res.Attributes() {
		if kv.Key != semconv.ServiceNameKey {
			continue
		}
		name := strings.TrimSpace(kv.Value.AsString())
		if name == "" || name == "unknown_service" || strings.HasPrefix(name, "unknown_service:") {
			return false
		}
		return true
	}
	return false
}
