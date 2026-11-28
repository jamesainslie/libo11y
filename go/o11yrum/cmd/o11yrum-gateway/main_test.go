package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
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
// address, then keeps draining it so the gateway never blocks writing. On
// a timeout it reports what the gateway wrote, such as a startup error.
func waitForListening(t *testing.T, r io.Reader) string {
	t.Helper()
	return waitForAddresses(t, r, listeningMarker)[0]
}

// Lines the gateway writes when a listener is up.
const (
	listeningMarker     = "o11yrum-gateway: listening on "
	readListeningMarker = "o11yrum-gateway: replay read API listening on "
)

// waitForAddresses reads the gateway's stderr until it has written a line
// starting with each marker, and returns the rest of each line, in marker
// order. It keeps draining stderr afterwards.
func waitForAddresses(t *testing.T, r io.Reader, markers ...string) []string {
	t.Helper()
	type hit struct {
		i    int
		addr string
	}
	found := make(chan hit, len(markers))
	var mu sync.Mutex
	var lines []string
	go func() {
		sc := bufio.NewScanner(r)
		seen := make([]bool, len(markers))
		for sc.Scan() {
			mu.Lock()
			lines = append(lines, sc.Text())
			mu.Unlock()
			for i, m := range markers {
				if addr, ok := strings.CutPrefix(sc.Text(), m); ok && !seen[i] {
					seen[i] = true
					found <- hit{i, addr}
				}
			}
		}
	}()
	addrs := make([]string, len(markers))
	timeout := time.After(10 * time.Second)
	for range markers {
		select {
		case h := <-found:
			addrs[h.i] = h.addr
		case <-timeout:
			mu.Lock()
			defer mu.Unlock()
			t.Fatalf("the gateway did not report %q within 10s; stderr:\n%s", markers, strings.Join(lines, "\n"))
			return nil
		}
	}
	return addrs
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

// TestReadyzFailsWhenShutdownBegins checks that /readyz answers 503 from
// the moment shutdown begins, while the gateway keeps serving everything
// else for shutdown_delay so a load balancer can take it out of rotation
// before the listener closes.
func TestReadyzFailsWhenShutdownBegins(t *testing.T) {
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()
	quietTelemetry(t)
	cfg := writeConfig(t, collector.URL)
	f, err := os.OpenFile(cfg, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("shutdown_delay: 3s\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"-config", cfg}, io.Discard, pw) }()
	base := "http://" + waitForListening(t, pr)
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	status := func(path string) int {
		t.Helper()
		resp, err := client.Get(base + path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if got := status("/readyz"); got != http.StatusOK {
		t.Fatalf("/readyz before shutdown: status %d", got)
	}

	start := time.Now()
	cancel()
	deadline := time.Now().Add(time.Second)
	for status("/readyz") != http.StatusServiceUnavailable {
		if time.Now().After(deadline) {
			t.Fatal("/readyz did not answer 503 within 1s of shutdown beginning")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := status("/healthz"); got != http.StatusOK {
		t.Errorf("/healthz during the shutdown delay: status %d", got)
	}
	if got := status("/_o11y/v1/config?service=shop-web"); got != http.StatusOK {
		t.Errorf("config during the shutdown delay: status %d", got)
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the gateway did not shut down")
	}
	if elapsed := time.Since(start); elapsed < 3*time.Second {
		t.Errorf("the gateway exited %v after shutdown began, before its 3s shutdown_delay", elapsed)
	}
}

func TestResolveVersion(t *testing.T) {
	info := func(v string) *debug.BuildInfo {
		return &debug.BuildInfo{Main: debug.Module{Path: "github.com/jamesainslie/libo11y/go/o11yrum", Version: v}}
	}
	for name, tc := range map[string]struct {
		linked string
		info   *debug.BuildInfo
		want   string
	}{
		"linker flag wins":         {"v0.1.0", info("v0.0.9"), "v0.1.0"},
		"go install at a version":  {"dev", info("v0.1.0"), "v0.1.0"},
		"pseudo-version from vcs":  {"dev", info("v0.1.1-0.20261127000000-abcdefabcdef"), "v0.1.1-0.20261127000000-abcdefabcdef"},
		"devel build":              {"dev", info("(devel)"), "dev"},
		"no module version":        {"dev", info(""), "dev"},
		"no build info":            {"dev", nil, "dev"},
		"empty flag keeps default": {"", nil, "dev"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := resolveVersion(tc.linked, tc.info); got != tc.want {
				t.Errorf("resolveVersion(%q) = %q, want %q", tc.linked, got, tc.want)
			}
		})
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

func TestSinkFromEnvironmentHonoursProtocolAndHeaders(t *testing.T) {
	quietTelemetry(t)
	path := filepath.Join(t.TempDir(), "gateway.yaml")
	cfgYAML := "environment: test\napps:\n  - {service_name: a, origins: [\"https://a\"]}\nsinks: {otlp: {headers: {X-Scope-OrgID: from-config}}}\n"
	if err := os.WriteFile(path, []byte(cfgYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.example:4318")
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20abc,X-Scope-OrgID=from-env, X-Extra = 1 ")
	cfg, _, err := load(path)
	if err != nil {
		t.Fatal(err)
	}
	h := cfg.Sinks.OTLP.Headers
	if h["Authorization"] != "Basic abc" || h["X-Scope-OrgID"] != "from-config" || h["X-Extra"] != "1" {
		t.Errorf("headers %v", h)
	}

	for _, proto := range []string{"grpc", "http/json"} {
		t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", proto)
		if _, _, err := load(path); err == nil || !strings.Contains(err.Error(), proto) {
			t.Errorf("protocol %s: err = %v", proto, err)
		}
	}
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
	if _, _, err := load(path); err != nil {
		t.Errorf("http/protobuf: %v", err)
	}
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "")
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "novalue")
	if _, _, err := load(path); err == nil || !strings.Contains(err.Error(), "OTEL_EXPORTER_OTLP_HEADERS") {
		t.Errorf("malformed headers: err = %v", err)
	}
}

func TestShutdownBudgetFitsKubernetesGrace(t *testing.T) {
	if serverDrain+telemetryFlush >= 30*time.Second {
		t.Fatalf("draining (%v) and flushing (%v) exceed the default 30s grace period", serverDrain, telemetryFlush)
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

// viewSummaryBody is one valid o11y.rum.view.summary for shop-web, as
// OTLP/JSON.
const viewSummaryBody = `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"shop-web"}}]},` +
	`"scopeLogs":[{"logRecords":[{"eventName":"o11y.rum.view.summary","attributes":[` +
	`{"key":"o11y.rum.platform","value":{"stringValue":"web"}},` +
	`{"key":"o11y.rum.view.name","value":{"stringValue":"/"}},` +
	`{"key":"o11y.rum.view.kind","value":{"stringValue":"initial"}},` +
	`{"key":"o11y.rum.view.id","value":{"stringValue":"v0"}},` +
	`{"key":"session.id","value":{"stringValue":"s1"}},` +
	`{"key":"o11y.rum.summary.seq","value":{"intValue":"0"}},` +
	`{"key":"o11y.rum.summary.time_on_view","value":{"doubleValue":1.5}}]}]}]}]}`

// metricsCollector records the names of the metrics posted to /v1/metrics
// and accepts everything else.
type metricsCollector struct {
	mu    sync.Mutex
	names map[string]bool
	errs  []error
}

func (c *metricsCollector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer w.WriteHeader(http.StatusOK)
	if r.URL.Path != "/v1/metrics" {
		return
	}
	var body io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			c.fail(err)
			return
		}
		body = zr
	}
	raw, err := io.ReadAll(body)
	if err != nil {
		c.fail(err)
		return
	}
	req := pmetricotlp.NewExportRequest()
	if err := req.UnmarshalProto(raw); err != nil {
		c.fail(err)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	rms := req.Metrics().ResourceMetrics()
	for i := range rms.Len() {
		sms := rms.At(i).ScopeMetrics()
		for j := range sms.Len() {
			ms := sms.At(j).Metrics()
			for k := range ms.Len() {
				c.names[ms.At(k).Name()] = true
			}
		}
	}
}

func (c *metricsCollector) fail(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.errs = append(c.errs, err)
}

func (c *metricsCollector) seen(name string) (bool, []error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.names[name], slices.Clone(c.errs)
}

// TestFallbackProducerRegistered runs the command with its own metrics
// going to an OTLP collector and checks that the metrics the gateway
// derives from a view summary leave the process with them, both through
// the fallback producer and when OTEL_METRICS_PRODUCERS names o11yrum.
func TestFallbackProducerRegistered(t *testing.T) {
	for _, tc := range []struct{ name, producers string }{{"fallback", ""}, {"named", "o11yrum"}} {
		t.Run(tc.name, func(t *testing.T) {
			collector := &metricsCollector{names: map[string]bool{}}
			srv := httptest.NewServer(collector)
			defer srv.Close()
			t.Setenv("OTEL_TRACES_EXPORTER", "none")
			t.Setenv("OTEL_LOGS_EXPORTER", "none")
			t.Setenv("OTEL_METRICS_EXPORTER", "otlp")
			t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", srv.URL)
			t.Setenv("OTEL_METRIC_EXPORT_INTERVAL", "200")
			t.Setenv("OTEL_METRICS_PRODUCERS", tc.producers)
			cfg := writeConfig(t, srv.URL)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			pr, pw := io.Pipe()
			defer func() { _ = pw.Close() }()
			done := make(chan int, 1)
			go func() { done <- run(ctx, []string{"-config", cfg}, io.Discard, pw) }()
			base := "http://" + waitForListening(t, pr)

			req, err := http.NewRequest(http.MethodPost, base+"/_o11y/v1/logs", strings.NewReader(viewSummaryBody))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "https://shop.example")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			respBody, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil || resp.StatusCode != http.StatusOK {
				t.Fatalf("logs: status %d body %s err %v", resp.StatusCode, respBody, err)
			}
			lr := plogotlp.NewExportResponse()
			if err := lr.UnmarshalJSON(respBody); err != nil || lr.PartialSuccess().RejectedLogRecords() != 0 {
				t.Fatalf("logs: response %s err %v", respBody, err)
			}

			deadline := time.Now().Add(10 * time.Second)
			for {
				ok, errs := collector.seen("o11y.rum.views")
				if len(errs) > 0 {
					t.Fatalf("the collector could not decode a metrics request: %v", errs)
				}
				if ok {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("no o11y.rum.views reached the collector within 10s")
				}
				time.Sleep(50 * time.Millisecond)
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
		})
	}
}

func TestProducersEnvMustNameO11yrum(t *testing.T) {
	quietTelemetry(t)
	for _, producers := range []string{"prometheus", "none", "o11yrum ,prometheus"} {
		t.Run(producers, func(t *testing.T) {
			t.Setenv("OTEL_METRICS_PRODUCERS", producers)
			// A broken check would serve until the deadline instead of failing.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var errOut bytes.Buffer
			if code := run(ctx, []string{"-config", writeConfig(t, "http://127.0.0.1:1")}, io.Discard, &errOut); code != 1 {
				t.Fatalf("code %d: %s", code, errOut.String())
			}
			if !strings.Contains(errOut.String(), "OTEL_METRICS_PRODUCERS") || !strings.Contains(errOut.String(), "o11yrum") {
				t.Errorf("stderr %q, want it to name OTEL_METRICS_PRODUCERS and o11yrum", errOut.String())
			}
		})
	}
}

func TestServeSourcemapUploads(t *testing.T) {
	quietTelemetry(t)
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "token"), "upload-secret\n")
	writeTestFile(t, filepath.Join(dir, "gateway.yaml"), `listen: 127.0.0.1:0
environment: test
object_store: {filesystem: {root: maps}}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    sourcemaps: {upload_token_file: token}
`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"-config", filepath.Join(dir, "gateway.yaml")}, io.Discard, pw) }()
	base := "http://" + waitForListening(t, pr)
	raw, err := os.ReadFile("../../internal/sourcemap/testdata/simple.js.map")
	if err != nil {
		t.Fatal(err)
	}
	post := func(token string) int {
		req, err := http.NewRequest(http.MethodPost, base+"/_o11y/v1/sourcemaps?service=shop-web&version=1.4.2&url=/assets/app.js", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	if code := post(""); code != http.StatusUnauthorized {
		t.Fatalf("without a token: %d", code)
	}
	if code := post("upload-secret"); code != http.StatusCreated {
		t.Fatalf("with the token: %d", code)
	}
	if entries, err := os.ReadDir(filepath.Join(dir, "maps", "sourcemaps", "shop-web", "1.4.2", "_")); err != nil || len(entries) != 1 {
		t.Fatalf("stored maps: %v %v", entries, err)
	}
	cancel()
	if code := <-done; code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestCheckConfigS3Store(t *testing.T) {
	// The default credential chain finds these and makes no request.
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_CONFIG_FILE", "/nonexistent")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent")
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "token"), "upload-secret\n")
	writeTestFile(t, filepath.Join(dir, "gateway.yaml"), `environment: test
object_store:
  s3: {bucket: maps, prefix: o11yrum/, region: eu-west-1, endpoint: "http://127.0.0.1:1", use_path_style: true}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    sourcemaps: {upload_token_file: token}
`)
	var errOut bytes.Buffer
	if code := run(context.Background(), []string{"-check-config", "-config", filepath.Join(dir, "gateway.yaml")}, io.Discard, &errOut); code != 0 {
		t.Fatalf("code %d: %s", code, errOut.String())
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestServeReplay(t *testing.T) {
	quietTelemetry(t)
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "gateway.yaml"), `listen: 127.0.0.1:0
environment: test
object_store: {filesystem: {root: store}}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    replay: {enabled: true}
`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"-config", filepath.Join(dir, "gateway.yaml")}, io.Discard, pw) }()
	base := "http://" + waitForListening(t, pr)
	const session = "0b7e5c1e-6f2a-4c55-9b1e-1f2d3c4b5a69"
	var body bytes.Buffer
	zw := gzip.NewWriter(&body)
	_, _ = io.WriteString(zw, `{"format":1,"recording":"rec_0123456789","start":1,"end":2,"views":[],"requests":[],
	  "events":[{"type":2,"timestamp":1,"data":{"node":{"type":3,"id":1,"textContent":"Jane Doe"},"initialOffset":{"top":0,"left":0}}}]}`)
	_ = zw.Close()
	req, err := http.NewRequest(http.MethodPost, base+"/_o11y/v1/replay?service=shop-web&segment=0&session="+session, &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Origin", "https://shop.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", resp.StatusCode)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "store", "replay", "shop-web", session))
	if err != nil || len(entries) != 2 {
		t.Fatalf("stored objects: %v %v", entries, err)
	}
	cancel()
	if code := <-done; code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestCheckConfigReplay(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_CONFIG_FILE", "/nonexistent")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent")
	const apps = `apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    replay: {enabled: true}
`
	for name, tc := range map[string]struct {
		yaml string
		ok   bool
	}{
		"s3 store": {"environment: test\nobject_store:\n  s3: {bucket: b, region: eu-west-1, endpoint: \"http://127.0.0.1:1\", use_path_style: true}\n" + apps, true},
		"no store": {"environment: test\n" + apps, false},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeTestFile(t, filepath.Join(dir, "gateway.yaml"), tc.yaml)
			var errOut bytes.Buffer
			code := run(context.Background(), []string{"-check-config", "-config", filepath.Join(dir, "gateway.yaml")}, io.Discard, &errOut)
			if (code == 0) != tc.ok {
				t.Fatalf("code %d: %s", code, errOut.String())
			}
			if !tc.ok && !strings.Contains(errOut.String(), "replay needs an object store") {
				t.Fatalf("stderr %q", errOut.String())
			}
		})
	}
}

func TestServeReplayReadAPI(t *testing.T) {
	quietTelemetry(t)
	dir := t.TempDir()
	const token = "read-token-0123456789abcdef"
	writeTestFile(t, filepath.Join(dir, "read-tokens"), token+"\n")
	writeTestFile(t, filepath.Join(dir, "gateway.yaml"), `listen: 127.0.0.1:0
environment: test
object_store: {filesystem: {root: store}}
replay: {read_listen: "127.0.0.1:0", read_token_file: read-tokens}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    replay: {enabled: true}
`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"-config", filepath.Join(dir, "gateway.yaml")}, io.Discard, pw) }()
	addrs := waitForAddresses(t, pr, listeningMarker, readListeningMarker)
	public, read := "http://"+addrs[0], "http://"+addrs[1]
	if public == read {
		t.Fatalf("one address for both: %s", public)
	}
	const session = "0b7e5c1e-6f2a-4c55-9b1e-1f2d3c4b5a69"
	get := func(url, auth string) int {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	path := "/v1/replay/shop-web/sessions/" + session
	if code := get(read+path, ""); code != http.StatusUnauthorized {
		t.Errorf("read API without a token: %d", code)
	}
	if code := get(read+path, token); code != http.StatusNotFound {
		t.Errorf("read API with the token, unknown session: %d", code)
	}
	// Neither the public listener nor its /_o11y/ path serves the read API.
	for _, p := range []string{path, "/_o11y" + path, "/_o11y/v1/replay/shop-web/sessions/" + session} {
		if code := get(public+p, token); code != http.StatusNotFound {
			t.Errorf("public %s: %d", p, code)
		}
	}
	// The read listener serves nothing of the public gateway.
	if code := get(read+"/healthz", token); code != http.StatusNotFound {
		t.Errorf("read listener /healthz: %d", code)
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
	for _, base := range []string{public, read} {
		if _, err := http.Get(base + "/healthz"); err == nil {
			t.Errorf("%s still serves after shutdown", base)
		}
	}
}

func TestReplayReadListenRefused(t *testing.T) {
	quietTelemetry(t)
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = taken.Close() }()
	for name, tc := range map[string]struct{ listen, read, want string }{
		"same address": {"127.0.0.1:18431", "127.0.0.1:18431", "replay.read_listen"},
		"wildcard":     {":18431", "127.0.0.1:18431", "listen"},
		"port taken":   {"127.0.0.1:0", taken.Addr().String(), "replay read API"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeTestFile(t, filepath.Join(dir, "read-tokens"), "read-token-0123456789abcdef\n")
			writeTestFile(t, filepath.Join(dir, "gateway.yaml"), fmt.Sprintf(`listen: %q
environment: test
object_store: {filesystem: {root: store}}
replay: {read_listen: %q, read_token_file: read-tokens}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    replay: {enabled: true}
`, tc.listen, tc.read))
			for _, args := range [][]string{{"-config"}, {"-check-config", "-config"}} {
				if name == "port taken" && args[0] == "-check-config" {
					continue // binding is not a configuration check
				}
				var errOut bytes.Buffer
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				code := run(ctx, append(args, filepath.Join(dir, "gateway.yaml")), io.Discard, &errOut)
				cancel()
				if code != 1 || !strings.Contains(errOut.String(), tc.want) {
					t.Errorf("%v: code %d, stderr %q, want it to mention %q", args, code, errOut.String(), tc.want)
				}
			}
		})
	}
}
