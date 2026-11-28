package catalog

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/ops/internal/fixture"
	"github.com/jamesainslie/libo11y/ops/internal/gatewaybin"
)

var update = flag.Bool("update", false, "rewrite testdata/exported.txt from the running gateway")

const golden = "testdata/exported.txt"

// TestGatewayExports builds o11yrum-gateway from this checkout, sends it
// the fixture session, scrapes its Prometheus endpoint, and compares every
// metric family and label name with the golden catalog.
func TestGatewayExports(t *testing.T) {
	bin := gatewaybin.Build(t)
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
		gatewaybin.Post(t, addr, r, nil, http.StatusOK)
	}
	gatewaybin.Post(t, addr, fixture.Policy(now), nil, http.StatusOK)
	bad, h := fixture.Bad(now)
	gatewaybin.Post(t, addr, bad, h, http.StatusForbidden)
	// Symbolication: upload the map, then send an error whose stack names
	// the mapped script.
	upload(t, addr, fixture.SourceMap())
	gatewaybin.Post(t, addr, fixture.Symbolicated(now), nil, http.StatusOK)

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
		g, err := gatewaybin.Launch(bin, gatewaybin.Options{Config: config, PromHost: "127.0.0.1", PromPort: promPort})
		if err == nil {
			t.Cleanup(func() {
				if err := g.Stop(); err != nil {
					t.Error(err)
				}
			})
			return g.Addr, promPort
		}
		if i == attempts || !strings.Contains(err.Error(), "address already in use") {
			t.Fatal(err)
		}
		t.Logf("attempt %d: %v; retrying on another port", i, err)
	}
}
