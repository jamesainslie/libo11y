package o11yconnect_test

import (
	"context"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yconnect"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

func TestNilArgumentsDoNotPanic(t *testing.T) {
	for name, opts := range map[string][]o11yconnect.Option{
		"nil option":                   {nil},
		"WithSDK nil":                  {o11yconnect.WithSDK(nil)},
		"WithSDK zero":                 {o11yconnect.WithSDK(&o11y.SDK{})},
		"WithSDK zero, canonical line": {o11yconnect.WithSDK(&o11y.SDK{}), o11yconnect.WithCanonicalLine()},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panicked: %v", r)
				}
			}()
			interceptor, err := o11yconnect.ServerInterceptor(opts...)
			if err != nil {
				t.Fatalf("ServerInterceptor: %v", err)
			}
			fx := serve(t, o11ytest.Start(t), interceptor, nil)
			if err := fx.call(context.Background(), t, echoProcedure, "hi", opts...); err != nil {
				t.Errorf("call: %v", err)
			}
		})
	}
}
