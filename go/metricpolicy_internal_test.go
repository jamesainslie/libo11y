package o11y

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
)

// The SDK skips its lock around reservoirs that carry its unexported
// concurrency marker, which only its built-in reservoirs do. The wrappers
// for those embed the original so the marker is promoted; anything else gets
// the plain wrapper.
func TestFilterReservoirKeepsBuiltInReservoirTypes(t *testing.T) {
	keep := func(attribute.KeyValue) bool { return true }
	fixed := exemplar.NewFixedSizeReservoir(1)
	if r, ok := filterReservoir(fixed, keep).(filteredFixedSizeReservoir); !ok || r.FixedSizeReservoir != fixed {
		t.Errorf("fixed-size reservoir wrapped as %T, want filteredFixedSizeReservoir around it", filterReservoir(fixed, keep))
	}
	hist := exemplar.NewHistogramReservoir([]float64{1})
	if r, ok := filterReservoir(hist, keep).(filteredHistogramReservoir); !ok || r.HistogramReservoir != hist {
		t.Errorf("histogram reservoir wrapped as %T, want filteredHistogramReservoir around it", filterReservoir(hist, keep))
	}
	if _, ok := filterReservoir(customReservoir{}, keep).(filteredReservoir); !ok {
		t.Errorf("custom reservoir wrapped as %T, want filteredReservoir", filterReservoir(customReservoir{}, keep))
	}
}

func TestFilterReservoirDropsRejectedAttributes(t *testing.T) {
	keep := func(kv attribute.KeyValue) bool { return kv.Key != "drop" }
	r := filterReservoir(exemplar.NewFixedSizeReservoir(1), keep)
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
