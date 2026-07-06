package o11y

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
)

// buildResource composes the telemetry resource from detectors and explicit
// options. Precedence, lowest to highest: environment
// (OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME), telemetry SDK identity,
// host and process runtime detectors, then explicit option attributes.
func buildResource(ctx context.Context, s *settings) (*resource.Resource, error) {
	explicit := make([]attribute.KeyValue, 0, len(s.resourceAttrs)+2)
	if s.serviceName != "" {
		explicit = append(explicit, semconv.ServiceName(s.serviceName))
	}
	if s.serviceVersion != "" {
		explicit = append(explicit, semconv.ServiceVersion(s.serviceVersion))
	}
	explicit = append(explicit, s.resourceAttrs...)

	res, err := resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithTelemetrySDK(),
		resource.WithHost(),
		resource.WithProcessRuntimeName(),
		resource.WithProcessRuntimeVersion(),
		resource.WithAttributes(explicit...),
	)
	if err != nil {
		return nil, fmt.Errorf("o11y: building resource: %w", err)
	}
	if !hasServiceName(res) {
		return nil, ErrNoServiceName
	}
	return res, nil
}

func hasServiceName(res *resource.Resource) bool {
	for _, kv := range res.Attributes() {
		if kv.Key == semconv.ServiceNameKey && kv.Value.AsString() != "" {
			return true
		}
	}
	return false
}
