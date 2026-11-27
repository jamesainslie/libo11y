package o11yrum

import (
	"testing"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

func TestKeysAreDefinedBySpec(t *testing.T) {
	for _, k := range specKeys {
		if _, ok := rumspec.Types[k]; ok {
			continue
		}
		if _, ok := rumspec.Sensitivities[k]; ok {
			continue
		}
		t.Errorf("%s is neither defined nor classified by spec %s", k, rumspec.SpecVersion)
	}
	for _, e := range []string{eventViewSummary, eventRUMError} {
		if _, ok := rumspec.Events[e]; !ok {
			t.Errorf("event %s is not registered", e)
		}
	}
	for _, m := range standardMetrics {
		if _, ok := rumspec.Metrics[m]; !ok {
			t.Errorf("metric %s is not registered", m)
		}
	}
}
