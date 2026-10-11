package o11y_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

var testKey = bytes.Repeat([]byte("k"), 32)

const tokenPrefix = "hmac-sha256:"

func hostIPToken(t *testing.T, opts ...o11y.Option) string {
	t.Helper()
	sdk, _, _, console := newHermetic(t, opts...)
	sdk.Logger().Info("m", "host.ip", "10.9.8.7")
	recs := consoleRecords(t, console)
	if len(recs) != 1 {
		t.Fatalf("got %d console records", len(recs))
	}
	v, _ := recs[0]["host.ip"].(string)
	if strings.Contains(console.String(), "10.9.8.7") {
		t.Fatalf("raw PII reached the console: %s", console.String())
	}
	return v
}

func TestPIIAttributesDroppedByDefault(t *testing.T) {
	t.Parallel()
	if got := hostIPToken(t); got != "" {
		t.Errorf("default mode emitted host.ip = %q, want it dropped", got)
	}
}

func TestPIIHashRequiresKey(t *testing.T) {
	t.Parallel()
	for name, opts := range map[string][]o11y.Option{
		"no key":    {o11y.WithPIIMode(o11y.PIIHash)},
		"short key": {o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey([]byte("short"))},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			base := []o11y.Option{
				o11y.WithServiceName("pii"), o11y.WithEnvironment(spec.EnvironmentTest),
				o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics(),
			}
			_, err := o11y.New(context.Background(), append(base, opts...)...)
			if !errors.Is(err, o11y.ErrPIIHashKey) {
				t.Fatalf("New error = %v, want ErrPIIHashKey", err)
			}
		})
	}
}

func TestPIIHashIsKeyedAndStable(t *testing.T) {
	t.Parallel()
	hash := func(key []byte) string {
		return hostIPToken(t, o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(key))
	}
	a, b := hash(testKey), hash(testKey)
	other := hash(bytes.Repeat([]byte("j"), 32))
	if !strings.HasPrefix(a, tokenPrefix) || len(a) != len(tokenPrefix)+32 {
		t.Fatalf("token %q has the wrong shape", a)
	}
	if a != b {
		t.Errorf("same key produced different tokens: %q vs %q", a, b)
	}
	if a == other {
		t.Error("different keys produced the same token")
	}
}

func TestPIIHashKeyIsCopied(t *testing.T) {
	t.Parallel()
	key := bytes.Clone(testKey)
	opt := o11y.WithPIIHashKey(key)
	key[0] = 'x' // mutating the caller's slice must not change the SDK key
	if got, want := hostIPToken(t, o11y.WithPIIMode(o11y.PIIHash), opt),
		hostIPToken(t, o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey)); got != want {
		t.Errorf("token after caller mutation = %q, want %q", got, want)
	}
}

// TestPIIHashSameTokenOnLogsAndSpans pins one canonical hash input across
// signals: the same PII value, scalar or slice-valued, must produce the same
// token on a log record and on an exported span, or tokens stop joining.
func TestPIIHashSameTokenOnLogsAndSpans(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		log  slog.Attr
		span attribute.KeyValue
	}{
		{"string", slog.String("host.ip", "10.9.8.7"), attribute.String("host.ip", "10.9.8.7")},
		{"int", slog.Int64("host.ip", 42), attribute.Int64("host.ip", 42)},
		{"float", slog.Float64("host.ip", 1e21), attribute.Float64("host.ip", 1e21)},
		{"bool", slog.Bool("host.ip", true), attribute.Bool("host.ip", true)},
		{
			"string slice",
			slog.Any("host.ip", []string{"10.9.8.7", "10.9.8.8"}),
			attribute.StringSlice("host.ip", []string{"10.9.8.7", "10.9.8.8"}),
		},
		{
			"int slice",
			slog.Any("host.ip", []int64{1, 2}),
			attribute.Int64Slice("host.ip", []int64{1, 2}),
		},
		{
			"float slice",
			slog.Any("host.ip", []float64{0.5, 1e21}),
			attribute.Float64Slice("host.ip", []float64{0.5, 1e21}),
		},
		{
			"bool slice",
			slog.Any("host.ip", []bool{true, false}),
			attribute.BoolSlice("host.ip", []bool{true, false}),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			exp := tracetest.NewInMemoryExporter()
			var console bytes.Buffer
			sdk, err := o11y.New(context.Background(),
				o11y.WithServiceName("pii"), o11y.WithEnvironment(spec.EnvironmentTest),
				o11y.WithoutOTELEnv(), o11y.WithoutRuntimeMetrics(), o11y.WithoutLogExport(),
				o11y.WithConsoleWriter(&console), o11y.WithTraceExporter(exp),
				o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })

			sdk.Logger().LogAttrs(context.Background(), slog.LevelInfo, "m", tc.log)
			_, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op")
			span.SetAttributes(tc.span)
			span.End()
			if err := sdk.ForceFlush(context.Background()); err != nil {
				t.Fatalf("ForceFlush: %v", err)
			}

			recs := consoleRecords(t, &console)
			if len(recs) != 1 {
				t.Fatalf("got %d console records", len(recs))
			}
			logToken, _ := recs[0]["host.ip"].(string)
			spans := exp.GetSpans()
			if len(spans) != 1 {
				t.Fatalf("got %d spans", len(spans))
			}
			var spanToken string
			for _, kv := range spans[0].Attributes {
				if kv.Key == "host.ip" {
					spanToken = kv.Value.AsString()
				}
			}
			if !strings.HasPrefix(logToken, tokenPrefix) {
				t.Fatalf("log host.ip = %q, want a token", logToken)
			}
			if logToken != spanToken {
				t.Errorf("log token %q != span token %q for the same value", logToken, spanToken)
			}
		})
	}
}
