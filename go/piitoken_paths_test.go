package o11y_test

import (
	"context"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
)

// TestPIITokenOfLongStringArrayAgreesAcrossPaths pins the point of the
// bounded scalar-slice rendering: a string array past the walk budget
// tokenizes the same under PIIHash on the slog path, on a span attribute,
// and on a record from another log bridge.
func TestPIITokenOfLongStringArrayAgreesAcrossPaths(t *testing.T) {
	t.Parallel()
	strs := make([]string, o11y.CompositeWalkBudget)
	for i := range strs {
		strs[i] = string("abcdefghij"[i%10])
	}
	// The key of conformance/vectors/pii-hash.json, so the token can be
	// checked against the "string array past the walk budget" vector.
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	const vectorToken = "hmac-sha256:ebe37915a400148972d082ce883b0c08"
	logs := &memLogExporter{}
	spans := tracetest.NewInMemoryExporter()
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(logs), o11y.WithTraceExporter(keptSpanExporter{spans}),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(key))
	ctx := context.Background()

	sdk.Logger().InfoContext(ctx, "via slog", slog.Any("host.ip", strs))

	var rec log.Record
	rec.SetBody(attribute.StringValue("via bridge"))
	rec.AddAttributes(attribute.StringSlice("host.ip", strs))
	sdk.LoggerProvider().Logger("thirdparty").Emit(ctx, rec)

	_, span := sdk.TracerProvider().Tracer("t").Start(ctx, "op")
	span.SetAttributes(attribute.StringSlice("host.ip", strs))
	span.End()
	if err := sdk.ForceFlush(ctx); err != nil {
		t.Fatal(err)
	}

	tokens := map[string]string{}
	for _, r := range logs.snapshot() {
		tokens["otlp log: "+r.Body().AsString()] = exportedAttrs(r)["host.ip"].AsString()
	}
	for _, s := range spans.GetSpans() {
		for _, kv := range s.Attributes {
			if kv.Key == "host.ip" {
				tokens["span"] = kv.Value.AsString()
			}
		}
	}
	for _, r := range consoleRecords(t, console) {
		if r["msg"] == "via slog" {
			tokens["console"], _ = r["host.ip"].(string)
		}
	}
	if len(tokens) != 4 {
		t.Fatalf("tokens = %v, want the slog OTLP leg, the bridge, the span, and the console", tokens)
	}
	var first string
	for path, token := range tokens {
		if token != vectorToken {
			t.Errorf("%s: token %q, want the vector's %q", path, token, vectorToken)
		}
		if first == "" {
			first = token
		} else if token != first {
			t.Errorf("tokens differ across paths: %v", tokens)
			break
		}
	}
}
