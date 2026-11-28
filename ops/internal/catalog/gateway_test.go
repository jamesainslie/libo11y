package catalog

import (
	"bufio"
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/ops/internal/fixture"
)

var update = flag.Bool("update", false, "rewrite testdata/exported.txt from the running gateway")

const golden = "testdata/exported.txt"

// TestGatewayExports builds o11yrum-gateway from this checkout, sends it
// the fixture session, scrapes its Prometheus endpoint, and compares every
// metric family and label name with the golden catalog.
func TestGatewayExports(t *testing.T) {
	bin := gatewayBinary(t)
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(sink.Close)

	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "upload-token")
	if err := os.WriteFile(tokenFile, []byte(uploadToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "gateway.yaml")
	if err := os.WriteFile(config, []byte(gatewayConfig(sink.URL, filepath.Join(dir, "store"), tokenFile)), 0o600); err != nil {
		t.Fatal(err)
	}
	addr, promPort := startGateway(t, bin, config)

	now := time.Now()
	for _, r := range fixture.Traffic(now) {
		post(t, addr, r, nil, now, http.StatusOK)
	}
	post(t, addr, fixture.Policy(now), nil, now, http.StatusOK)
	bad, h := fixture.Bad(now)
	post(t, addr, bad, h, now, http.StatusForbidden)
	// Symbolication: upload the map, then send an error whose stack names
	// the mapped script.
	upload(t, addr, fixture.SourceMap())
	post(t, addr, fixture.Symbolicated(now), nil, now, http.StatusOK)

	got := scrape(t, fmt.Sprintf("http://127.0.0.1:%d/metrics", promPort))
	if *update {
		if err := os.WriteFile(golden, got.Format(), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s with %d families", golden, len(got))
		return
	}
	want, err := Load(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Format(), want.Format()) {
		t.Errorf("the gateway's metric families differ from %s; if the gateway changed on purpose, run\n"+
			"  go test ./internal/catalog/ -run TestGatewayExports -update\nand fix the queries that use changed names.\n%s",
			golden, diff(want, got))
	}
}

// gatewayBinary builds the gateway, or returns O11YRUM_GATEWAY_BIN.
func gatewayBinary(t *testing.T) string {
	t.Helper()
	if bin := os.Getenv("O11YRUM_GATEWAY_BIN"); bin != "" {
		return bin
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go is not on PATH, so the gateway cannot be built; set O11YRUM_GATEWAY_BIN")
	}
	bin := filepath.Join(t.TempDir(), "o11yrum-gateway")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-C", "../../../go/o11yrum", "-o", bin, "./cmd/o11yrum-gateway")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build o11yrum-gateway: %v\n%s", err, out)
	}
	return bin
}

// uploadToken is the fixture app's source map upload token.
const uploadToken = "fixture-upload-token"

// gatewayConfig serves the fixture app. Loopback plays the CDN in front of
// the gateway: it forwards the client address and sets the country header,
// so the country label is derived. A filesystem object store under store
// turns on source map uploads and symbolication.
func gatewayConfig(sink, store, tokenFile string) string {
	return fmt.Sprintf(`listen: 127.0.0.1:0
environment: test
edge:
  forwarded_header: X-Forwarded-For
  country:
    header: CF-IPCountry
    trusted_from: ["127.0.0.0/8", "::1/128"]
object_store:
  filesystem: {root: %q}
apps:
  - service_name: %s
    origins: [%q]
    sourcemaps:
      upload_token_file: %q
sinks:
  otlp:
    endpoint: %s
    timeout: 5s
`, store, fixture.Service, fixture.Origin, tokenFile, sink)
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

// syncBuffer collects the gateway's stderr for failure messages.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) WriteLine(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.b.WriteString(line)
	s.b.WriteByte('\n')
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// startGateway runs the gateway with a Prometheus reader on a free port and
// returns the address it serves on and the Prometheus port. Another process
// can take the port between freePort and the gateway binding it, so a start
// that fails on a taken address is retried on a new port. Cleanup stops the
// gateway with SIGINT.
func startGateway(t *testing.T, bin, config string) (addr string, promPort int) {
	t.Helper()
	const attempts = 3
	for i := 1; ; i++ {
		promPort = freePort(t)
		g, err := launch(bin, config, promPort)
		if err == nil {
			t.Cleanup(func() {
				if err := g.stop(); err != nil {
					t.Error(err)
				}
			})
			return g.addr, promPort
		}
		if i == attempts || !strings.Contains(err.Error(), "address already in use") {
			t.Fatal(err)
		}
		t.Logf("attempt %d: %v; retrying on another port", i, err)
	}
}

// gateway is one running gateway process.
type gateway struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
	ctx    context.Context
	done   chan struct{} // closed when stderr is fully read
	log    *syncBuffer
	addr   string
}

// processBudget bounds the gateway's whole life, so a hung test cannot leave
// it running.
const processBudget = 3 * time.Minute

