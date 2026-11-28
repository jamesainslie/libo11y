package o11yrum

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// readToken and readToken2 are the read API's bearer tokens in these
// tests.
const (
	readToken  = "read-token-0123456789abcdef"
	readToken2 = "second-token-fedcba9876543210"
)

type readFixture struct {
	h     *Handler
	read  http.Handler
	store *FileStore
	clock *testClock
	rec   *o11ytest.Recorder
}

// readConfig is replayConfig with a retention of a day and a token file,
// which %s names.
const readConfig = `
edge: {rate_limit_per_minute: 1000}
replay: {retention: 24h, read_token_file: %q}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    replay: {enabled: true}
  - service_name: shop-off
    origins: ["https://shop.example"]
  - service_name: shop-paused
    origins: ["https://shop.example"]
    replay: {namespace: paused}
`

// newReadFixture builds a handler whose token file holds tokens (a
// comment, a blank line and both test tokens when tokens is empty).
func newReadFixture(t *testing.T, store ObjectStore, tokens string) readFixture {
	t.Helper()
	if tokens == "" {
		tokens = "# the player backend\n" + readToken + "\n\n  " + readToken2 + "  \n"
	}
	file := filepath.Join(t.TempDir(), "read-tokens")
	if err := os.WriteFile(file, []byte(tokens), 0o600); err != nil {
		t.Fatal(err)
	}
	return newReadFixtureYAML(t, store, fmt.Sprintf(readConfig, file))
}

func newReadFixtureYAML(t *testing.T, store ObjectStore, yaml string) readFixture {
	t.Helper()
	cfg, err := ParseConfig([]byte(yaml))
	if err != nil {
		t.Fatal(err)
	}
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if store == nil {
		store = fs
	}
	clock := &testClock{now: gatewayNow}
	rec := o11ytest.Start(t)
	h, err := NewHandler(WithConfig(cfg), WithObjectStore(store), WithSDK(rec.SDK), WithClock(clock.Now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return readFixture{h: h, read: h.ReplayReadHandler(), store: fs, clock: clock, rec: rec}
}

// seed posts segments 0 and 1 of replaySession for shop-web.
func (f readFixture) seed(t *testing.T) {
	t.Helper()
	for _, seg := range []string{"1", "0"} {
		q := replayQuery("shop-web")
		q.Set("segment", seg)
		q.Set("sent_at", fmt.Sprint(f.clock.Now().UnixMilli()))
		if w := postReplay(t, f.h, q, sampleEnvelope(), true); w.Code != http.StatusNoContent {
			t.Fatalf("seeding segment %s: %d %s", seg, w.Code, w.Body)
		}
	}
}

func readRequest(t *testing.T, h http.Handler, method, path, auth string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, nil)
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func sessionPath(service, session string) string {
	return "/v1/replay/" + service + "/sessions/" + session
}

func readBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("body %q: %v", w.Body, err)
	}
	return m
}

func TestReplayReadList(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	for _, token := range []string{readToken, readToken2} {
		w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), "Bearer "+token)
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
		if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Errorf("Cache-Control %q", got)
		}
		if got := w.Header().Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type %q", got)
		}
		body := readBody(t, w)
		if body["service"] != "shop-web" || body["session"] != replaySession {
			t.Errorf("body %v", body)
		}
		segs, _ := body["segments"].([]any)
		if len(segs) != 2 {
			t.Fatalf("segments %v", body["segments"])
		}
		for i, s := range segs {
			m := s.(map[string]any)
			if m["segment"] != float64(i) || m["event_count"] != 2.0 || m["stored_at"] != float64(gatewayNow.UnixMilli()) {
				t.Errorf("segment %d meta %v", i, m)
			}
			if _, ok := m["events"]; ok {
				t.Errorf("segment %d lists its events", i)
			}
		}
	}
	// The scheme is case-insensitive, as RFC 9110 has it.
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), "bearer "+readToken); w.Code != http.StatusOK {
		t.Errorf("lowercase scheme: %d", w.Code)
	}
}

