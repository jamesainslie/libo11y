package o11y_test

import (
	"bytes"
	"context"
	"log"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	o11y "github.com/jamesainslie/libo11y/go"
)

// inertLogChild names the environment variable that makes the test binary
// act as the child process of TestInertHandlerIsSafeAsWrappedDefault.
const inertLogChild = "O11Y_TEST_INERT_LOG_CHILD"

// wrapping is a host's own handler around another, as hosts write to add
// context attributes.
type wrapping struct{ inner slog.Handler }

func (w wrapping) Enabled(ctx context.Context, l slog.Level) bool { return w.inner.Enabled(ctx, l) }
func (w wrapping) Handle(ctx context.Context, r slog.Record) error {
	r.AddAttrs(slog.String("wrapped", "yes"))
	return w.inner.Handle(ctx, r)
}
func (w wrapping) WithAttrs(a []slog.Attr) slog.Handler { return wrapping{w.inner.WithAttrs(a)} }
func (w wrapping) WithGroup(n string) slog.Handler      { return wrapping{w.inner.WithGroup(n)} }

// TestInertHandlerIsSafeAsWrappedDefault pins that the inert handle's
// handler can be wrapped and installed as the slog default without the log
// package routing records back into it, which used to hang the first log
// call, and that the host still sees its logs. It runs in a child process
// so a hang is a timeout, not a stuck test binary, and so the child's
// stderr can be read.
func TestInertHandlerIsSafeAsWrappedDefault(t *testing.T) {
	if mode := os.Getenv(inertLogChild); mode != "" {
		inertLogChildMain(mode)
		return
	}
	for _, mode := range []string{"nil", "zero"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestInertHandlerIsSafeAsWrappedDefault$")
			cmd.Env = append(os.Environ(), inertLogChild+"="+mode)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			err := cmd.Run()
			if ctx.Err() != nil {
				t.Fatalf("logging through the wrapped inert handler hung; stderr: %s", stderr.String())
			}
			if err != nil {
				t.Fatalf("child failed: %v; stderr: %s", err, stderr.String())
			}
			for _, want := range []string{
				"msg=via-wrapped-default wrapped=yes",
				"via-log-package",
				"msg=via-inert-logger",
			} {
				if !strings.Contains(stderr.String(), want) {
					t.Errorf("stderr lacks %q: %s", want, stderr.String())
				}
			}
		})
	}
}

// inertLogChildMain logs through the inert handle the way a host that
// carries on after a failed Setup might.
func inertLogChildMain(mode string) {
	var sdk *o11y.SDK
	if mode == "zero" {
		sdk = &o11y.SDK{}
	}
	slog.SetDefault(slog.New(wrapping{sdk.Handler()}))
	slog.Info("via-wrapped-default")
	log.Print("via-log-package")
	sdk.Logger().Info("via-inert-logger")
}
