package o11yrum

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// testClock is a clock tests advance by hand.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock() *testClock { return &testClock{now: fixedNow} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func versionOf(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])[:16]
}

func TestFileConfigProviderVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shop-web.json")
	writeFile(t, path, `{"sampleRate":0.1}`)
	p, err := NewFileConfigProvider(map[string]string{"shop-web": path}, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	rc, err := p.RemoteConfig(context.Background(), "shop-web")
	if err != nil {
		t.Fatal(err)
	}
	if rc.Version != versionOf(`{"sampleRate":0.1}`) || len(rc.Version) != 16 {
		t.Errorf("version %q", rc.Version)
	}
	if string(rc.Document) != `{"sampleRate":0.1}` {
		t.Errorf("document %s", rc.Document)
	}
	if _, err := p.RemoteConfig(context.Background(), "other"); !errors.Is(err, ErrNoRemoteConfig) {
		t.Errorf("an app without a file: err = %v", err)
	}
}

func TestFileConfigProviderReloads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shop-web.json")
	writeFile(t, path, `{"sampleRate":0.1}`)
	clock := newTestClock()
	p, err := NewFileConfigProvider(map[string]string{"shop-web": path}, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	version := func() string {
		t.Helper()
		rc, err := p.RemoteConfig(context.Background(), "shop-web")
		if err != nil {
			t.Fatal(err)
		}
		return rc.Version
	}
	writeFile(t, path, `{"sampleRate":0.25}`)
	clock.advance(5 * time.Second)
	if got := version(); got != versionOf(`{"sampleRate":0.1}`) {
		t.Errorf("reloaded after 5s: %s", got)
	}
	clock.advance(6 * time.Second)
	if got := version(); got != versionOf(`{"sampleRate":0.25}`) {
		t.Errorf("not reloaded after 11s: %s", got)
	}
}