func TestReplayReadGet(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	_, _, gz := stored(t, f.store, "shop-web", 1)
	w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession)+"/segments/1", "Bearer "+readToken)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	for k, want := range map[string]string{
		"Content-Type":           "application/json",
		"Content-Encoding":       "gzip",
		"Cache-Control":          "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Length":         fmt.Sprint(len(gz)),
	} {
		if got := w.Header().Get(k); got != want {
			t.Errorf("%s %q, want %q", k, got, want)
		}
	}
	if !bytes.Equal(w.Body.Bytes(), gz) {
		t.Error("the body is not the stored object")
	}
	// Six digits with leading zeros name the same segment.
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession)+"/segments/000001", "Bearer "+readToken); w.Code != http.StatusOK {
		t.Errorf("padded segment: %d", w.Code)
	}
}

func TestReplayReadAuth(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	paths := []struct{ method, path string }{
		{http.MethodGet, sessionPath("shop-web", replaySession)},
		{http.MethodGet, sessionPath("shop-web", replaySession) + "/segments/0"},
		{http.MethodDelete, sessionPath("shop-web", replaySession)},
		{http.MethodGet, sessionPath("nope", replaySession)},
		{http.MethodPost, sessionPath("shop-web", replaySession)},
		{http.MethodGet, "/v1/replay/shop-web/sessions/../../etc"},
		{http.MethodGet, "/"},
	}
	for name, auth := range map[string]string{
		"none":         "",
		"wrong":        "Bearer not-the-token-at-all-000",
		"basic":        "Basic " + readToken,
		"no scheme":    readToken,
		"empty bearer": "Bearer ",
		"prefix":       "Bearer " + readToken[:len(readToken)-1],
		"suffix":       "Bearer " + readToken + "x",
		"comment line": "Bearer # the player backend",
		"two tokens":   "Bearer " + readToken + " " + readToken2,
	} {
		for _, p := range paths {
			// The refusals are spaced out so the failed-token limit
			// (TestReplayReadLimitsFailedTokens) never applies here.
			f.clock.advance(time.Minute)
			w := readRequest(t, f.read, p.method, p.path, auth)
			if w.Code != http.StatusUnauthorized {
				t.Errorf("%s %s %s: status %d", name, p.method, p.path, w.Code)
				continue
			}
			if got := w.Header().Get("WWW-Authenticate"); !strings.HasPrefix(got, "Bearer") {
				t.Errorf("%s %s: WWW-Authenticate %q", name, p.path, got)
			}
			if strings.Contains(w.Body.String(), "segment") || strings.Contains(w.Body.String(), replaySession) {
				t.Errorf("%s: a refusal leaks %q", name, w.Body)
			}
		}
	}
	// Nothing was erased by the refused deletes.
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), "Bearer "+readToken); w.Code != http.StatusOK {
		t.Fatalf("after refusals: %d", w.Code)
	}
	rm := f.rec.Metrics()
	reads := sumPoints(t, metricByName(t, rm, "o11yrum.replay.reads"))
	if got := reads[set(telOperation, "list", telOutcome, "unauthorized")]; got != 18 {
		t.Errorf("unauthorized lists %d, want 18", got)
	}
	if got := reads[set(telOperation, "delete", telOutcome, "unauthorized")]; got != 9 {
		t.Errorf("unauthorized deletes %d, want 9", got)
	}
	if got := reads[set(telOperation, "list", telOutcome, "ok")]; got != 1 {
		t.Errorf("listed %d, want 1", got)
	}
}

func TestReplayReadWithoutTokenFile(t *testing.T) {
	yaml := strings.Replace(readConfig, "read_token_file: %q", "max_events: 50", 1)
	f := newReadFixtureYAML(t, nil, yaml)
	f.seed(t)
	for _, auth := range []string{"", "Bearer " + readToken, "Bearer "} {
		w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), auth)
		if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") == "" {
			t.Errorf("%q: status %d", auth, w.Code)
		}
	}
}

