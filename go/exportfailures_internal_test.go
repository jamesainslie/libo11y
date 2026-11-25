package o11y

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// sliceError is not comparable, so errors.Is cannot match it with ==.
type sliceError struct{ parts []string }

func (e sliceError) Error() string { return strings.Join(e.parts, ",") }

// TestFailureWindowDeduplicatesUncomparableErrors pins that an error the
// call returns and the window also recorded is reported once, even when
// its type is not comparable.
func TestFailureWindowDeduplicatesUncomparableErrors(t *testing.T) {
	f := &exportFailures{}
	failure := sliceError{parts: []string{"export", "rejected"}}
	err := f.during(context.Background(), func(context.Context) error {
		f.record(failure)
		return fmt.Errorf("flush: %w", failure)
	})
	if n := strings.Count(err.Error(), "export,rejected"); n != 1 {
		t.Errorf("error %q reports the failure %d times, want once", err, n)
	}
}

// TestFailureWindowKeepsFirstDistinctErrors pins the window's bound: the
// first maxWindowErrors distinct errors are kept, repeats are not, and the
// rest are counted.
func TestFailureWindowKeepsFirstDistinctErrors(t *testing.T) {
	f := &exportFailures{}
	err := f.during(context.Background(), func(context.Context) error {
		for i := range 100 {
			f.record(fmt.Errorf("failure %d", i))
			f.record(fmt.Errorf("failure %d", 0)) // a repeat of the first
		}
		return nil
	})
	msg := err.Error()
	for i := range maxWindowErrors {
		if !strings.Contains(msg, fmt.Sprintf("failure %d\n", i)) && !strings.HasSuffix(msg, fmt.Sprintf("failure %d", i)) {
			t.Errorf("error lacks the kept failure %d: %q", i, msg)
		}
	}
	if strings.Contains(msg, fmt.Sprintf("failure %d\n", maxWindowErrors)) {
		t.Errorf("error keeps more than %d failures: %q", maxWindowErrors, msg)
	}
	if want := fmt.Sprintf("%d more failed exports", 200-maxWindowErrors); !strings.Contains(msg, want) {
		t.Errorf("error = %q, want it to count the rest as %q", msg, want)
	}
}

// TestFailureWindowCountsOneInTheSingular pins the wording for exactly one
// failed export past the kept ones.
func TestFailureWindowCountsOneInTheSingular(t *testing.T) {
	f := &exportFailures{}
	err := f.during(context.Background(), func(context.Context) error {
		for i := range maxWindowErrors + 1 {
			f.record(fmt.Errorf("failure %d", i))
		}
		return nil
	})
	if msg := err.Error(); !strings.HasSuffix(msg, "o11y: 1 more failed export") {
		t.Errorf("error = %q, want it to end with the singular count", msg)
	}
}
