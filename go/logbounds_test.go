package o11y_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// emitBridgeRecord emits one record with attrs through the SDK's
// LoggerProvider, as a log bridge other than slog would, and returns the
// record the exporter received.
func emitBridgeRecord(t *testing.T, sdk *o11y.SDK, exp *memLogExporter, attrs ...attribute.KeyValue) sdklog.Record {
	t.Helper()
	var rec log.Record
	rec.SetBody(attribute.StringValue("m"))
	rec.AddAttributes(attrs...)
	sdk.LoggerProvider().Logger("thirdparty").Emit(context.Background(), rec)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	recs := exp.snapshot()
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1", len(recs))
	}
	return recs[0]
}

// exportedAttrs returns every attribute of r keyed by name.
func exportedAttrs(r sdklog.Record) map[attribute.Key]attribute.Value {
	out := map[attribute.Key]attribute.Value{}
	r.WalkAttributes(func(kv attribute.KeyValue) bool {
		out[kv.Key] = kv.Value
		return true
	})
	return out
}

// TestBridgeWalkFailsClosedPastDepthBound pins the depth bound on the
// bridge path: a map nested deeper than the bound is dropped from where the
// bound is reached, so neither a secret-classified key nor anything else at
// the bottom reaches the exporter, while the levels above it survive.
func TestBridgeWalkFailsClosedPastDepthBound(t *testing.T) {
	t.Parallel()
	levels := o11y.MaxCompositeDepth + 4
	secretKey := "deep" + strings.Repeat(".n", levels) + ".test.secret"

	bottom := attribute.MapValue(
		attribute.String("test.secret", "s3cr3t-at-the-bottom"),
		attribute.String("sentinel", "unexamined-bottom"),
	)
	v := bottom
	for i := levels - 1; i >= 0; i-- {
		v = attribute.MapValue(attribute.KeyValue{Key: "n", Value: v}, attribute.String("level", fmt.Sprint(i)))
	}

	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp),
		o11y.WithSensitivityForTest(map[attribute.Key]spectables.Sensitivity{attribute.Key(secretKey): spectables.Secret}))
	got := exportedAttrs(emitBridgeRecord(t, sdk, exp,
		attribute.KeyValue{Key: "deep", Value: v}, attribute.String("safe", "ok")))

	deep := got["deep"].String()
	// The proof of the bound: an unclassified value below it is dropped,
	// not forwarded unexamined. Before the bound existed it reached the
	// exporter.
	if strings.Contains(deep, "unexamined-bottom") {
		t.Errorf("value past the depth bound reached the exporter: %s", deep)
	}
	// The secret below the bound must not leak either. This check passed
	// before the fix too, because the unbounded walk reached the secret
	// key and dropped it; it stays as a guard on the fail-closed drop.
	if strings.Contains(deep, "s3cr3t-at-the-bottom") {
		t.Errorf("secret past the depth bound reached the exporter: %s", deep)
	}
	if !strings.Contains(deep, `"level":"0"`) {
		t.Errorf("levels above the bound were lost: %s", deep)
	}
	if got["safe"].AsString() != "ok" {
		t.Errorf("unclassified attribute lost: %v", got)
	}
}

// TestBridgeWalkFailsClosedPastNodeBudget pins the node budget on the
// bridge path: a map wider than the budget keeps only the members the walk
// examined and drops the rest.
func TestBridgeWalkFailsClosedPastNodeBudget(t *testing.T) {
	t.Parallel()
	width := o11y.CompositeWalkBudget + 500
	members := make([]attribute.KeyValue, width)
	for i := range members {
		members[i] = attribute.String(fmt.Sprintf("k%05d", i), "v")
	}

	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp))
	got := exportedAttrs(emitBridgeRecord(t, sdk, exp,
		attribute.KeyValue{Key: "wide", Value: attribute.MapValue(members...)}, attribute.String("safe", "ok")))

	n := len(got["wide"].AsMap())
	if n == 0 || n >= o11y.CompositeWalkBudget {
		t.Errorf("wide map kept %d of %d members, want some but fewer than the budget %d",
			n, width, o11y.CompositeWalkBudget)
	}
	if got["safe"].AsString() != "ok" {
		t.Errorf("unclassified attribute lost: %v", got)
	}
}

// TestBridgeWalkLeavesShallowRecordsUnchanged pins that the bounds do not
// touch ordinary records: nested maps and slices within the bounds, and a
// wide slice of scalars, are exported exactly as emitted.
func TestBridgeWalkLeavesShallowRecordsUnchanged(t *testing.T) {
	t.Parallel()
	scalars := make([]attribute.Value, o11y.CompositeWalkBudget+10)
	for i := range scalars {
		scalars[i] = attribute.IntValue(i)
	}
	want := []attribute.KeyValue{
		{Key: "req", Value: attribute.MapValue(
			attribute.String("method", "GET"),
			attribute.KeyValue{Key: "inner", Value: attribute.MapValue(attribute.Int("n", 1))},
		)},
		{Key: "list", Value: attribute.SliceValue(
			attribute.MapValue(attribute.String("name", "a")),
			attribute.StringValue("b"),
		)},
		{Key: "ids", Value: attribute.SliceValue(scalars...)},
		attribute.String("safe", "ok"),
	}

	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp))
	got := exportedAttrs(emitBridgeRecord(t, sdk, exp, want...))

	for _, kv := range want {
		if g, ok := got[kv.Key]; !ok || g.String() != kv.Value.String() {
			t.Errorf("%s = %s, want %s", kv.Key, g.String(), kv.Value.String())
		}
	}
}

// TestBridgePIITokenOfSharedDeepMapIsDeterministic is the reviewed
// reproduction: a map 22 levels deep that holds each level under two keys,
// emitted through the LoggerProvider under a PII key with PIIHash. The
// library's own walk is bounded (TestCanonicalAttrIsBounded times it); the
// emit as a whole is not timed here, because sdk/log's attribute
// deduplication walks the full value inside Emit, before any processor
// runs. The token must be the same every time.
func TestBridgePIITokenOfSharedDeepMapIsDeterministic(t *testing.T) {
	t.Parallel()
	v := attribute.MapValue(attribute.String("leaf", "10.0.0.1"))
	for range 22 {
		v = attribute.MapValue(attribute.KeyValue{Key: "a", Value: v}, attribute.KeyValue{Key: "b", Value: v})
	}
	exp := &memLogExporter{}
	sdk, _, _, _ := newHermetic(t, o11y.WithLogExporter(exp),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	for range 2 {
		var rec log.Record
		rec.SetBody(attribute.StringValue("m"))
		rec.AddAttributes(attribute.KeyValue{Key: "host.ip", Value: v})
		sdk.LoggerProvider().Logger("thirdparty").Emit(context.Background(), rec)
	}
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	recs := exp.snapshot()
	if len(recs) != 2 {
		t.Fatalf("got %d records, want 2", len(recs))
	}
	first, second := exportedAttrs(recs[0])["host.ip"], exportedAttrs(recs[1])["host.ip"]
	if first.Type() != attribute.STRING || first.AsString() != second.AsString() {
		t.Errorf("tokens %v and %v, want one string token", first, second)
	}
}