func TestReplayReadRefusals(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	const other = "1c8f6d2f-7a3b-4d66-8c2f-2e3d4c5b6a70"
	auth := "Bearer " + readToken
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, sessionPath("nope", replaySession), http.StatusNotFound},
		{http.MethodGet, sessionPath("shop-off", replaySession), http.StatusNotFound},
		{http.MethodGet, sessionPath("shop-paused", replaySession), http.StatusNotFound},
		{http.MethodGet, sessionPath("nope", replaySession) + "/segments/0", http.StatusNotFound},
		{http.MethodGet, sessionPath("shop-off", replaySession) + "/segments/0", http.StatusNotFound},
		{http.MethodDelete, sessionPath("nope", replaySession), http.StatusNotFound},
		// Erasure serves a configured app that does not record, so its
		// old recordings can still be erased.
		{http.MethodDelete, sessionPath("shop-off", replaySession), http.StatusOK},
		{http.MethodGet, sessionPath("shop-web", other), http.StatusNotFound},
		{http.MethodGet, sessionPath("shop-web", replaySession) + "/segments/7", http.StatusNotFound},
		{http.MethodGet, sessionPath("shop-web", replaySession) + "/segments/abc", http.StatusBadRequest},
		{http.MethodGet, sessionPath("shop-web", replaySession) + "/segments/-1", http.StatusBadRequest},
		{http.MethodGet, sessionPath("shop-web", replaySession) + "/segments/1000000", http.StatusBadRequest},
		{http.MethodGet, sessionPath("shop-web", replaySession) + "/segments/", http.StatusNotFound},
		{http.MethodGet, sessionPath("shop-web", strings.ToUpper(replaySession)), http.StatusBadRequest},
		{http.MethodGet, sessionPath("shop-web", "x"), http.StatusBadRequest},
		{http.MethodDelete, sessionPath("shop-web", "x"), http.StatusBadRequest},
		{http.MethodPost, sessionPath("shop-web", replaySession), http.StatusMethodNotAllowed},
		{http.MethodGet, "/v1/replay/shop-web", http.StatusNotFound},
	} {
		w := readRequest(t, f.read, tc.method, tc.path, auth)
		if w.Code != tc.want {
			t.Errorf("%s %s: status %d, want %d (%s)", tc.method, tc.path, w.Code, tc.want, w.Body)
		}
		if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Errorf("%s %s: Cache-Control %q", tc.method, tc.path, got)
		}
	}
}

func TestReplayReadExpired(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	// Segment 2 is stored 12 hours later than 0 and 1.
	f.clock.advance(12 * time.Hour)
	q := replayQuery("shop-web")
	q.Set("segment", "2")
	q.Set("sent_at", fmt.Sprint(f.clock.Now().UnixMilli()))
	if w := postReplay(t, f.h, q, sampleEnvelope(), true); w.Code != http.StatusNoContent {
		t.Fatalf("segment 2: %d", w.Code)
	}
	auth := "Bearer " + readToken
	list := func() []float64 {
		t.Helper()
		w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), auth)
		if w.Code == http.StatusNotFound {
			return nil
		}
		if w.Code != http.StatusOK {
			t.Fatalf("list: %d", w.Code)
		}
		var segs []float64
		for _, s := range readBody(t, w)["segments"].([]any) {
			segs = append(segs, s.(map[string]any)["segment"].(float64))
		}
		return segs
	}
	get := func(seg int) int {
		return readRequest(t, f.read, http.MethodGet, fmt.Sprintf("%s/segments/%d", sessionPath("shop-web", replaySession), seg), auth).Code
	}
	if got := list(); len(got) != 3 {
		t.Fatalf("before expiry %v", got)
	}
	// Exactly the retention later, 0 and 1 have expired.
	f.clock.advance(12 * time.Hour)
	if got := list(); len(got) != 1 || got[0] != 2 {
		t.Errorf("after 0 and 1 expired: %v", got)
	}
	if get(0) != http.StatusNotFound || get(1) != http.StatusNotFound || get(2) != http.StatusOK {
		t.Errorf("get after 0 and 1 expired: %d %d %d", get(0), get(1), get(2))
	}
	f.clock.advance(12 * time.Hour)
	if got := list(); got != nil {
		t.Errorf("after all expired: %v", got)
	}
	if get(2) != http.StatusNotFound {
		t.Errorf("get after all expired: %d", get(2))
	}
	// The objects are still there: the read API refuses them anyway.
	if _, _, gz := stored(t, f.store, "shop-web", 0); len(gz) == 0 {
		t.Fatal("segment 0 is gone")
	}
}

