package o11yrum

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/jamesainslie/libo11y/go/o11ytest"
)

const uploadConfig = `
edge: {rate_limit_per_minute: 3}
sourcemaps: {max_upload_bytes: 65536}
object_store: {filesystem: {root: maps}}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    sourcemaps: {upload_token_file: token}
  - service_name: shop-canary
    origins: ["https://shop.example"]
    sourcemaps: {namespace: shop-web}
  - service_name: shop-admin
    origins: ["https://shop.example"]
`

// writeConfig writes a configuration and an upload token beside it and
// loads it, so relative paths resolve against the temporary directory.
func writeConfig(t *testing.T, yaml string) (*Config, string) {
	t.Helper()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "token"), "secret-1\n")
	writeFile(t, filepath.Join(dir, "gateway.yaml"), yaml)
	cfg, err := LoadConfig(filepath.Join(dir, "gateway.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	return cfg, dir
}

func newUploadHandler(t *testing.T, opts ...Option) (*Handler, string) {
	t.Helper()
	cfg, dir := writeConfig(t, uploadConfig)
	h, err := NewHandler(append([]Option{WithConfig(cfg)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h, dir
}

func fixtureMap(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("internal/sourcemap/testdata/simple.js.map")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func upload(h http.Handler, method, query, auth, encoding string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/_o11y/v1/sourcemaps"+query, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	if encoding != "" {
		r.Header.Set("Content-Encoding", encoding)
	}
	r.RemoteAddr = "203.0.113.5:1000"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func gzipped(t *testing.T, b []byte) []byte {
	t.Helper()
	z, err := gzipBytes(b)
	if err != nil {
		t.Fatal(err)
	}
	return z
}

const validUpload = "?service=shop-web&version=1.4.2&url=https://shop.example/assets/app.js"

var keyPattern = regexp.MustCompile(`^sourcemaps/shop-web/1\.4\.2/_/[0-9a-f]{32}\.map$`)

func TestUploadStores(t *testing.T) {
	h, dir := newUploadHandler(t)
	raw := fixtureMap(t)
	w := upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", raw)
	if w.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var resp struct{ Key string }
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !keyPattern.MatchString(resp.Key) {
		t.Fatalf("key %q", resp.Key)
	}
	if resp.Key != sourcemapKey("shop-web", "1.4.2", "", "/assets/app.js") {
		t.Fatalf("key %q is not the lookup key", resp.Key)
	}
	stored, err := os.ReadFile(filepath.Join(dir, "maps", filepath.FromSlash(resp.Key)))
	if err != nil || !bytes.Equal(stored, raw) {
		t.Fatalf("stored %d bytes, %v", len(stored), err)
	}
}

func TestUploadGzipAndUpdateID(t *testing.T) {
	h, _ := newUploadHandler(t)
	w := upload(h, http.MethodPost, validUpload+"&update_id=u-1", "Bearer secret-1", "gzip", gzipped(t, fixtureMap(t)))
	if w.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), "/1.4.2/u-1/") {
		t.Fatalf("body %s", w.Body)
	}
}

func TestUploadRefusals(t *testing.T) {
	big := append([]byte(`{"version":3,"sources":[],"names":[],"mappings":"`), bytes.Repeat([]byte(";"), 70000)...)
	big = append(big, `"}`...)
	for name, tc := range map[string]struct {
		method, query, auth, encoding string
		body                          []byte
		want                          int
		contains                      string
	}{
		"no token":          {"POST", validUpload, "", "", nil, 401, ""},
		"wrong token":       {"POST", validUpload, "Bearer secret-2", "", nil, 401, ""},
		"basic auth":        {"POST", validUpload, "Basic c2VjcmV0LTE=", "", nil, 401, ""},
		"token prefix":      {"POST", validUpload, "Bearer secret-", "", nil, 401, ""},
		"app without token": {"POST", "?service=shop-admin&version=1&url=/a.js", "Bearer secret-1", "", nil, 401, ""},
		"unknown service":   {"POST", "?service=nope&version=1&url=/a.js", "Bearer secret-1", "", nil, 401, ""},
		"bad version":       {"POST", "?service=shop-web&version=../x&url=/a.js", "Bearer secret-1", "", nil, 400, ""},
		"no version":        {"POST", "?service=shop-web&url=/a.js", "Bearer secret-1", "", nil, 400, ""},
		"bad update id":     {"POST", "?service=shop-web&version=1&update_id=a/b&url=/a.js", "Bearer secret-1", "", nil, 400, ""},
		"no url":            {"POST", "?service=shop-web&version=1", "Bearer secret-1", "", nil, 400, ""},
		"too large":         {"POST", validUpload, "Bearer secret-1", "", big, 413, ""},
		"gzip too large":    {"POST", validUpload, "Bearer secret-1", "gzip", gzipped(t, big), 413, ""},
		"bad encoding":      {"POST", validUpload, "Bearer secret-1", "br", []byte("{}"), 415, ""},
		"bad gzip":          {"POST", validUpload, "Bearer secret-1", "gzip", []byte("nope"), 400, ""},
		"index map":         {"POST", validUpload, "Bearer secret-1", "", []byte(`{"version":3,"sections":[]}`), 422, "index maps"},
		"not a map":         {"POST", validUpload, "Bearer secret-1", "", []byte(`nope`), 422, ""},
		"get":               {"GET", validUpload, "Bearer secret-1", "", nil, 405, ""},
	} {
		t.Run(name, func(t *testing.T) {
			h, _ := newUploadHandler(t)
			w := upload(h, tc.method, tc.query, tc.auth, tc.encoding, tc.body)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body)
			}
			if tc.want == 401 && w.Header().Get("WWW-Authenticate") != "Bearer" {
				t.Errorf("WWW-Authenticate %q", w.Header().Get("WWW-Authenticate"))
			}
			if tc.want == 405 && w.Header().Get("Allow") != "POST" {
				t.Errorf("Allow %q", w.Header().Get("Allow"))
			}
			if !strings.Contains(w.Body.String(), tc.contains) {
				t.Errorf("body %q does not mention %q", w.Body, tc.contains)
			}
		})
	}
}

// TestUploadNeverServesMaps checks no method on the upload path returns
// a stored map.
func TestUploadNeverServesMaps(t *testing.T) {
	h, _ := newUploadHandler(t)
	raw := fixtureMap(t)
	if w := upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", raw); w.Code != http.StatusCreated {
		t.Fatalf("status %d", w.Code)
	}
	for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodPut} {
		w := upload(h, m, validUpload, "Bearer secret-1", "", nil)
		if w.Code != http.StatusMethodNotAllowed || bytes.Contains(w.Body.Bytes(), []byte("mappings")) {
			t.Errorf("%s: status %d", m, w.Code)
		}
	}
}

