package o11ytest

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// errorsTB captures Errorf calls so AssertConforms failures can be asserted.
type errorsTB struct {
	testing.TB
	mu     sync.Mutex
	errors []string
}

func (e *errorsTB) Helper() {}
func (e *errorsTB) Errorf(format string, args ...any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.errors = append(e.errors, fmt.Sprintf(format, args...))
}

// TestAssertConformsScansGroupedLogAttributes plants a record that bypassed
// redaction, standing in for a redaction regression, with the secret nested
// in a group. The clear-text scan must read the dotted key, as the
// library's classification does, rather than only the top-level group name.
func TestAssertConformsScansGroupedLogAttributes(t *testing.T) {
	rec := Start(t)
	record := slog.NewRecord(time.Now(), slog.LevelInfo, "planted", 0)
	record.AddAttrs(slog.Group("http", slog.Group("request.header", slog.String("authorization", "Bearer x"))))
	rec.logs.records = append(rec.logs.records, LogRecord{Record: record})

	tb := &errorsTB{TB: t}
	rec.AssertConforms(tb)
	joined := strings.Join(tb.errors, "\n")
	if want := `"http.request.header.authorization" in the clear`; !strings.Contains(joined, want) {
		t.Errorf("AssertConforms did not report %q; got %q", want, joined)
	}
}
