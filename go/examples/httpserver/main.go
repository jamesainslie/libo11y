// Command httpserver demonstrates libo11y in a realistic HTTP service:
// one-call setup, route-aware server instrumentation, an instrumented
// outbound client, capture-time redaction, and graceful shutdown.
//
// Run a collector (or nothing at all; export failures are non-fatal) and:
//
//	OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 go run .
//	curl localhost:8080/users/42
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/redact"
)

type user struct {
	ID    string
	Email string `o11y:"mask"`
	Token string `o11y:"redact"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	sdk, err := o11y.Setup(ctx,
		o11y.WithServiceName("httpserver-example"),
		o11y.WithServiceVersion("0.1.0"),
	)
	if err != nil {
		return fmt.Errorf("setting up telemetry: %w", err)
	}
	// Flush telemetry on the way out; a fresh context because ctx is
	// already canceled when shutdown begins.
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := sdk.Shutdown(shutdownCtx); err != nil {
			fmt.Fprintf(os.Stderr, "telemetry shutdown: %v\n", err)
		}
	}()

	// Outbound calls carry W3C trace context automatically.
	client := &http.Client{Transport: o11yhttp.NewTransport(nil)}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		u := user{ID: r.PathValue("id"), Email: "gopher@example.com", Token: "s3cr3t"}

		// Correlated (trace_id/span_id) on every sink; Email masked,
		// Token redacted at capture time.
		slog.InfoContext(r.Context(), "serving user", "user", redact.Struct(u))

		if _, err := fmt.Fprintf(w, "hello, user %s\n", u.ID); err != nil {
			slog.ErrorContext(r.Context(), "writing response", "error", err)
		}
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /fanout", func(w http.ResponseWriter, r *http.Request) {
		// Demonstrates context propagation on egress.
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://example.com", nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer func() {
			if err := resp.Body.Close(); err != nil {
				slog.WarnContext(r.Context(), "closing upstream body", "error", err)
			}
		}()
		if _, err := fmt.Fprintf(w, "upstream said %s\n", resp.Status); err != nil {
			slog.WarnContext(r.Context(), "writing response", "error", err)
		}
	})

	server := &http.Server{
		Addr: ":8080",
		Handler: o11yhttp.NewHandler(mux, "httpserver",
			o11yhttp.WithIgnorePaths("/healthz"),
		),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("server shutdown", "error", err)
		}
	}()

	slog.Info("listening", "addr", server.Addr)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serving: %w", err)
	}
	return nil
}
