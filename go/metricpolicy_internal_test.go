package o11y

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// The SDK skips its lock around reservoirs that carry its concurrency
// marker, which only its built-in reservoirs do. The marker is an interface
// with an unexported method declared in the SDK's internal reservoir package,
// so code outside the SDK can neither name it in a type assertion nor see it
// through reflection (reflect lists exported methods only). The test
// therefore pins the mechanism that preserves it instead: the wrappers for
// the built-in types embed the original reservoir, which promotes the
// marker, and anything else gets the plain wrapper.
func TestFilterReservoirKeepsBuiltInReservoirTypes(t *testing.T) {
	policy := newSensitivityPolicy(newSettings(nil), nil)
	fixed := exemplar.NewFixedSizeReservoir(1)
	if r, ok := filterReservoir(fixed, policy).(filteredFixedSizeReservoir); !ok || r.FixedSizeReservoir != fixed {
		t.Errorf("fixed-size reservoir wrapped as %T, want filteredFixedSizeReservoir around it", filterReservoir(fixed, policy))
	}
	hist := exemplar.NewHistogramReservoir([]float64{1})
	if r, ok := filterReservoir(hist, policy).(filteredHistogramReservoir); !ok || r.HistogramReservoir != hist {
		t.Errorf("histogram reservoir wrapped as %T, want filteredHistogramReservoir around it", filterReservoir(hist, policy))
	}
	if _, ok := filterReservoir(customReservoir{}, policy).(filteredReservoir); !ok {
		t.Errorf("custom reservoir wrapped as %T, want filteredReservoir", filterReservoir(customReservoir{}, policy))
	}
}

func TestFilterReservoirDropsRejectedAttributes(t *testing.T) {
	s := newSettings([]Option{WithSensitivityForTest(map[attribute.Key]spectables.Sensitivity{"drop": spectables.Secret})})
	r := filterReservoir(exemplar.NewFixedSizeReservoir(1), newSensitivityPolicy(s, nil))
	r.Offer(context.Background(), time.Now(), exemplar.NewValue[int64](1),
		[]attribute.KeyValue{attribute.String("drop", "x"), attribute.String("keep", "y")})
	var got []exemplar.Exemplar
	r.Collect(&got)
	if len(got) != 1 || len(got[0].FilteredAttributes) != 1 || got[0].FilteredAttributes[0].Key != "keep" {
		t.Errorf("collected %+v, want one exemplar carrying only keep", got)
	}
}

type customReservoir struct{}

func (customReservoir) Offer(context.Context, time.Time, exemplar.Value, []attribute.KeyValue) {}
func (customReservoir) Collect(*[]exemplar.Exemplar)                                           {}
