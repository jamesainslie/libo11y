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
	const marker = "o11yrum-gateway: listening on "
	found := make(chan string, 1)
	var mu sync.Mutex
	var lines []string
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			mu.Lock()
			lines = append(lines, sc.Text())
			mu.Unlock()
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
		mu.Lock()
		defer mu.Unlock()
		t.Fatalf("the gateway did not report its address within 10s; stderr:\n%s", strings.Join(lines, "\n"))
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
