package o11y_test

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// TestNewNilOptionArguments pins that no exported option, given a nil or
// zero argument (including a typed nil pointer), makes New panic. Each case
// yields either a usable SDK or the documented typed error.
func TestNewNilOptionArguments(t *testing.T) {
	tests := []struct {
		name    string
		before  o11y.Option // optional, applied before opt
		opt     o11y.Option
		wantErr error
	}{
		{name: "nil Option", opt: nil},
		{name: "WithServiceName empty", opt: o11y.WithServiceName(""), wantErr: o11y.ErrNoServiceName},
		{name: "WithServiceVersion empty", opt: o11y.WithServiceVersion("")},
		{name: "WithServiceNamespace empty", opt: o11y.WithServiceNamespace("")},
		{name: "WithEnvironment empty", opt: o11y.WithEnvironment(""), wantErr: o11y.ErrNoEnvironment},
		{name: "WithEnvironmentValues none", opt: o11y.WithEnvironmentValues()},
		{name: "WithEnvironmentValues empty", opt: o11y.WithEnvironmentValues("")},
		{name: "WithResourceAttributes none", opt: o11y.WithResourceAttributes()},
		{name: "WithResourceAttributes zero", opt: o11y.WithResourceAttributes(attribute.KeyValue{})},
		{name: "WithLogLevel nil", opt: o11y.WithLogLevel(nil)},
		{name: "WithLogLevel typed nil", opt: o11y.WithLogLevel((*slog.LevelVar)(nil))},
		{name: "WithConsoleWriter nil", opt: o11y.WithConsoleWriter(nil)},
		{name: "WithConsoleWriter typed nil", opt: o11y.WithConsoleWriter((*bytes.Buffer)(nil))},
		{name: "WithConsoleFormat zero", opt: o11y.WithConsoleFormat(0)},
		{name: "WithLogExporter nil", opt: o11y.WithLogExporter(nil)},
		{name: "WithLogExporter typed nil", opt: o11y.WithLogExporter((*memLogExporter)(nil))},
		{name: "WithAttrReplacer nil", opt: o11y.WithAttrReplacer(nil)},
		{name: "WithPIIMode zero", opt: o11y.WithPIIMode(0)},
		{name: "WithPIIHashKey nil", opt: o11y.WithPIIHashKey(nil)},
		{name: "WithPIIHashKey nil under PIIHash", before: o11y.WithPIIMode(o11y.PIIHash), opt: o11y.WithPIIHashKey(nil), wantErr: o11y.ErrPIIHashKey},
		{name: "WithExtraLogHandler nil", opt: o11y.WithExtraLogHandler(nil)},
		{name: "WithExtraLogHandler typed nil", opt: o11y.WithExtraLogHandler((*slog.JSONHandler)(nil))},
		{name: "WithTraceSampler nil", opt: o11y.WithTraceSampler(nil)},
		{name: "WithPropagators none", opt: o11y.WithPropagators()},
		{name: "WithPropagators nil", opt: o11y.WithPropagators(nil)},
		{name: "WithPropagators nils", opt: o11y.WithPropagators(nil, nil)},
		{name: "WithPropagators nil entry", opt: o11y.WithPropagators(propagation.TraceContext{}, nil)},
		{name: "WithPropagators typed nil entry", opt: o11y.WithPropagators(propagation.TraceContext{}, (*propagation.TraceContext)(nil))},
		{name: "WithViews none", opt: o11y.WithViews()},
		{name: "WithViews nil", opt: o11y.WithViews(nil)},
		{name: "WithHistogramBuckets zero", opt: o11y.WithHistogramBuckets("", nil)},
		{name: "WithExemplarFilter nil", opt: o11y.WithExemplarFilter(nil)},
		{name: "WithErrorHandler nil", opt: o11y.WithErrorHandler(nil)},
		{name: "WithTraceExporter nil", opt: o11y.WithTraceExporter(nil)},
		{name: "WithTraceExporter typed nil", opt: o11y.WithTraceExporter((*tracetest.InMemoryExporter)(nil))},
		{name: "WithSpanProcessor nil", opt: o11y.WithSpanProcessor(nil)},
		{name: "WithSpanProcessor typed nil", opt: o11y.WithSpanProcessor((*tracetest.SpanRecorder)(nil))},
		{name: "WithMetricReader nil", opt: o11y.WithMetricReader(nil)},
		{name: "WithMetricReader typed nil", opt: o11y.WithMetricReader((*sdkmetric.ManualReader)(nil))},
		{name: "WithAppRegistry nil fs", opt: o11y.WithAppRegistry(nil, "o11y-registry.yaml"), wantErr: o11y.ErrInvalidAppRegistry},
		{name: "WithAppRegistry nil fs empty path", opt: o11y.WithAppRegistry(nil, ""), wantErr: o11y.ErrInvalidAppRegistry},
		{name: "WithAppRegistry typed nil fs", opt: o11y.WithAppRegistry((*embed.FS)(nil), "o11y-registry.yaml"), wantErr: o11y.ErrInvalidAppRegistry},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := []o11y.Option{
				o11y.WithServiceName("nil-options"),
				o11y.WithEnvironment(spec.EnvironmentTest),
				o11y.WithoutOTELEnv(),
				o11y.WithoutRuntimeMetrics(),
			}
			if tt.before != nil {
				opts = append(opts, tt.before)
			}
			opts = append(opts, tt.opt)
			sdk, err := newWithoutPanic(opts)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("New: err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			exerciseSDK(t, sdk)
		})
	}
}