func TestReplayReadFailsClosedOnBadMetadata(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	ctx := context.Background()
	if err := f.store.Put(ctx, replayMetaKey("shop-web", replaySession, 0), []byte(`{"segment":0}`)); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Put(ctx, replayMetaKey("shop-web", replaySession, 1), []byte(`not json`)); err != nil {
		t.Fatal(err)
	}
	auth := "Bearer " + readToken
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), auth); w.Code != http.StatusNotFound {
		t.Errorf("list with no valid metadata: %d %s", w.Code, w.Body)
	}
	for _, seg := range []string{"0", "1"} {
		if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession)+"/segments/"+seg, auth); w.Code != http.StatusNotFound {
			t.Errorf("segment %s with bad metadata: %d", seg, w.Code)
		}
	}
	// A segment whose metadata is missing is never served.
	if err := f.store.Delete(ctx, replayMetaKey("shop-web", replaySession, 0)); err != nil {
		t.Fatal(err)
	}
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession)+"/segments/0", auth); w.Code != http.StatusNotFound {
		t.Errorf("segment without metadata: %d", w.Code)
	}
}

func TestReplayReadTokenFileBOM(t *testing.T) {
	f := newReadFixture(t, nil, "\ufeff"+readToken+"\n")
	f.seed(t)
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), "Bearer "+readToken); w.Code != http.StatusOK {
		t.Fatalf("a token after a byte order mark: %d", w.Code)
	}
}

func TestReplayReadListSkipsMismatchedMetadata(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	ctx := context.Background()
	// Segment 1's metadata object claims to be segment 0.
	raw, err := f.store.Get(ctx, replayMetaKey("shop-web", replaySession, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.Put(ctx, replayMetaKey("shop-web", replaySession, 1), raw); err != nil {
		t.Fatal(err)
	}
	w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), "Bearer "+readToken)
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d", w.Code)
	}
	if segs := readBody(t, w)["segments"].([]any); len(segs) != 1 {
		t.Errorf("segments %v, want only segment 0", segs)
	}
}

