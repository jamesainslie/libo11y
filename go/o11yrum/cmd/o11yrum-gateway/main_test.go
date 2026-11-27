package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestVersionFlag(t *testing.T) {
	var out bytes.Buffer
	if code := run(context.Background(), []string{"-version"}, &out, io.Discard); code != 0 || strings.TrimSpace(out.String()) != "dev" {
		t.Fatalf("code %d out %q", code, out.String())
	}
}

func TestCheckConfig(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run(context.Background(), []string{"-check-config", "-config", "testdata/gateway.yaml"}, &out, &errOut); code != 0 {
		t.Fatalf("code %d: %s", code, errOut.String())
	}
	if strings.TrimSpace(out.String()) != "ok" {
		t.Errorf("stdout %q", out.String())
	}
	if code := run(context.Background(), []string{"-check-config", "-config", "testdata/missing.yaml"}, &out, &errOut); code != 1 {
		t.Fatalf("missing config: code %d", code)
	}
	if code := run(context.Background(), []string{}, &out, &errOut); code != 2 {
		t.Fatalf("no -config: code %d", code)
	}
	if code := run(context.Background(), []string{"-bogus"}, &out, io.Discard); code != 2 {
		t.Fatalf("unknown flag: code %d", code)
	}
}

func TestCheckConfigRefuses(t *testing.T) {
	const app = "apps:\n  - {service_name: a, origins: [\"https://a\"]}\n"
	for name, tc := range map[string]struct{ yaml, want string }{
		"no environment":      {app, "environment is required"},
		"unknown environment": {"environment: prod\n" + app, "environment \"prod\""},
		"bad sink":            {"environment: test\nsinks: {otlp: {endpoint: \"http://c:4318\", compression: zstd}}\n" + app, "compression"},
		"missing remote file": {"environment: test\napps:\n  - {service_name: a, origins: [\"https://a\"], remote_config_file: nope.json}\n", "remote config for a"},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "gateway.yaml")
			if err := os.WriteFile(path, []byte(tc.yaml), 0o600); err != nil {
				t.Fatal(err)
			}
			var errOut bytes.Buffer
			if code := run(context.Background(), []string{"-check-config", "-config", path}, io.Discard, &errOut); code != 1 {
				t.Fatalf("code %d", code)
			}
			if !strings.Contains(errOut.String(), tc.want) {
				t.Errorf("stderr %q, want it to mention %q", errOut.String(), tc.want)
			}
		})
	}
}

// writeConfig writes a gateway config listening on a free loopback port
// and exporting to collector.
func writeConfig(t *testing.T, collector string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "shop-web.json"), []byte(`{"sampleRate":0.1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := fmt.Sprintf(`listen: 127.0.0.1:0
environment: test
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    remote_config_file: shop-web.json
sinks:
  otlp:
    endpoint: %s
`, collector)
	path := filepath.Join(dir, "gateway.yaml")
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// waitForListening reads the gateway's stderr until it reports its
// address, then keeps draining it so the gateway never blocks writing.
func waitForListening(t *testing.T, r io.Reader) string {
	t.Helper()
	const marker = "o11yrum-gateway: listening on "
	found := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			if addr, ok := strings.CutPrefix(sc.Text(), marker); ok {
				select {
				case found <- addr:
				default:
				}
			}
		}
	}()
	select {
	case addr := <-found:
		return addr
	case <-time.After(10 * time.Second):
		t.Fatal("the gateway did not report its address within 10s")
		return ""
	}
}

func quietTelemetry(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "none")
	t.Setenv("OTEL_METRICS_EXPORTER", "none")
	t.Setenv("OTEL_LOGS_EXPORTER", "none")
}

func TestServeAndShutdown(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()
	quietTelemetry(t)
	cfg := writeConfig(t, collector.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"-config", cfg}, io.Discard, pw) }()
	addr := waitForListening(t, pr)
	base := "http://" + addr

	for _, path := range []string{"/healthz", "/readyz", "/_o11y/v1/config?service=shop-web"} {
		resp, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d", path, resp.StatusCode)
		}
	}

	body := `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"shop-web"}}]},` +
		`"scopeLogs":[{"logRecords":[{"body":{"stringValue":"hello"}}]}]}]}`
	req, err := http.NewRequest(http.MethodPost, base+"/_o11y/v1/logs", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://shop.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("logs: status %d", resp.StatusCode)
	}
	mu.Lock()
	got := strings.Join(paths, ",")
	mu.Unlock()
	if got != "/v1/logs" {
		t.Errorf("the collector received %q, want /v1/logs", got)
	}

	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the gateway did not shut down")
	}
}

func TestSinkEndpointFromEnvironment(t *testing.T) {
	quietTelemetry(t)
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318")
	path := filepath.Join(t.TempDir(), "gateway.yaml")
	if err := os.WriteFile(path, []byte("environment: test\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, sink, err := load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Sinks.OTLP.Endpoint != "http://collector.example:4318" || sink == nil {
		t.Fatalf("endpoint %q sink %v", cfg.Sinks.OTLP.Endpoint, sink)
	}
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	if _, sink, err = load(path); err != nil || sink != nil {
		t.Fatalf("without an endpoint: sink %v err %v", sink, err)
	}
}

func TestListenFailure(t *testing.T) {
	quietTelemetry(t)
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	path := filepath.Join(t.TempDir(), "gateway.yaml")
	cfg := fmt.Sprintf("listen: %s\nenvironment: test\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", ln.Addr())
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	var errOut bytes.Buffer
	if code := run(context.Background(), []string{"-config", path}, io.Discard, &errOut); code != 1 {
		t.Fatalf("code %d: %s", code, errOut.String())
	}
}

func TestServerLogRedactsPeerAddress(t *testing.T) {
	var out bytes.Buffer
	l := serverLog(&out)
	l.Printf("http: panic serving 203.0.113.5:41234: boom\ngoroutine 1 [running]:")
	l.Printf("http: TLS handshake error from [2001:db8::1]:443: EOF")
	l.Printf("http: Accept error: too many open files; retrying in 5ms")
	got := out.String()
	for _, addr := range []string{"203.0.113.5", "2001:db8::1"} {
		if strings.Contains(got, addr) {
			t.Errorf("the server log carries %s:\n%s", addr, got)
		}
	}
	for _, keep := range []string{"boom", "goroutine 1", "EOF", "too many open files"} {
		if !strings.Contains(got, keep) {
			t.Errorf("the server log lost %q:\n%s", keep, got)
		}
	}
}
