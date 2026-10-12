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
	defer cancel()
	ready := make(chan net.Addr, 1)
	done := make(chan error, 1)
	go func() { done <- run(ctx, "127.0.0.1:0", func(a net.Addr) { ready <- a }) }()

	var addr net.Addr
	select {
	case addr = <-ready:
	case err := <-done:
		t.Fatalf("run exited before serving: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("server did not start within 10s")
	}
	resp, err := http.Get("http://" + addr.String() + "/users/42")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "hello, user 42") {
		t.Fatalf("GET /users/42 = %d %q", resp.StatusCode, body)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run returned %v after shutdown", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("run did not stop within 15s")
	}
}

func TestExampleRequiresEnvironment(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")
	err := run(context.Background(), "127.0.0.1:0", nil)
	if !errors.Is(err, o11y.ErrNoEnvironment) {
		t.Fatalf("run error = %v, want ErrNoEnvironment", err)
	}
}
