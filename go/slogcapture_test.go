package o11y_test

import (
	"context"
	"log/slog"
	"sync"
)

type slogCapture struct {
	mu      *sync.Mutex
	records *[]slog.Record
}

// newSlogCapture returns a concurrency-safe extra sink and a snapshot func.
func newSlogCapture() (slog.Handler, func() []slog.Record) {
	var mu sync.Mutex
	var records []slog.Record
	h := slogCapture{mu: &mu, records: &records}
	return h, func() []slog.Record {
		mu.Lock()
		defer mu.Unlock()
		return append([]slog.Record(nil), records...)
	}
}

func (c slogCapture) Enabled(context.Context, slog.Level) bool { return true }
func (c slogCapture) Handle(_ context.Context, r slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	*c.records = append(*c.records, r.Clone())
	return nil
}
func (c slogCapture) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c slogCapture) WithGroup(string) slog.Handler      { return c }
