package o11y

import (
	"fmt"
	"log/slog"
	"slices"
	"testing"

	"github.com/jamesainslie/libo11y/go/spec"
)

func attrKeys(attrs []slog.Attr) []string {
	keys := make([]string, len(attrs))
	for i, a := range attrs {
		keys[i] = a.Key
		if a.Key == "" {
			keys[i] = "(inline:" + a.Value.Group()[0].Key + ")"
		}
	}
	return keys
}

func TestEventAttrsPassInlineGroupsThrough(t *testing.T) {
	small := []slog.Attr{
		slog.Group("", slog.String("a", "1")),
		slog.String("k", "first"),
		slog.String(spec.EventNameKey, "spoofed"),
		slog.Group("", slog.String("b", "2")),
		slog.String("k", "last"),
	}
	large := slices.Clone(small)
	for i := range 6 {
		large = append(large, slog.Int(fmt.Sprintf("n%d", i), i))
	}
	for name, tc := range map[string]struct {
		in   []slog.Attr
		want []string
	}{
		"small": {small, []string{"(inline:a)", "(inline:b)", "k"}},
		"large": {large, []string{"(inline:a)", "(inline:b)", "k", "n0", "n1", "n2", "n3", "n4", "n5"}},
	} {
		t.Run(name, func(t *testing.T) {
			before := attrKeys(tc.in)
			got := eventAttrs(tc.in)
			if after := attrKeys(tc.in); !slices.Equal(before, after) {
				t.Errorf("input modified: %v became %v", before, after)
			}
			if keys := attrKeys(got); !slices.Equal(keys, tc.want) {
				t.Errorf("eventAttrs keys = %v, want %v", keys, tc.want)
			}
			for _, a := range got {
				if a.Key == "k" && a.Value.String() != "last" {
					t.Errorf("k = %q, want the last occurrence", a.Value.String())
				}
			}
		})
	}
}
