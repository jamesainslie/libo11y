package o11y

import (
	"context"
	"log/slog"
	"sync"
)

type recordKey struct{}

// Record accumulates attributes over the life of a request into one wide
// event (a canonical log line): the single, analytically rich record
// emitted once per request instead of many scattered logs. It is safe for
// concurrent use, since request handling may fan out across goroutines.
type Record struct {
	mu    sync.Mutex
	attrs map[string]slog.Value
	order []string
}

// StartRecord attaches a fresh [Record] to ctx and returns both. Middleware
// (see o11yhttp.WithCanonicalLine) starts one per request and flushes it as
// an event at request end; application code enriches it via
// [RecordFromContext].
func StartRecord(ctx context.Context) (context.Context, *Record) {
	r := &Record{attrs: map[string]slog.Value{}}
	return context.WithValue(ctx, recordKey{}, r), r
}

// RecordFromContext returns the [Record] attached to ctx, or a detached
// no-op Record when none is present, so call sites never need a nil check.
func RecordFromContext(ctx context.Context) *Record {
	if r, ok := ctx.Value(recordKey{}).(*Record); ok {
		return r
	}
	return &Record{attrs: map[string]slog.Value{}}
}

// Set records or overwrites attributes on the wide event.
func (r *Record) Set(attrs ...slog.Attr) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range attrs {
		if _, seen := r.attrs[a.Key]; !seen {
			r.order = append(r.order, a.Key)
		}
		r.attrs[a.Key] = a.Value
	}
}

// Add increments an integer counter on the wide event, creating it at delta
// if absent. Useful for per-request tallies (queries issued, retries, bytes).
func (r *Record) Add(key string, delta int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	current := int64(0)
	if v, ok := r.attrs[key]; ok && v.Kind() == slog.KindInt64 {
		current = v.Int64()
	} else if !ok {
		r.order = append(r.order, key)
	}
	r.attrs[key] = slog.Int64Value(current + delta)
}

// Max records the larger of the existing and new value for key (for example
// the slowest downstream call in a request).
func (r *Record) Max(key string, v float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.attrs[key]; ok && existing.Kind() == slog.KindFloat64 {
		if existing.Float64() >= v {
			return
		}
	} else if !ok {
		r.order = append(r.order, key)
	}
	r.attrs[key] = slog.Float64Value(v)
}

// snapshot returns the accumulated attributes in insertion order.
func (r *Record) snapshot() []slog.Attr {
	r.mu.Lock()
	defer r.mu.Unlock()
	attrs := make([]slog.Attr, 0, len(r.order))
	for _, key := range r.order {
		attrs = append(attrs, slog.Attr{Key: key, Value: r.attrs[key]})
	}
	return attrs
}

// EmitEvent flushes the accumulated wide event under the given event name
// through sdk. Additional attrs are appended (they win over accumulated
// ones by later position). Intended to be deferred so it fires even if the
// handler panics.
func (r *Record) EmitEvent(ctx context.Context, sdk *SDK, name string, attrs ...slog.Attr) {
	sdk.Event(ctx, name, append(r.snapshot(), attrs...)...)
}