func TestUploadFailedAuthIsRateLimited(t *testing.T) {
	h, _ := newUploadHandler(t)
	last := 0
	for range 5 {
		last = upload(h, http.MethodPost, validUpload, "Bearer wrong", "", nil).Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("status %d after repeated bad tokens", last)
	}
	// A valid token still works: authenticated uploads are not limited,
	// so a CI job uploading many maps is never refused.
	for range 5 {
		if w := upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", fixtureMap(t)); w.Code != http.StatusCreated {
			t.Fatalf("authenticated upload: %d", w.Code)
		}
	}
}

type failingStore struct{}

func (failingStore) Put(context.Context, string, []byte) error { return errors.New("disk full") }
func (failingStore) Get(context.Context, string) ([]byte, error) {
	return nil, errors.New("disk full")
}

func TestUploadStoreFailure(t *testing.T) {
	h, _ := newUploadHandler(t, WithObjectStore(failingStore{}))
	w := upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", fixtureMap(t))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "5" {
		t.Fatalf("status %d, Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
}

// memStore is an ObjectStore in memory that counts reads.
type memStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	gets    map[string]int
}

func newMemStore() *memStore {
	return &memStore{objects: map[string][]byte{}, gets: map[string]int{}}
}

func (s *memStore) Put(_ context.Context, key string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = bytes.Clone(data)
	return nil
}

func (s *memStore) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gets[key]++
	b, ok := s.objects[key]
	if !ok {
		return nil, ErrNotFound
	}
	return b, nil
}

func (s *memStore) getCount(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gets[key]
}

func TestUploadWithObjectStoreOverridesConfig(t *testing.T) {
	store := newMemStore()
	h, dir := newUploadHandler(t, WithObjectStore(store))
	w := upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", fixtureMap(t))
	if w.Code != http.StatusCreated {
		t.Fatalf("status %d", w.Code)
	}
	if len(store.objects) != 1 {
		t.Fatalf("store holds %d objects", len(store.objects))
	}
	if _, err := os.Stat(filepath.Join(dir, "maps", "sourcemaps")); err == nil {
		t.Fatal("the configured filesystem store was used too")
	}
}

func TestUploadRouteNeedsAStore(t *testing.T) {
	h := newTestHandler(t)
	if w := upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", nil); w.Code != http.StatusNotFound {
		t.Fatalf("status %d without an object store", w.Code)
	}
}

func TestUploadTelemetry(t *testing.T) {
	rec := o11ytest.Start(t)
	cfg, _ := writeConfig(t, uploadConfig)
	h, err := NewHandler(WithConfig(cfg), WithSDK(rec.SDK))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = h.Close() }()
	upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", fixtureMap(t))
	upload(h, http.MethodPost, validUpload, "Bearer nope", "", nil)
	upload(h, http.MethodPost, "?service=evil&version=1&url=/a.js", "Bearer nope", "", nil)
	upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", []byte("nope"))
	got := sumPoints(t, metricByName(t, rec.Metrics(), "o11yrum.sourcemaps.uploads"))
	for _, want := range []struct {
		app, outcome string
		n            int64
	}{
		{"shop-web", "stored", 1},
		{"shop-web", "unauthorized", 1},
		{appUnknown, "unauthorized", 1},
		{"shop-web", "invalid", 1},
	} {
		if n := got[set(telApp, want.app, telOutcome, want.outcome)]; n != want.n {
			t.Errorf("%s %s: %d, want %d (all: %v)", want.app, want.outcome, n, want.n, got)
		}
	}
}

