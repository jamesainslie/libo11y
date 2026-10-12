package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	o11y "github.com/jamesainslie/libo11y/go"
)

func TestExampleStartsServesAndStops(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=development")
	t.Setenv("OTEL_TRACES_EXPORTER", "none")
	t.Setenv("OTEL_METRICS_EXPORTER", "none")
	t.Setenv("OTEL_LOGS_EXPORTER", "none")
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan net.Addr, 1)
	done := make(chan error, 1)
	go func() { done <- run(ctx, "127.0.0.1:0", func(a net.Addr) { ready <- a }) }()

	// On any early exit, stop run and wait for it so no listener or
	// telemetry pipeline outlives the test.
	stopped := false
	t.Cleanup(func() {
		cancel()
		if stopped {
			return
		}
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("run did not stop within 15s of cleanup")
		}
	})

	var addr net.Addr
	select {
	case addr = <-ready:
	case err := <-done:
		stopped = true
		t.Fatalf("run exited before serving: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("server did not start within 10s")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + addr.String() + "/users/42")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("reading response body: %v", err)
	}
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "hello, user 42") {
		t.Fatalf("GET /users/42 = %d %q", resp.StatusCode, body)
	}
	cancel()
	select {
	case err := <-done:
		stopped = true
		if err != nil {
			t.Fatalf("run returned %v after shutdown", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("run did not stop within 15s")
	}
}

func TestExampleRequiresEnvironment(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")
	// Bounded: if Setup ever stopped requiring an environment, run would
	// serve until ctx ends instead of hanging the test binary.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := run(ctx, "127.0.0.1:0", nil)
	if !errors.Is(err, o11y.ErrNoEnvironment) {
		t.Fatalf("run error = %v, want ErrNoEnvironment", err)
	}
}
