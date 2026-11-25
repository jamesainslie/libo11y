package o11y_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// newEnvSDK builds an SDK that reads the environment but injects its own
// span processor and metric reader, so no exporter is built from it.
func newEnvSDK(t *testing.T, extra ...o11y.Option) (*o11y.SDK, error) {
	t.Helper()
	opts := append([]o11y.Option{
		o11y.WithServiceName("propagators-env"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithTraceSampler(sdktrace.AlwaysSample()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	}, extra...)
	sdk, err := o11y.New(context.Background(), opts...)
	if err == nil {
		t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	}
	return sdk, err
}

// injectSampled injects a sampled span from sdk, with baggage members
// keep=1 and drop=2, through sdk's propagator.
func injectSampled(t *testing.T, sdk *o11y.SDK) propagation.MapCarrier {
	t.Helper()
	ctx, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op")
	defer span.End()
	keep, _ := baggage.NewMember("keep", "1")
	drop, _ := baggage.NewMember("drop", "2")
	bag, err := baggage.New(keep, drop)
	if err != nil {
		t.Fatal(err)
	}
	carrier := propagation.MapCarrier{}
	sdk.Propagator().Inject(baggage.ContextWithBaggage(ctx, bag), carrier)
	return carrier
}

// fieldless is a propagator that carries nothing and names no fields, but
// is not the none propagator.
type fieldless struct{}

func (fieldless) Inject(context.Context, propagation.TextMapCarrier) {}
func (fieldless) Extract(ctx context.Context, _ propagation.TextMapCarrier) context.Context {
	return ctx
}
func (fieldless) Fields() []string { return nil }

// configValue returns the value of key in an EffectiveConfig line.
func configValue(line, key string) (string, bool) {
	for _, field := range strings.Fields(line) {
		if k, v, ok := strings.Cut(field, "="); ok && k == key {
			return v, true
		}
	}
	return "", false
}

func TestPropagatorsFromEnvironment(t *testing.T) {
	tests := []struct {
		name       string
		env        string
		opts       []o11y.Option
		wantKeys   []string // keys the carrier must hold
		noKeys     []string // keys it must not hold
		wantEmpty  bool     // nothing may be injected
		wantConfig string   // the o11y.config.propagators value
	}{
		{
			name: "unset keeps the default", env: "",
			wantKeys:   []string{"traceparent", "baggage"},
			wantConfig: "traceparent,tracestate,baggage",
		},
		{
			name: "b3", env: "b3",
			wantKeys: []string{"b3"}, noKeys: []string{"traceparent", "baggage"},
			wantConfig: "b3",
		},
		{
			name: "tracecontext alone drops baggage", env: "tracecontext",
			wantKeys: []string{"traceparent"}, noKeys: []string{"baggage"},
			wantConfig: "traceparent,tracestate",
		},
		{
			name: "none injects nothing", env: "none",
			wantEmpty: true, wantConfig: "none",
		},
		{
			name: "option beats the variable", env: "b3",
			opts:     []o11y.Option{o11y.WithPropagators(propagation.TraceContext{})},
			wantKeys: []string{"traceparent"}, noKeys: []string{"b3"},
			wantConfig: "traceparent,tracestate",
		},
		{
			name: "an option with only nil entries leaves the variable", env: "b3",
			opts:     []o11y.Option{o11y.WithPropagators(nil)},
			wantKeys: []string{"b3"}, noKeys: []string{"traceparent"}, wantConfig: "b3",
		},
		{
			name: "option beats an unknown name", env: "bogus",
			opts:     []o11y.Option{o11y.WithPropagators(propagation.TraceContext{})},
			wantKeys: []string{"traceparent"}, wantConfig: "traceparent,tracestate",
		},
		{
			name: "WithoutOTELEnv ignores the variable", env: "b3",
			opts:     []o11y.Option{o11y.WithoutOTELEnv()},
			wantKeys: []string{"traceparent", "baggage"}, noKeys: []string{"b3"},
			wantConfig: "traceparent,tracestate,baggage",
		},
		{
			name: "spaces around entries are trimmed", env: " tracecontext , baggage ",
			wantKeys: []string{"traceparent", "baggage"}, wantConfig: "traceparent,tracestate,baggage",
		},
		{
			name: "a trailing comma is ignored", env: "tracecontext,",
			wantKeys: []string{"traceparent"}, noKeys: []string{"baggage"},
			wantConfig: "traceparent,tracestate",
		},
		{
			name: "an all-empty value is unset", env: " , ,",
			wantKeys: []string{"traceparent", "baggage"}, wantConfig: "traceparent,tracestate,baggage",
		},
		{
			name: "the config shows the configured order", env: "baggage,tracecontext",
			wantKeys: []string{"traceparent", "baggage"}, wantConfig: "baggage,traceparent,tracestate",
		},
		{
			name: "option order is reported", env: "",
			opts:     []o11y.Option{o11y.WithPropagators(propagation.Baggage{}, propagation.TraceContext{})},
			wantKeys: []string{"traceparent", "baggage"}, wantConfig: "baggage,traceparent,tracestate",
		},
		{
			name: "a fieldless propagator is not none", env: "",
			opts:      []o11y.Option{o11y.WithPropagators(fieldless{})},
			wantEmpty: true, wantConfig: "custom",
		},
		{
			name: "an empty composite is not none", env: "",
			opts:      []o11y.Option{o11y.WithPropagators(propagation.NewCompositeTextMapPropagator())},
			wantEmpty: true, wantConfig: "custom",
		},
		{
			name: "duplicate entries are reported once", env: "tracecontext,tracecontext",
			wantKeys: []string{"traceparent"}, noKeys: []string{"baggage"},
			wantConfig: "traceparent,tracestate",
		},
		{
			name: "WithoutOTELEnv ignores an unknown name", env: "bogus",
			opts:     []o11y.Option{o11y.WithoutOTELEnv()},
			wantKeys: []string{"traceparent"}, wantConfig: "traceparent,tracestate,baggage",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("OTEL_PROPAGATORS", tt.env)
			sdk, err := newEnvSDK(t, tt.opts...)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			carrier := injectSampled(t, sdk)
			if tt.wantEmpty && len(carrier) != 0 {
				t.Errorf("injected %v, want nothing", carrier)
			}
			for _, k := range tt.wantKeys {
				if carrier[k] == "" {
					t.Errorf("carrier %v lacks %q", carrier, k)
				}
			}
			for _, k := range tt.noKeys {
				if _, ok := carrier[k]; ok {
					t.Errorf("carrier %v holds %q", carrier, k)
				}
			}
			if got, ok := configValue(sdk.EffectiveConfig(), "o11y.config.propagators"); !ok || got != tt.wantConfig {
				t.Errorf("o11y.config.propagators = %q (present %t), want %q", got, ok, tt.wantConfig)
			}
		})
	}
}

// TestUnknownPropagatorFailsFast pins that a name autoprop does not know
// fails New, alone, next to a known one, or next to none, with an error
// that quotes it. Names are case-sensitive.
func TestUnknownPropagatorFailsFast(t *testing.T) {
	for _, tc := range []struct{ env, name string }{
		{"bogus", "bogus"},
		{"tracecontext,bogus", "bogus"},
		{"tracecontext, bogus ", "bogus"},
		{"bogus,none", "bogus"},
		{"TraceContext", "TraceContext"},
		{"tracecontext,Baggage", "Baggage"},
	} {
		env, name := tc.env, tc.name
		t.Run(env, func(t *testing.T) {
			t.Setenv("OTEL_PROPAGATORS", env)
			_, err := newEnvSDK(t)
			if err == nil {
				t.Fatal("New succeeded, want an error")
			}
			quoted := fmt.Sprintf("%q", name)
			if msg := err.Error(); !strings.Contains(msg, quoted) || !strings.HasPrefix(msg, "o11y: building propagator: ") {
				t.Errorf("err = %q, want it to start with %q and name %s", msg, "o11y: building propagator: ", quoted)
			}
		})
	}
}

// TestEnvironmentPropagatorKeepsBaggageEgressFilter pins that the egress
// filter wraps a propagator built from the variable.
func TestEnvironmentPropagatorKeepsBaggageEgressFilter(t *testing.T) {
	t.Setenv("OTEL_PROPAGATORS", "tracecontext,baggage")
	sdk, err := newEnvSDK(t, o11y.WithBaggageEgressForTest(func(key string) bool { return key == "keep" }))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := injectSampled(t, sdk)["baggage"]; got != "keep=1" {
		t.Errorf("baggage = %q, want keep=1 only", got)
	}
}