func launch(bin, config string, promPort int) (*gateway, error) {
	ctx, cancel := context.WithTimeout(context.Background(), processBudget)
	cmd := exec.CommandContext(ctx, bin, "-config", config)
	// The caller's own OTEL_* settings would change what the gateway
	// exports, so only the five below reach it.
	cmd.Env = append(slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "OTEL_") }),
		"OTEL_METRICS_EXPORTER=prometheus",
		"OTEL_EXPORTER_PROMETHEUS_HOST=127.0.0.1",
		"OTEL_EXPORTER_PROMETHEUS_PORT="+strconv.Itoa(promPort),
		"OTEL_TRACES_EXPORTER=none",
		"OTEL_LOGS_EXPORTER=none",
	)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	g := &gateway{cmd: cmd, cancel: cancel, ctx: ctx, done: make(chan struct{}), log: &syncBuffer{}}
	listening := make(chan string, 1)
	go func() {
		defer close(g.done)
		const prefix = "o11yrum-gateway: listening on "
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			g.log.WriteLine(line)
			if a, ok := strings.CutPrefix(line, prefix); ok {
				select {
				case listening <- a:
				default:
				}
			}
		}
		if err := sc.Err(); err != nil {
			g.log.WriteLine("(reading stderr: " + err.Error() + ")")
		}
		// Keep draining, so the gateway never blocks on a full pipe.
		_, _ = io.Copy(io.Discard, stderr)
	}()
	select {
	case g.addr = <-listening:
		return g, nil
	case <-g.done:
		_ = cmd.Wait()
		cancel()
		return nil, fmt.Errorf("the gateway exited before listening:\n%s", g.log.String())
	case <-time.After(30 * time.Second):
		_ = g.stop()
		return nil, fmt.Errorf("the gateway did not start listening:\n%s", g.log.String())
	}
}

// stop sends SIGINT, waits for the gateway to drain and exit, and reports
// an unclean exit or a kill by the process budget.
func (g *gateway) stop() error {
	defer g.cancel()
	_ = g.cmd.Process.Signal(os.Interrupt)
	<-g.done
	err := g.cmd.Wait()
	if g.ctx.Err() != nil {
		return fmt.Errorf("the gateway outlived its %s budget and was killed:\n%s", processBudget, g.log.String())
	}
	if err != nil {
		return fmt.Errorf("the gateway exited with %w:\n%s", err, g.log.String())
	}
	return nil
}

// post sends one fixture request as the browser would and checks the
// status.
func post(t *testing.T, addr string, r fixture.Request, h http.Header, now time.Time, want int) {
	t.Helper()
	target := fmt.Sprintf("http://%s%s?sent_at=%d", addr, r.Path, now.UnixMilli())
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, target, bytes.NewReader(r.Body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", fixture.Origin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("CF-IPCountry", "CA")
	req.Header.Set("X-Forwarded-For", "203.0.113.5")
	for k, v := range h {
		req.Header[k] = v
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("POST %s: read the response: %v", r.Path, err)
	}
	if resp.StatusCode != want {
		t.Fatalf("POST %s: %d, want %d: %s", r.Path, resp.StatusCode, want, body)
	}
}

// scrape reads the Prometheus endpoint until the derived views counter
// appears, then parses it into a catalog.
func scrape(t *testing.T, endpoint string) Catalog {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var last string
	for {
		body, err := get(t, endpoint)
		if err == nil {
			c, perr := Parse(bytes.NewReader(body))
			if perr != nil {
				t.Fatalf("parse %s: %v", endpoint, perr)
			}
			if _, ok := c["o11y_rum_views_total"]; ok {
				return c
			}
			last = string(body)
		} else {
			last = err.Error()
		}
		if time.Now().After(deadline) {
			t.Fatalf("o11y_rum_views_total did not appear on %s; last scrape:\n%s", endpoint, last)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func get(t *testing.T, endpoint string) ([]byte, error) {
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", endpoint, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

// diff lists the lines only in want and only in got.
func diff(want, got Catalog) string {
	w := strings.Split(strings.TrimSpace(string(want.Format())), "\n")
	g := strings.Split(strings.TrimSpace(string(got.Format())), "\n")
	in := func(s []string) map[string]bool {
		m := map[string]bool{}
		for _, l := range s {
			m[l] = true
		}
		return m
	}
	wm, gm := in(w), in(g)
	var b strings.Builder
	for _, l := range w {
		if !gm[l] {
			fmt.Fprintf(&b, "- %s\n", l)
		}
	}
	for _, l := range g {
		if !wm[l] {
			fmt.Fprintf(&b, "+ %s\n", l)
		}
	}
	return b.String()
}

// upload stores a source map for the fixture's release and script, as a
// build would, and checks the gateway answers 201.
func upload(t *testing.T, addr string, sourceMap []byte) {
	t.Helper()
	q := url.Values{"service": {fixture.Service}, "version": {fixture.Version}, "url": {fixture.ScriptURL}}
	target := fmt.Sprintf("http://%s%s?%s", addr, fixture.PathSourcemaps, q.Encode())
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, target, bytes.NewReader(sourceMap))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+uploadToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close() // the body is read; a close error changes nothing
	if err != nil {
		t.Fatalf("upload: read the response: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d, want 201: %s", resp.StatusCode, body)
	}
}
