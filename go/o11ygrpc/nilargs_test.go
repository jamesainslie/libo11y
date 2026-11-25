package o11ygrpc_test

import (
	"testing"

	"google.golang.org/grpc/stats"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ygrpc"
)

func TestNilArgumentsDoNotPanic(t *testing.T) {
	for name, opts := range map[string][]o11ygrpc.Option{
		"nil option":   {nil},
		"WithSDK nil":  {o11ygrpc.WithSDK(nil)},
		"WithSDK zero": {o11ygrpc.WithSDK(&o11y.SDK{})},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panicked: %v", r)
				}
			}()
			for _, h := range []stats.Handler{o11ygrpc.ServerHandler(opts...), o11ygrpc.ClientHandler(opts...)} {
				driveRPC(h, "/svc.Svc/Do")
			}
		})
	}
}
