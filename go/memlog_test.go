package o11y_test

import (
	"context"
	"sync"

	"go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

// memLogExporter captures exported OTLP log records in memory.
type memLogExporter struct {
	mu      sync.Mutex
	records []sdklog.Record
}

func (e *memLogExporter) Export(_ context.Context, records []sdklog.Record) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, r := range records {
		e.records = append(e.records, r.Clone())
	}
	return nil
}

func (e *memLogExporter) Shutdown(context.Context) error   { return nil }
func (e *memLogExporter) ForceFlush(context.Context) error { return nil }

func (e *memLogExporter) snapshot() []sdklog.Record {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]sdklog.Record(nil), e.records...)
}

// logAttrs flattens a record's attributes to dotted keys, walking map values
// so grouped attributes appear under their effective names.
func logAttrs(r sdklog.Record) map[string]string {
	out := map[string]string{}
	var walk func(prefix string, kv log.KeyValue)
	walk = func(prefix string, kv log.KeyValue) {
		key := kv.Key
		if prefix != "" {
			key = prefix + "." + key
		}
		if kv.Value.Kind() == log.KindMap {
			for _, member := range kv.Value.AsMap() {
				walk(key, member)
			}
			return
		}
		out[key] = kv.Value.String()
	}
	r.WalkAttributes(func(kv log.KeyValue) bool {
		walk("", kv)
		return true
	})
	return out
}