func TestFileConfigProviderRefusesNonObject(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{
		"array": `[1,2]`, "invalid": `{"a":`, "null": `null`, "string": `"x"`, "trailing": `{} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, name+".json")
			writeFile(t, path, content)
			if _, err := NewFileConfigProvider(map[string]string{"shop-web": path}, time.Now); err == nil {
				t.Fatal("no error")
			}
		})
	}
	if _, err := NewFileConfigProvider(map[string]string{"shop-web": filepath.Join(dir, "missing.json")}, time.Now); err == nil {
		t.Fatal("a missing file gave no error")
	}
}

func TestFileConfigProviderKeepsLastGoodVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shop-web.json")
	writeFile(t, path, `{"sampleRate":0.1}`)
	clock := newTestClock()
	p, err := NewFileConfigProvider(map[string]string{"shop-web": path}, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	var warned []error
	p.warn = func(service string, err error) {
		if service != "shop-web" {
			t.Errorf("warning for %s", service)
		}
		warned = append(warned, err)
	}
	writeFile(t, path, `{"broken":`)
	clock.advance(11 * time.Second)
	rc, err := p.RemoteConfig(context.Background(), "shop-web")
	if err != nil || rc.Version != versionOf(`{"sampleRate":0.1}`) {
		t.Fatalf("version %q err %v, want the last good version", rc.Version, err)
	}
	if len(warned) != 1 {
		t.Fatalf("%d warnings, want 1", len(warned))
	}
	// The broken file is not re-read until it changes again.
	clock.advance(11 * time.Second)
	if _, err := p.RemoteConfig(context.Background(), "shop-web"); err != nil {
		t.Fatal(err)
	}
	if len(warned) != 1 {
		t.Fatalf("an unchanged broken file warned again: %d warnings", len(warned))
	}
	writeFile(t, path, `{"sampleRate":0.5}`)
	clock.advance(11 * time.Second)
	if rc, _ := p.RemoteConfig(context.Background(), "shop-web"); rc.Version != versionOf(`{"sampleRate":0.5}`) {
		t.Fatalf("the fixed file was not picked up: %q", rc.Version)
	}
}

const remoteDoc = `{"sampleRate":0.1}`

// newConfigHandler builds the test handler with a remote configuration
// file for shop-web and shop-mobile.
func newConfigHandler(t *testing.T, opts ...Option) *Handler {
	t.Helper()
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for i, a := range cfg.Apps {
		if a.ServiceName == "shop-web" || a.ServiceName == "shop-mobile" {
			path := filepath.Join(dir, a.ServiceName+".json")
			writeFile(t, path, remoteDoc)
			cfg.Apps[i].RemoteConfigFile = path
		}
	}
	cfg.Apps = append(cfg.Apps, AppConfig{ServiceName: "shop-admin", Origins: []string{"https://admin.example"}, PII: piiDrop})
	h, err := NewHandler(append([]Option{WithConfig(cfg)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func getConfig(h http.Handler, query, origin, remote string, header ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/_o11y/v1/config"+query, nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestServeConfig(t *testing.T) {
	h := newConfigHandler(t)
	v := versionOf(remoteDoc)
	w := getConfig(h, "?service=shop-web", "https://shop.example", "203.0.113.1:1")
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	hdr := w.Header()
	if hdr.Get("Content-Type") != "application/json" || hdr.Get("ETag") != `"`+v+`"` ||
		hdr.Get("Cache-Control") != "no-cache" || hdr.Get("Access-Control-Allow-Origin") != "https://shop.example" {
		t.Errorf("headers %v", hdr)
	}
	if !strings.Contains(hdr.Get("Access-Control-Expose-Headers"), "ETag") {
		t.Errorf("ETag is not exposed: %q", hdr.Get("Access-Control-Expose-Headers"))
	}
	var body struct {
		Version string          `json:"version"`
		Config  json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Version != v || string(body.Config) != remoteDoc {
		t.Errorf("body %s", w.Body)
	}
}

func TestServeConfigNotModified(t *testing.T) {
	h := newConfigHandler(t)
	v := versionOf(remoteDoc)
	for i, inm := range []string{`"` + v + `"`, `W/"` + v + `"`, `"other", "` + v + `"`, `*`} {
		remote := fmt.Sprintf("203.0.113.%d:1", 100+i)
		w := getConfig(h, "?service=shop-web", "https://shop.example", remote, "If-None-Match", inm)
		if w.Code != 304 || w.Body.Len() != 0 || w.Header().Get("ETag") != `"`+v+`"` {
			t.Errorf("If-None-Match %s: status %d, body %q, ETag %q", inm, w.Code, w.Body, w.Header().Get("ETag"))
		}
	}
	w := getConfig(h, "?service=shop-web", "https://shop.example", "203.0.113.11:1", "If-None-Match", `"stale"`)
	if w.Code != 200 {
		t.Errorf("a stale ETag: status %d", w.Code)
	}
}

func TestServeConfigRefusals(t *testing.T) {
	for name, tc := range map[string]struct {
		method, query, origin string
		want                  int
	}{
		"no remote config":      {"GET", "?service=shop-admin", "https://admin.example", 404},
		"unknown service":       {"GET", "?service=nope", "https://shop.example", 403},
		"missing service":       {"GET", "", "https://shop.example", 400},
		"disabled app":          {"GET", "?service=shop-off", "https://shop.example", 403},
		"disallowed origin":     {"GET", "?service=shop-web", "https://evil.example", 403},
		"same-origin GET":       {"GET", "?service=shop-web", "", 200},
		"post":                  {"POST", "?service=shop-web", "https://shop.example", 405},
		"mobile with token":     {"GET", "?service=shop-mobile&client_token=pub-123", "", 200},
		"mobile without token":  {"GET", "?service=shop-mobile", "", 403},
		"mobile wrong token":    {"GET", "?service=shop-mobile&client_token=nope", "", 403},
		"mobile foreign origin": {"GET", "?service=shop-mobile&client_token=pub-123", "https://shop.example", 403},
	} {
		t.Run(name, func(t *testing.T) {
			h := newConfigHandler(t)
			r := httptest.NewRequest(tc.method, "/_o11y/v1/config"+tc.query, nil)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			r.RemoteAddr = "203.0.113.20:1"
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body)
			}
			if tc.want == 405 && w.Header().Get("Allow") != "GET, OPTIONS" {
				t.Errorf("Allow %q", w.Header().Get("Allow"))
			}
		})
	}
}

func TestServeConfigRateLimited(t *testing.T) {
	h := newConfigHandler(t)
	for i := range 3 {
		if w := getConfig(h, "?service=shop-web", "https://shop.example", "203.0.113.30:1"); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := getConfig(h, "?service=shop-web", "https://shop.example", "203.0.113.30:1")
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("status %d Retry-After %q, want 429", w.Code, w.Header().Get("Retry-After"))
	}
}

// failingProvider fails every lookup.
type failingProvider struct{}

func (failingProvider) RemoteConfig(context.Context, string) (RemoteConfig, error) {
	return RemoteConfig{}, errors.New("store down")
}

func TestServeConfigProvider(t *testing.T) {
	h := newConfigHandler(t, WithConfigProvider(failingProvider{}))
	w := getConfig(h, "?service=shop-web", "https://shop.example", "203.0.113.40:1")
	if w.Code != 503 || w.Header().Get("Retry-After") != "5" {
		t.Fatalf("status %d Retry-After %q, want 503 and 5", w.Code, w.Header().Get("Retry-After"))
	}
}

func TestServeConfigLogsReloadFailure(t *testing.T) {
	rec := o11ytest.Start(t)
	clock := newTestClock()
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "shop-web.json")
	writeFile(t, path, remoteDoc)
	cfg.Apps[0].RemoteConfigFile = path
	h, err := NewHandler(WithConfig(cfg), WithSDK(rec.SDK), WithClock(clock.Now))
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, `[]`)
	clock.advance(11 * time.Second)
	w := getConfig(h, "?service=shop-web", "https://shop.example", "203.0.113.50:1")
	if w.Code != 200 || w.Header().Get("ETag") != fmt.Sprintf("%q", versionOf(remoteDoc)) {
		t.Fatalf("status %d ETag %q, want the last good version", w.Code, w.Header().Get("ETag"))
	}
	found := false
	for _, lr := range rec.Logs() {
		if strings.Contains(lr.Record.Message, "remote configuration") {
			if app, _ := lr.Attr("o11yrum.app"); app == "shop-web" {
				found = true
			}
		}
	}
	if !found {
		t.Error("the failed reload was not logged")
	}
}

func TestNewHandlerRefusesBadRemoteConfigFile(t *testing.T) {
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Apps[0].RemoteConfigFile = filepath.Join(t.TempDir(), "missing.json")
	if _, err := NewHandler(WithConfig(cfg)); err == nil || !strings.Contains(err.Error(), "shop-web") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadConfigResolvesRemoteConfigFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "shop-web.json"), remoteDoc)
	writeFile(t, filepath.Join(dir, "gateway.yaml"), `
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    remote_config_file: shop-web.json
`)
	cfg, err := LoadConfig(filepath.Join(dir, "gateway.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg))
	if err != nil {
		t.Fatal(err)
	}
	if w := getConfig(h, "?service=shop-web", "https://shop.example", "203.0.113.60:1"); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
}