// newWithoutPanic calls New and converts a panic into a test-visible error.
func newWithoutPanic(opts []o11y.Option) (sdk *o11y.SDK, err error) {
	defer func() {
		if r := recover(); r != nil {
			sdk, err = nil, fmt.Errorf("New panicked: %v", r)
		}
	}()
	return o11y.New(context.Background(), opts...)
}

// exerciseSDK drives every signal and the propagator once, then shuts the
// SDK down, so an option that stored a nil collaborator panics here.
func exerciseSDK(t *testing.T, sdk *o11y.SDK) {
	t.Helper()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("using the SDK panicked: %v", r)
		}
	}()
	ctx := context.Background()
	member, err := baggage.NewMember("tenant", "acme")
	if err != nil {
		t.Fatal(err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatal(err)
	}
	ctx = baggage.ContextWithBaggage(ctx, bag)

	ctx, span := sdk.TracerProvider().Tracer("nil-options").Start(ctx, "op")
	sdk.Logger().InfoContext(ctx, "exercised", "k", "v")
	counter, err := sdk.MeterProvider().Meter("nil-options").Int64Counter("nil.options.count")
	if err != nil {
		t.Fatalf("counter: %v", err)
	}
	counter.Add(ctx, 1)
	carrier := propagation.MapCarrier{}
	sdk.Propagator().Inject(ctx, carrier)
	_ = sdk.Propagator().Extract(context.Background(), carrier)
	span.End()
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
}

// TestSetupNilConsoleWriter is the reported reproduction: a nil console
// writer used to panic in the startup canary.
func TestSetupNilConsoleWriter(t *testing.T) {
	restoreGlobals(t)

	opts := []o11y.Option{
		o11y.WithServiceName("setup-nil-writer"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithConsoleWriter(nil),
	}
	sdk, err := o11y.Setup(context.Background(), opts...)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
}

// panickingSink panics on every record, standing in for a faulty
// user-supplied sink.
type panickingSink struct{}

func (panickingSink) Enabled(context.Context, slog.Level) bool  { return true }
func (panickingSink) Handle(context.Context, slog.Record) error { panic("sink exploded") }
func (h panickingSink) WithAttrs([]slog.Attr) slog.Handler      { return h }
func (h panickingSink) WithGroup(string) slog.Handler           { return h }

// TestSetupPanicReleasesGuard pins that a panic unwinding through Setup
// propagates to the caller unchanged and does not leave the setup guard
// held, and that the abandoned pipeline is stopped: its span processor is
// shut down exactly once.
func TestSetupPanicReleasesGuard(t *testing.T) {
	restoreGlobals(t)

	proc := &countingProcessor{}
	recovered := func() (r any) {
		defer func() { r = recover() }()
		opts := append(hermeticOptions("setup-panic"),
			o11y.WithSpanProcessor(proc), o11y.WithExtraLogHandler(panickingSink{}))
		_, _ = o11y.Setup(context.Background(), opts...)
		return nil
	}()
	if recovered != "sink exploded" {
		t.Fatalf("Setup recovered %v, want the sink's panic to propagate", recovered)
	}
	if n := proc.shutdowns.Load(); n != 1 {
		t.Errorf("abandoned span processor Shutdown ran %d times, want exactly once", n)
	}

	sdk, err := o11y.Setup(context.Background(), hermeticOptions("after-panic")...)
	if err != nil {
		t.Fatalf("Setup after a panicking Setup: %v", err)
	}
	if err := sdk.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
}