func TestReplayErase(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	ctx := context.Background()
	const other = "1c8f6d2f-7a3b-4d66-8c2f-2e3d4c5b6a70"
	keep := replayKey("shop-web", other, 0)
	if err := f.store.Put(ctx, keep, []byte("x")); err != nil {
		t.Fatal(err)
	}
	auth := "Bearer " + readToken
	w := readRequest(t, f.read, http.MethodDelete, sessionPath("shop-web", replaySession), auth)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	body := readBody(t, w)
	if body["deleted"] != 4.0 || body["service"] != "shop-web" || body["session"] != replaySession {
		t.Errorf("delete body %v", body)
	}
	if segs, _ := body["segments"].([]any); len(segs) != 2 || segs[0] != 0.0 || segs[1] != 1.0 {
		t.Errorf("deleted segments %v", body["segments"])
	}
	if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("Cache-Control %q", got)
	}
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), auth); w.Code != http.StatusNotFound {
		t.Errorf("list after delete: %d", w.Code)
	}
	var left []string
	if err := f.store.List(ctx, "replay/", func(o ObjectInfo) error { left = append(left, o.Key); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(left) != 1 || left[0] != keep {
		t.Errorf("objects left %v, want only the other session", left)
	}
	// Nothing names the erased session any more, not even a directory.
	if _, err := os.Stat(filepath.Join(f.store.root, "replay", "shop-web", replaySession)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the session directory remains: %v", err)
	}
	// Erasing again is not an error.
	w = readRequest(t, f.read, http.MethodDelete, sessionPath("shop-web", replaySession), auth)
	if w.Code != http.StatusOK {
		t.Fatalf("second delete: %d", w.Code)
	}
	if body := readBody(t, w); body["deleted"] != 0.0 {
		t.Errorf("second delete body %v", body)
	}
	if segs, ok := readBody(t, w)["segments"].([]any); !ok || len(segs) != 0 {
		t.Errorf("second delete segments %v, want []", readBody(t, w)["segments"])
	}
}

func TestReplayEraseExpiredAndPaused(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	ctx := context.Background()
	// An app that no longer records keeps what it stored until erased.
	paused := replayKey("paused", replaySession, 3)
	if err := f.store.Put(ctx, paused, []byte("x")); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(48 * time.Hour)
	auth := "Bearer " + readToken
	// Erasure removes expired objects too.
	w := readRequest(t, f.read, http.MethodDelete, sessionPath("shop-web", replaySession), auth)
	if w.Code != http.StatusOK || readBody(t, w)["deleted"] != 4.0 {
		t.Errorf("delete expired: %d %s", w.Code, w.Body)
	}
	w = readRequest(t, f.read, http.MethodDelete, sessionPath("shop-paused", replaySession), auth)
	if w.Code != http.StatusOK || readBody(t, w)["deleted"] != 1.0 {
		t.Errorf("delete for a paused app: %d %s", w.Code, w.Body)
	}
	if _, err := f.store.Get(ctx, paused); !errors.Is(err, ErrNotFound) {
		t.Errorf("paused object: %v", err)
	}
}

// flakyStore is a FileStore whose List or Delete can fail.
type flakyStore struct {
	*FileStore
	failList   bool
	failDelete func(key string) bool
	failGet    bool
}

func (s flakyStore) List(ctx context.Context, prefix string, fn func(ObjectInfo) error) error {
	if s.failList {
		// Like the S3 store's, the error names what it was asked for.
		return fmt.Errorf("list %s: store unavailable", prefix)
	}
	return s.FileStore.List(ctx, prefix, fn)
}

func (s flakyStore) Delete(ctx context.Context, key string) error {
	if s.failDelete != nil && s.failDelete(key) {
		return fmt.Errorf("delete %s: access denied", key)
	}
	return s.FileStore.Delete(ctx, key)
}

func (s flakyStore) Get(ctx context.Context, key string) ([]byte, error) {
	if s.failGet {
		return nil, fmt.Errorf("get %s: store unavailable", key)
	}
	return s.FileStore.Get(ctx, key)
}

func TestReplayReadStoreFailures(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := &flakyStore{FileStore: fs}
	f := newReadFixture(t, store, "")
	f.seed(t)
	auth := "Bearer " + readToken
	store.failDelete = func(key string) bool { return strings.HasSuffix(key, "000001.json.gz") }
	w := readRequest(t, f.read, http.MethodDelete, sessionPath("shop-web", replaySession), auth)
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") == "" {
		t.Fatalf("delete with a failing store: %d %v", w.Code, w.Header())
	}
	// The objects that could be deleted were, and the answer says so.
	if body := readBody(t, w); body["deleted"] != 3.0 {
		t.Errorf("partial delete body %v", body)
	}
	store.failDelete = nil
	w = readRequest(t, f.read, http.MethodDelete, sessionPath("shop-web", replaySession), auth)
	if w.Code != http.StatusOK || readBody(t, w)["deleted"] != 1.0 {
		t.Errorf("retried delete: %d %s", w.Code, w.Body)
	}
	f.seed(t)
	store.failList = true
	for _, p := range []struct{ method, path string }{
		{http.MethodGet, sessionPath("shop-web", replaySession)},
		{http.MethodDelete, sessionPath("shop-web", replaySession)},
	} {
		if w := readRequest(t, f.read, p.method, p.path, auth); w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s with a failing List: %d", p.method, w.Code)
		}
	}
	store.failList, store.failGet = false, true
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession)+"/segments/0", auth); w.Code != http.StatusServiceUnavailable {
		t.Errorf("get with a failing Get: %d", w.Code)
	}
	// No log record carries a token or the session.
	for _, l := range f.rec.Logs() {
		var b strings.Builder
		b.WriteString(l.Record.Message)
		l.Record.Attrs(func(a slog.Attr) bool {
			b.WriteString(" " + a.String())
			return true
		})
		for _, secret := range []string{readToken, readToken2, replaySession} {
			if strings.Contains(b.String(), secret) {
				t.Errorf("log %q holds %q", b.String(), secret)
			}
		}
	}
	if len(f.rec.Logs()) == 0 {
		t.Error("store failures were not logged")
	}
	reads := sumPoints(t, metricByName(t, f.rec.Metrics(), "o11yrum.replay.reads"))
	if got := reads[set(telOperation, "delete", telOutcome, "error")]; got != 2 {
		t.Errorf("failed deletes %d, want 2", got)
	}
}

func TestReplayReadNotOnPublicPath(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		for _, path := range []string{
			"/_o11y/v1/replay/shop-web/sessions/" + replaySession,
			"/_o11y/v1/replay/shop-web/sessions/" + replaySession + "/segments/0",
			"/_o11y" + sessionPath("shop-web", replaySession),
			sessionPath("shop-web", replaySession),
		} {
			w := readRequest(t, f.h, method, path, "Bearer "+readToken)
			if w.Code != http.StatusNotFound {
				t.Errorf("public %s %s: status %d", method, path, w.Code)
			}
		}
	}
	if _, _, gz := stored(t, f.store, "shop-web", 0); len(gz) == 0 {
		t.Fatal("a public request erased a segment")
	}
}

