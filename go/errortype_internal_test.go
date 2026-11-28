package o11y

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"testing"
)

type typedError struct{ msg string }

func (e *typedError) Error() string { return e.msg }

// errorType names the error that failed, looking through the wrappers
// fmt.Errorf and errors.Join add around a single error. A wrapper type from
// any other package is itself the answer.
func TestErrorTypeLooksThroughPlainWrappers(t *testing.T) {
	t.Parallel()
	typed := &typedError{"export refused"}
	cases := map[string]struct {
		err  error
		want string
	}{
		"nil":                     {nil, ""},
		"bare":                    {typed, "*o11y.typedError"},
		"errors.New":              {errors.New("plain"), "*errors.errorString"},
		"fmt.Errorf":              {fmt.Errorf("o11y: shutdown logs: %w", typed), "*o11y.typedError"},
		"fmt.Errorf twice":        {fmt.Errorf("a: %w", fmt.Errorf("b: %w", typed)), "*o11y.typedError"},
		"join of one":             {errors.Join(typed, nil), "*o11y.typedError"},
		"join inside fmt.Errorf":  {fmt.Errorf("a: %w", errors.Join(nil, typed)), "*o11y.typedError"},
		"join of two":             {errors.Join(typed, errors.New("other")), "*errors.joinError"},
		"fmt.Errorf of two":       {fmt.Errorf("%w and %w", typed, errors.New("other")), "*fmt.wrapErrors"},
		"deadline":                {fmt.Errorf("did not finish: %w", context.DeadlineExceeded), "context.deadlineExceededError"},
		"typed wrapper is kept":   {&url.Error{Op: "Post", URL: "http://collector", Err: typed}, "*url.Error"},
		"fmt.Errorf without wrap": {fmt.Errorf("no cause"), "*errors.errorString"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got := errorType(tc.err); got != tc.want {
				t.Errorf("errorType = %q, want %q", got, tc.want)
			}
		})
	}
}
