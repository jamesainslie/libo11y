package o11y

import (
	"fmt"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
)

// sharedDeepMap returns a map value levels deep in which every level holds
// the level below under two keys. It has no cycle, but walking it in full
// visits 2^levels leaves.
func sharedDeepMap(levels int) attribute.Value {
	v := attribute.MapValue(attribute.String("leaf", "10.0.0.1"))
	for range levels {
		v = attribute.MapValue(attribute.KeyValue{Key: "a", Value: v}, attribute.KeyValue{Key: "b", Value: v})
	}
	return v
}

// TestCanonicalAttrIsBounded pins that the canonical form of a bridge
// attribute value, which a PII token hashes, is bounded by the same depth
// bound and node budget as the slog path: a shared, deeply nested map
// renders quickly, truncated, and the same way every time.
func TestCanonicalAttrIsBounded(t *testing.T) {
	v := sharedDeepMap(22)
	w := newCompositeWalk()
	first := renderCanonical(attrNode(v, 0, w))
	// The budget, not the 2^22 leaves, bounds the work: the walk spent its
	// budget, and every node it rendered fits a small, fixed output.
	if w.budget >= 0 {
		t.Errorf("walk left %d of its budget, want it spent on this value", w.budget)
	}
	if len(first) > 64<<10 {
		t.Errorf("canonical form is %d bytes, want at most 64 KiB", len(first))
	}
	if !strings.Contains(first, canonicalTruncated) {
		t.Errorf("canonical form of an over-budget value is not truncated: %.200s", first)
	}
	if second := canonicalAttr(v); second != first {
		t.Error("canonical form differs between two renderings of one value")
	}
}

// TestCanonicalAttrMatchesAnyNodeWithinBounds pins that a shallow value
// renders the same canonical form on the bridge and slog paths.
func TestCanonicalAttrMatchesAnyNodeWithinBounds(t *testing.T) {
	v := attribute.MapValue(attribute.String("b", "2"), attribute.KeyValue{Key: "a", Value: attribute.SliceValue(attribute.IntValue(1))})
	got := canonicalAttr(v)
	want := canonicalAny(map[string]any{"b": "2", "a": []any{1}})
	if got != want {
		t.Errorf("canonicalAttr = %s, want %s", got, want)
	}
}

// TestCanonicalScalarSliceMatchesSlogPath pins that a scalar slice longer
// than the node budget renders the same canonical form, and so the same
// PII token, on the bridge path as on the slog path, which spends one node
// per element.
func TestCanonicalScalarSliceMatchesSlogPath(t *testing.T) {
	strs := make([]string, compositeWalkBudget+100)
	vals := make([]attribute.Value, len(strs))
	for i := range strs {
		strs[i] = fmt.Sprintf("v%d", i)
		vals[i] = attribute.StringValue(strs[i])
	}
	want := canonicalAny(strs)
	if !strings.Contains(want, canonicalTruncated) {
		t.Fatalf("the slog path did not truncate a slice past the budget")
	}
	for name, v := range map[string]attribute.Value{
		"STRINGSLICE": attribute.StringSliceValue(strs),
		"SLICE":       attribute.SliceValue(vals...),
	} {
		if got := canonicalAttr(v); got != want {
			t.Errorf("%s canonical form differs from the slog path's (%d and %d bytes)", name, len(got), len(want))
		}
	}
}
