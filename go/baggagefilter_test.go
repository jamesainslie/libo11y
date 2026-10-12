package o11y

import (
	"context"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
)

func mustMember(t *testing.T, key, value string) baggage.Member {
	t.Helper()
	m, err := baggage.NewMember(key, value)
	if err != nil {
		t.Fatalf("baggage.NewMember(%q, %q): %v", key, value, err)
	}
	return m
}

func TestBaggageEgressFilterStripsOnInject(t *testing.T) {
	base := propagation.NewCompositeTextMapPropagator(propagation.Baggage{})
	filtered := filterBaggageEgress(base, func(k string) bool { return k == "keep" })
	ctx := context.Background()
	b, err := baggage.New(mustMember(t, "keep", "1"), mustMember(t, "drop", "2"))
	if err != nil {
		t.Fatalf("baggage.New: %v", err)
	}
	ctx = baggage.ContextWithBaggage(ctx, b)
	carrier := propagation.MapCarrier{}
	filtered.Inject(ctx, carrier)
	if strings.Contains(carrier["baggage"], "drop") {
		t.Fatalf("dropped key leaked on inject: %q", carrier["baggage"])
	}
	if !strings.Contains(carrier["baggage"], "keep") {
		t.Fatalf("allowed key missing: %q", carrier["baggage"])
	}
}

func TestEgressFilterWrapsCustomPropagator(t *testing.T) {
	sdk, err := New(context.Background(), WithServiceName("bag"), WithEnvironment("test"),
		WithoutOTELEnv(), WithoutConsoleLog(), WithoutRuntimeMetrics(),
		WithPropagators(propagation.Baggage{}),
		WithBaggageEgressForTest(func(k string) bool { return k != "internal.secret" }))
	if err != nil {
		t.Fatal(err)
	}
	b, err := baggage.New(mustMember(t, "keep", "1"), mustMember(t, "internal.secret", "2"))
	if err != nil {
		t.Fatalf("baggage.New: %v", err)
	}
	carrier := propagation.MapCarrier{}
	sdk.Propagator().Inject(baggage.ContextWithBaggage(context.Background(), b), carrier)
	if strings.Contains(carrier["baggage"], "internal.secret") || !strings.Contains(carrier["baggage"], "keep") {
		t.Errorf("custom propagator bypassed the egress filter: %q", carrier["baggage"])
	}
}

func TestDefaultEgressStillAllowsAll(t *testing.T) {
	sdk, err := New(context.Background(), WithServiceName("bag"), WithEnvironment("test"),
		WithoutOTELEnv(), WithoutConsoleLog(), WithoutRuntimeMetrics())
	if err != nil {
		t.Fatal(err)
	}
	b, err := baggage.New(mustMember(t, "a", "1"), mustMember(t, "b", "2"))
	if err != nil {
		t.Fatalf("baggage.New: %v", err)
	}
	carrier := propagation.MapCarrier{}
	sdk.Propagator().Inject(baggage.ContextWithBaggage(context.Background(), b), carrier)
	if !strings.Contains(carrier["baggage"], "a=1") || !strings.Contains(carrier["baggage"], "b=2") {
		t.Errorf("default egress policy changed: %q", carrier["baggage"])
	}
}
