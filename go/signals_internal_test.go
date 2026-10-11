package o11y

import (
	"context"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestShutdownOnChannelSignal(t *testing.T) {
	sdk, err := New(context.Background(), WithServiceName("sig"), WithEnvironment("test"),
		WithoutOTELEnv(), WithoutConsoleLog(), WithoutRuntimeMetrics())
	if err != nil {
		t.Fatal(err)
	}
	sig := make(chan os.Signal, 1)
	done := make(chan error, 1)
	go func() { done <- sdk.shutdownOn(context.Background(), sig) }()
	sig <- syscall.SIGUSR1
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("shutdownOn: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdownOn did not return after a signal")
	}
}
