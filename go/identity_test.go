package o11y_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// bareOpts is the hermetic option set without identity, for identity tests.
func bareOpts() []o11y.Option {
	return []o11y.Option{
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	}
}

func resourceAttr(t *testing.T, sdk *o11y.SDK, key string) string {
	t.Helper()
	for _, kv := range sdk.Resource().Attributes() {
		if string(kv.Key) == key {
			return kv.Value.AsString()
		}
	}
	return ""
}

func TestEnvironmentRequired(t *testing.T) {
	opts := append(bareOpts(), o11y.WithServiceName("svc"))
	if _, err := o11y.New(context.Background(), opts...); !errors.Is(err, o11y.ErrNoEnvironment) {
		t.Fatalf("New without environment: err = %v, want ErrNoEnvironment", err)
	}
}

func TestEnvironmentFromOption(t *testing.T) {
	opts := append(bareOpts(),
		o11y.WithServiceName("svc"),
		o11y.WithEnvironment(spec.EnvironmentProduction),
	)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if got := resourceAttr(t, sdk, "deployment.environment.name"); got != "production" {
		t.Errorf("deployment.environment.name = %q, want production", got)
	}
}

func TestEnvironmentFromResourceAttributes(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=staging")
	opts := append(bareOpts(), o11y.WithServiceName("svc"))
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if got := resourceAttr(t, sdk, "deployment.environment.name"); got != "staging" {
		t.Errorf("deployment.environment.name = %q, want staging", got)
	}
}

func TestEnvironmentInvalidRejected(t *testing.T) {
	opts := append(bareOpts(),
		o11y.WithServiceName("svc"),
		o11y.WithEnvironment(spec.Environment("prod")), // abbreviation, not allowed
	)
	if _, err := o11y.New(context.Background(), opts...); !errors.Is(err, o11y.ErrInvalidEnvironment) {
		t.Fatalf("New with invalid environment: err = %v, want ErrInvalidEnvironment", err)
	}
}

func TestEnvironmentExtensionAccepted(t *testing.T) {
	opts := append(bareOpts(),
		o11y.WithServiceName("svc"),
		o11y.WithEnvironment(spec.Environment("perf")),
		o11y.WithEnvironmentValues(spec.Environment("perf")),
	)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New with registered custom environment: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
}

func TestWithoutStrictIdentityDowngradesToWarning(t *testing.T) {
	// No service name, no environment, but strict identity disabled: Setup
	// succeeds rather than erroring.
	opts := append(bareOpts(), o11y.WithoutStrictIdentity())
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New with WithoutStrictIdentity: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
}

func TestSchemaURLStamped(t *testing.T) {
	opts := append(bareOpts(),
		o11y.WithServiceName("svc"),
		o11y.WithEnvironment(spec.EnvironmentTest),
	)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if got := sdk.Resource().SchemaURL(); got != spec.SchemaURL {
		t.Errorf("resource schema URL = %q, want %q", got, spec.SchemaURL)
	}
}

func TestInstanceIDDerivedUUIDv4(t *testing.T) {
	opts := append(bareOpts(),
		o11y.WithServiceName("svc"),
		o11y.WithEnvironment(spec.EnvironmentTest),
	)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	id := resourceAttr(t, sdk, "service.instance.id")
	if id == "" {
		t.Fatal("service.instance.id not derived")
	}
	if len(id) != 36 || strings.Count(id, "-") != 4 {
		t.Errorf("service.instance.id = %q, want a UUID", id)
	}
}

func TestInstanceIDDerivedFromPodStable(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "k8s.pod.uid=pod-uid-1234,k8s.namespace.name=default")
	build := func() string {
		opts := append(bareOpts(),
			o11y.WithServiceName("svc"),
			o11y.WithEnvironment(spec.EnvironmentTest),
		)
		sdk, err := o11y.New(context.Background(), opts...)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
		return resourceAttr(t, sdk, "service.instance.id")
	}
	// Derived from the pod UID: stable across process restarts (UUIDv5).
	if first, second := build(), build(); first != second {
		t.Errorf("pod-derived instance id not stable: %q vs %q", first, second)
	}
}

func TestServiceVersionFallback(t *testing.T) {
	// No version option, and the test binary has no module version.
	opts := append(bareOpts(),
		o11y.WithServiceName("svc"),
		o11y.WithEnvironment(spec.EnvironmentTest),
	)
	sdk, err := o11y.New(context.Background(), opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	if got := resourceAttr(t, sdk, "service.version"); got == "" {
		t.Error("service.version absent; a fallback should be recorded")
	}
}