func TestReplayReadTokenFile(t *testing.T) {
	dir := t.TempDir()
	for name, tc := range map[string]struct {
		content string
		want    string
	}{
		"empty":         {"", "holds no token"},
		"comments only": {"# nothing\n\n", "holds no token"},
		"short":         {readToken + "\nshort-secret\n", "line 2"},
		"inline note":   {readToken + " # the player\n", "line 1"},
		"control byte":  {"read-token-0123\x00456789abcdef\n", "line 1"},
		"non-ascii":     {"read-token-0123456789abcdéf\n", "line 1"},
		"bom comment":   {"\ufeff# read tokens for the player backend\n", "holds no token"},
		"missing":       {"", "replay.read_token_file"},
	} {
		file := filepath.Join(dir, strings.ReplaceAll(name, " ", "-"))
		if name != "missing" {
			if err := os.WriteFile(file, []byte(tc.content), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		cfg, err := ParseConfig([]byte(fmt.Sprintf(readConfig, file)))
		if err != nil {
			t.Fatal(err)
		}
		store, err := NewFileStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		_, err = NewHandler(WithConfig(cfg), WithObjectStore(store))
		if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), file) {
			t.Errorf("%s: err %v, want it to mention %q and the file", name, err, tc.want)
			continue
		}
		if strings.Contains(err.Error(), "short-secret") || strings.Contains(err.Error(), readToken) {
			t.Errorf("%s: the error holds a token: %v", name, err)
		}
	}
	// A token file needs a store that can list and delete.
	file := filepath.Join(dir, "ok")
	if err := os.WriteFile(file, []byte(readToken), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := ParseConfig([]byte(fmt.Sprintf("replay: {read_token_file: %q}\napps:\n  - service_name: a\n    origins: [https://a.example]\n", file)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewHandler(WithConfig(cfg), WithObjectStore(putGetOnly{})); err == nil || !strings.Contains(err.Error(), "List and Delete") {
		t.Errorf("token file with a put-get store: %v", err)
	}
	if _, err := NewHandler(WithConfig(cfg)); err == nil || !strings.Contains(err.Error(), "object store") {
		t.Errorf("token file without a store: %v", err)
	}
}

func TestReplayReadHandlerIsStable(t *testing.T) {
	f := newReadFixture(t, nil, "")
	if f.h.ReplayReadHandler() != f.read {
		t.Error("ReplayReadHandler builds a new handler on each call")
	}
}

// readFrom is readRequest from the TCP peer addr.
func readFrom(t *testing.T, h http.Handler, addr, method, path, auth string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = addr
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestReplayReadLimitsFailedTokens(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	const peer, other = "10.1.2.3:41000", "10.1.2.4:41000"
	path := sessionPath("shop-web", replaySession)
	good, bad := "Bearer "+readToken, "Bearer not-the-token-at-all-000"
	// Successful requests never spend the failure budget.
	for i := range 3 * readFailuresPerMinute {
		if w := readFrom(t, f.read, peer, http.MethodGet, path, good); w.Code != http.StatusOK {
			t.Fatalf("good request %d: %d", i, w.Code)
		}
	}
	for i := range readFailuresPerMinute {
		if w := readFrom(t, f.read, peer, http.MethodGet, path, bad); w.Code != http.StatusUnauthorized {
			t.Fatalf("failure %d inside the budget: %d", i, w.Code)
		}
	}
	// Past the budget the peer is refused before its token is compared, so
	// a guess that happens to be right learns nothing either.
	for name, auth := range map[string]string{"wrong": bad, "right": good, "none": ""} {
		w := readFrom(t, f.read, peer, http.MethodGet, path, auth)
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("%s token past the budget: %d", name, w.Code)
		}
		if ra, err := strconv.Atoi(w.Header().Get("Retry-After")); err != nil || ra < 1 {
			t.Errorf("%s: Retry-After %q", name, w.Header().Get("Retry-After"))
		}
		if strings.Contains(w.Body.String(), replaySession) {
			t.Errorf("%s: the refusal leaks %q", name, w.Body)
		}
	}
	// Another peer is not locked out.
	if w := readFrom(t, f.read, other, http.MethodGet, path, good); w.Code != http.StatusOK {
		t.Fatalf("another peer: %d", w.Code)
	}
	// The budget refills.
	f.clock.advance(time.Minute)
	if w := readFrom(t, f.read, peer, http.MethodGet, path, good); w.Code != http.StatusOK {
		t.Fatalf("after the window: %d", w.Code)
	}
	reads := sumPoints(t, metricByName(t, f.rec.Metrics(), "o11yrum.replay.reads"))
	if got := reads[set(telOperation, "list", telOutcome, "rate_limited")]; got != 3 {
		t.Errorf("rate-limited lists %d, want 3", got)
	}
}

func TestReplayReadReloadTokens(t *testing.T) {
	f := newReadFixture(t, nil, readToken+"\n")
	f.seed(t)
	file := f.h.cfg.resolvePath(f.h.cfg.Replay.ReadTokenFile)
	path := sessionPath("shop-web", replaySession)
	status := func(token string) int {
		t.Helper()
		f.clock.advance(time.Minute) // keep clear of the failed-token limit
		return readRequest(t, f.read, http.MethodGet, path, "Bearer "+token).Code
	}
	if got := status(readToken2); got != http.StatusUnauthorized {
		t.Fatalf("second token before the reload: %d", got)
	}
	if err := os.WriteFile(file, []byte(readToken2+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Nothing changes until the reload.
	if got := status(readToken); got != http.StatusOK {
		t.Fatalf("first token before the reload: %d", got)
	}
	if err := f.h.ReloadReplayReadTokens(); err != nil {
		t.Fatal(err)
	}
	if got := status(readToken); got != http.StatusUnauthorized {
		t.Errorf("rotated-out token: %d", got)
	}
	if got := status(readToken2); got != http.StatusOK {
		t.Errorf("rotated-in token: %d", got)
	}
	// A bad file fails the reload and keeps the tokens in use.
	for name, content := range map[string]string{"short": "short-secret\n", "empty": "", "missing": ""} {
		if name == "missing" {
			if err := os.Remove(file); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		err := f.h.ReloadReplayReadTokens()
		if err == nil || !strings.Contains(err.Error(), file) || strings.Contains(err.Error(), "short-secret") {
			t.Errorf("%s: err %v, want it to name the file and no token", name, err)
		}
		if got := status(readToken2); got != http.StatusOK {
			t.Errorf("%s: the token in use stopped working: %d", name, got)
		}
	}
}

func TestReplayReadReloadWithoutTokenFile(t *testing.T) {
	yaml := strings.Replace(readConfig, "read_token_file: %q", "max_events: 50", 1)
	f := newReadFixtureYAML(t, nil, yaml)
	if err := f.h.ReloadReplayReadTokens(); err != nil {
		t.Errorf("reload without a token file: %v", err)
	}
	if w := readRequest(t, f.read, http.MethodGet, sessionPath("shop-web", replaySession), "Bearer "+readToken); w.Code != http.StatusUnauthorized {
		t.Errorf("after the reload: %d", w.Code)
	}
}

// TestReplayReadLimitsEachIPv6PeerAlone checks the failure budget belongs
// to one address: pods on a cluster's IPv6 network often share a /64.
func TestReplayReadLimitsEachIPv6PeerAlone(t *testing.T) {
	f := newReadFixture(t, nil, "")
	f.seed(t)
	const noisy, player = "[2001:db8:1:2::a]:41000", "[2001:db8:1:2::b]:41000"
	path := sessionPath("shop-web", replaySession)
	for range readFailuresPerMinute + 1 {
		readFrom(t, f.read, noisy, http.MethodGet, path, "Bearer not-the-token-at-all-000")
	}
	if w := readFrom(t, f.read, noisy, http.MethodGet, path, "Bearer "+readToken); w.Code != http.StatusTooManyRequests {
		t.Fatalf("the noisy peer: %d", w.Code)
	}
	if w := readFrom(t, f.read, player, http.MethodGet, path, "Bearer "+readToken); w.Code != http.StatusOK {
		t.Errorf("a peer in the same /64: %d", w.Code)
	}
}
