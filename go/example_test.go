package o11y_test

import (
	"context"
	"fmt"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

func ExampleNew() {
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("checkout"),
		o11y.WithEnvironment(spec.EnvironmentProduction),
		o11y.WithoutOTELEnv(), // keep the example hermetic; real services omit this
		o11y.WithoutConsoleLog(),
		o11y.WithoutRuntimeMetrics(),
	)
	if err != nil {
		fmt.Println(err)
		return
	}
	defer func() { _ = sdk.Shutdown(context.Background()) }()
	fmt.Println("ready")
	// Output: ready
}
