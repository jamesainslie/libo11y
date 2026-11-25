package o11y

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"

	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// maxWindowErrors is how many distinct export errors one Shutdown or
// ForceFlush call reports in full. Every further failed export during the
// call, a repeat or a new error, is counted instead, so a collector that
// rejects every batch of a large backlog yields a short error.
const maxWindowErrors = 5

// exportFailures collects the export errors of one signal while a Shutdown
// or ForceFlush call is in progress, so the call can report them. The span
// and log batch processors export from their own goroutines and hand a
// failed export to the global error handler, not to the Shutdown or
// ForceFlush that triggered it; a batch the trace processor drains during
// Shutdown, or exports while a ForceFlush waits, is otherwise never
// reported to the caller.
//
// A window records every export that fails while it is open, whoever
// started the export: a background batch export the call did not start is
// included, and two overlapping calls each report the same failure.
//
// A successful export costs one nil check. A failed one loads the set of
// open windows atomically and adds to each under that window's own lock,
// which only failures and the closing call take. Opening and closing a
// window take mu. Errors are only observed: the exporter's caller, and so
// the error handler, receives each error unchanged.
type exportFailures struct {
	mu      sync.Mutex // serializes open and close
	windows atomic.Pointer[[]*failureWindow]
}

// failureWindow holds the errors recorded while it was open: the first
// maxWindowErrors distinct ones, and a count of the failed exports beyond
// them.
type failureWindow struct {
	mu   sync.Mutex
	errs []error
	keys []string
	more int
}

// errorKey identifies an error by its dynamic type and text, which works
// for every error type, comparable or not.
func errorKey(err error) string { return fmt.Sprintf("%T\x00%s", err, err.Error()) }

func (w *failureWindow) add(err error) {
	key := errorKey(err)
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.errs) < maxWindowErrors && !slices.Contains(w.keys, key) {
		w.errs = append(w.errs, err)
		w.keys = append(w.keys, key)
		return
	}
	w.more++
}

// open starts recording failures for one Shutdown or ForceFlush call.
// close must follow. A nil f records nothing.
func (f *exportFailures) open() *failureWindow {
	if f == nil {
		return nil
	}
	w := &failureWindow{}
	f.mu.Lock()
	defer f.mu.Unlock()
	var next []*failureWindow
	if cur := f.windows.Load(); cur != nil {
		next = slices.Clone(*cur)
	}
	next = append(next, w)
	f.windows.Store(&next)
	return w
}

// close stops recording into w and returns what it recorded.
func (f *exportFailures) close(w *failureWindow) (errs []error, keys []string, more int) {
	if f == nil || w == nil {
		return nil, nil, 0
	}
	f.mu.Lock()
	if cur := f.windows.Load(); cur != nil {
		next := slices.DeleteFunc(slices.Clone(*cur), func(o *failureWindow) bool { return o == w })
		f.windows.Store(&next)
	}
	f.mu.Unlock()
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.errs, w.keys, w.more
}

// record adds a failed export's error to every open window.
func (f *exportFailures) record(err error) {
	if err == nil || f == nil {
		return
	}
	cur := f.windows.Load()
	if cur == nil {
		return
	}
	for _, w := range *cur {
		w.add(err)
	}
}

// during runs call inside a window and returns its error joined with the
// failures recorded meanwhile that the error does not already carry, and
// a count of the failed exports beyond the first maxWindowErrors.
func (f *exportFailures) during(ctx context.Context, call func(context.Context) error) error {
	w := f.open()
	err := call(ctx)
	errs, keys, more := f.close(w)
	carried := treeKeys(err)
	for i, failure := range errs {
		if !slices.Contains(carried, keys[i]) {
			err = errors.Join(err, failure)
		}
	}
	switch {
	case more == 1:
		err = errors.Join(err, errors.New("o11y: 1 more failed export"))
	case more > 1:
		err = errors.Join(err, fmt.Errorf("o11y: %d more failed exports", more))
	}
	return err
}

// maxTreeKeys bounds how much of an error tree treeKeys walks.
const maxTreeKeys = 64

// treeKeys returns the errorKey of err and of every error it wraps, up to
// maxTreeKeys of them.
func treeKeys(err error) []string {
	var keys []string
	var walk func(error)
	walk = func(e error) {
		if e == nil || len(keys) >= maxTreeKeys {
			return
		}
		keys = append(keys, errorKey(e))
		switch u := e.(type) { //nolint:errorlint // the walk visits each level of the tree itself
		case interface{ Unwrap() error }:
			walk(u.Unwrap())
		case interface{ Unwrap() []error }:
			for _, inner := range u.Unwrap() {
				walk(inner)
			}
		}
	}
	walk(err)
	return keys
}

// observedSpanExporter reports every failed export to failures.
type observedSpanExporter struct {
	sdktrace.SpanExporter
	failures *exportFailures
}

func (e observedSpanExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	err := e.SpanExporter.ExportSpans(ctx, spans)
	e.failures.record(err)
	return err
}

// observedLogExporter reports every failed export to failures.
type observedLogExporter struct {
	sdklog.Exporter
	failures *exportFailures
}

func (e observedLogExporter) Export(ctx context.Context, records []sdklog.Record) error {
	err := e.Exporter.Export(ctx, records)
	e.failures.record(err)
	return err
}
