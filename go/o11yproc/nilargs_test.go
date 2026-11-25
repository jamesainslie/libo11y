package o11yproc_test

import (
	"context"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yproc"
)

func TestNilArgumentsDoNotPanic(t *testing.T) {
	sdk := newSDK(t)
	ctx, _ := sampledContext(t, sdk)
	for name, opts := range map[string][]o11yproc.Option{
		"nil option":   {nil},
		"WithSDK nil":  {o11yproc.WithSDK(nil)},
		"WithSDK zero": {o11yproc.WithSDK(&o11y.SDK{})},
		"live SDK":     {o11yproc.WithSDK(sdk)},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panicked: %v", r)
				}
			}()
			o11yproc.Inject(ctx, nil, opts...)
			_ = o11yproc.Extract(context.Background(), nil, opts...)
			frame := map[string]string{}
			o11yproc.Inject(ctx, frame, opts...)
			_ = o11yproc.Extract(context.Background(), frame, opts...)
		})
	}
	if env := o11yproc.Env(context.Background()); env != nil {
		t.Errorf("Env outside a span = %v, want nil", env)
	}
}
