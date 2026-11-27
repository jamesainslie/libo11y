package o11yrum

import (
	"maps"
	"slices"

	"go.opentelemetry.io/collector/pdata/pcommon"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// shapeDetector recognises which RUM span shape a span claims. It keys on
// the generated shape table, rumspec.RUMSpanRequired, and never on a list
// of attribute names written here, so a registry change reaches it
// through regeneration alone.
//
// The specification names a span's shape with a marker attribute: an enum
// that every shape requires and whose members are the shape names. When
// the table has one, the marker's value is the shape. When it has none,
// as in a registry from before the marker, a shape is claimed by each
// required enum attribute that no other shape requires (o11y.rum.view.kind
// for view, o11y.rum.action.type for action). A shape with no such
// attribute, like app_load there, is never claimed and its spans fall
// under the base RUM rule.
type shapeDetector struct {
	marker string            // the shape marker attribute, when the table has one
	shapes map[string]bool   // the shapes the table defines
	claims map[string]string // claiming attribute -> shape, when it has none
}

// defaultShapes is the detector for the generated tables.
var defaultShapes = newShapeDetector(rumspec.RUMSpanRequired, rumspec.Enums)

func newShapeDetector(required, enums map[string][]string) shapeDetector {
	shapes := slices.Sorted(maps.Keys(required))
	defined := make(map[string]bool, len(shapes))
	for _, s := range shapes {
		defined[s] = true
	}
	count := map[string]int{}
	for _, s := range shapes {
		for _, k := range required[s] {
			count[k]++
		}
	}
	for _, k := range slices.Sorted(maps.Keys(count)) {
		if count[k] != len(shapes) {
			continue
		}
		members := enums[k]
		if len(members) > 0 && !slices.ContainsFunc(shapes, func(s string) bool { return !slices.Contains(members, s) }) {
			return shapeDetector{marker: k, shapes: defined}
		}
	}
	claims := map[string]string{}
	for _, s := range shapes {
		for _, k := range required[s] {
			if count[k] == 1 && len(enums[k]) > 0 {
				claims[k] = s
			}
		}
	}
	return shapeDetector{shapes: defined, claims: claims}
}

// shape returns the shape attrs claim. claimed with an empty shape means
// the span claims a shape the table does not define, or more than one,
// and cannot be valid.
func (d shapeDetector) shape(attrs pcommon.Map) (shape string, claimed bool) {
	if d.marker != "" {
		v, ok := attrs.Get(d.marker)
		if !ok {
			return "", false
		}
		if v.Type() == pcommon.ValueTypeStr && d.shapes[v.Str()] {
			return v.Str(), true
		}
		return "", true
	}
	for k, s := range d.claims {
		if _, ok := attrs.Get(k); !ok {
			continue
		}
		if claimed && shape != s {
			return "", true
		}
		shape, claimed = s, true
	}
	return shape, claimed
}