func TestObjectStoreConfig(t *testing.T) {
	base := "apps:\n  - {service_name: shop-web, origins: [\"https://a\"]}\n"
	for name, tc := range map[string]struct{ yaml, want string }{
		"both stores":    {"object_store: {filesystem: {root: m}, s3: {bucket: b}}\n" + base, "exactly one"},
		"empty root":     {"object_store: {filesystem: {root: \"\"}}\n" + base, "object_store.filesystem.root"},
		"empty bucket":   {"object_store: {s3: {bucket: \"\"}}\n" + base, "object_store.s3.bucket"},
		"bad namespace":  {"apps:\n  - {service_name: a, origins: [\"https://a\"], sourcemaps: {namespace: ../x}}\n", "sourcemaps.namespace"},
		"slash in name":  {"apps:\n  - {service_name: a/b, origins: [\"https://a\"], sourcemaps: {upload_token_file: t}}\n", "set sourcemaps.namespace"},
		"negative cap":   {"sourcemaps: {max_upload_bytes: -1}\n" + base, "sourcemaps.max_upload_bytes"},
		"empty token":    {"apps:\n  - {service_name: a, origins: [\"https://a\"], sourcemaps: {upload_token_file: \"\"}}\n" + "", ""},
		"slash no token": {"apps:\n  - {service_name: a/b, origins: [\"https://a\"]}\n", ""},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseConfig([]byte(tc.yaml))
			if tc.want == "" {
				if err != nil {
					t.Fatalf("refused: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v, want %q", err, tc.want)
			}
		})
	}
	cfg, err := ParseConfig([]byte(base))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Sourcemaps.MaxUploadBytes != 32<<20 {
		t.Errorf("max_upload_bytes default %d", cfg.Sourcemaps.MaxUploadBytes)
	}
}

func TestNewHandlerUploadTokenFile(t *testing.T) {
	for name, tc := range map[string]struct{ token, want string }{
		"missing": {"", "nope-token"},
		"blank":   {"  \n", "empty"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.token != "" {
				writeFile(t, filepath.Join(dir, "nope-token"), tc.token)
			}
			writeFile(t, filepath.Join(dir, "g.yaml"), "object_store: {filesystem: {root: maps}}\napps:\n  - {service_name: a, origins: [\"https://a\"], sourcemaps: {upload_token_file: nope-token}}\n")
			cfg, err := LoadConfig(filepath.Join(dir, "g.yaml"))
			if err != nil {
				t.Fatalf("ParseConfig must not read the token file: %v", err)
			}
			_, err = NewHandler(WithConfig(cfg))
			if err == nil || !strings.Contains(err.Error(), "nope-token") || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v", err)
			}
		})
	}
}

func TestNewHandlerUploadTokenNeedsStore(t *testing.T) {
	cfg, _ := writeConfig(t, "apps:\n  - {service_name: a, origins: [\"https://a\"], sourcemaps: {upload_token_file: token}}\n")
	if _, err := NewHandler(WithConfig(cfg)); err == nil || !strings.Contains(err.Error(), "object store") {
		t.Fatalf("err %v", err)
	}
}

func TestNewHandlerS3NeedsStoreOption(t *testing.T) {
	cfg, err := ParseConfig([]byte("object_store: {s3: {bucket: b}}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewHandler(WithConfig(cfg)); err == nil || !strings.Contains(err.Error(), "WithObjectStore") {
		t.Fatalf("err %v", err)
	}
	h, err := NewHandler(WithConfig(cfg), WithObjectStore(newMemStore()))
	if err != nil {
		t.Fatal(err)
	}
	_ = h.Close()
}

func TestUploadBearerSchemeIsCaseInsensitive(t *testing.T) {
	h, _ := newUploadHandler(t)
	if w := upload(h, http.MethodPost, validUpload, "bearer secret-1", "", fixtureMap(t)); w.Code != http.StatusCreated {
		t.Fatalf("status %d", w.Code)
	}
}

// TestUploadUnknownClientFailsClosed checks a failed authentication from
// a client the rate limiter cannot key is refused without the 401 that
// would let it guess tokens without limit.
func TestUploadUnknownClientFailsClosed(t *testing.T) {
	h, _ := newUploadHandler(t)
	r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/sourcemaps"+validUpload, nil)
	r.Header.Set("Authorization", "Bearer wrong")
	r.RemoteAddr = "not-an-address"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d", w.Code)
	}
}
