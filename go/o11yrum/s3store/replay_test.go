package s3store

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

const (
	session   = "0b7e5c1e-6f2a-4c55-9b1e-1f2d3c4b5a69"
	readToken = "read-token-0123456789abcdef"
)

// gatewayNow is a day after the fake's default LastModified.
var gatewayNow = fakeModified.Add(24 * time.Hour)

// replayHandler builds a gateway over an S3 store on the fake, with the
// given sweep interval and a read token.
func replayHandler(t *testing.T, s *Store, sweep string) *o11yrum.Handler {
	t.Helper()
	tokens := filepath.Join(t.TempDir(), "tokens")
	if err := os.WriteFile(tokens, []byte(readToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := o11yrum.ParseConfig(fmt.Appendf(nil, `
replay: {sweep_interval: %s, read_token_file: %q}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    replay: {enabled: true}
`, sweep, tokens))
	if err != nil {
		t.Fatal(err)
	}
	h, err := o11yrum.NewHandler(o11yrum.WithConfig(cfg), o11yrum.WithObjectStore(s),
		o11yrum.WithClock(func() time.Time { return gatewayNow }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func gzipped(t *testing.T, raw string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := gzip.NewWriter(&b)
	_, _ = zw.Write([]byte(raw))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// putSegment stores one segment and its metadata as the gateway writes
// them, stored at storedAt.
func putSegment(t *testing.T, s *Store, segment int, storedAt time.Time) []byte {
	t.Helper()
	ctx := context.Background()
	base := fmt.Sprintf("replay/shop-web/%s/%06d", session, segment)
	gz := gzipped(t, `{"format":1,"events":[]}`)
	meta := fmt.Sprintf(`{"service":"shop-web","session":%q,"segment":%d,"stored_at":%d,"event_count":0,"bytes":%d}`,
		session, segment, storedAt.UnixMilli(), len(gz))
	if err := s.Put(ctx, base+".json.gz", gz); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, base+".meta.json", []byte(meta)); err != nil {
		t.Fatal(err)
	}
	return gz
}

func TestSweepS3(t *testing.T) {
	client, f := newFake(t)
	s := NewWithClient(client, "replays", "o11yrum/")
	putSegment(t, s, 0, fakeModified)
	putSegment(t, s, 1, fakeModified)
	if err := s.Put(context.Background(), "sourcemaps/shop-web/1/_/x.map", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	old := gatewayNow.Add(-31 * 24 * time.Hour)
	f.mu.Lock()
	for _, k := range []string{"000000.json.gz", "000000.meta.json"} {
		f.modified["/replays/o11yrum/replay/shop-web/"+session+"/"+k] = old
	}
	f.modified["/replays/o11yrum/sourcemaps/shop-web/1/_/x.map"] = old
	f.mu.Unlock()
	replayHandler(t, s, "20ms")
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		n := f.deletes
		f.mu.Unlock()
		if n >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the sweeper deleted %d objects within 5s, want 2", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var left []string
	for k := range f.objects {
		left = append(left, k)
	}
	want := map[string]bool{
		"/replays/o11yrum/replay/shop-web/" + session + "/000001.json.gz":   true,
		"/replays/o11yrum/replay/shop-web/" + session + "/000001.meta.json": true,
		"/replays/o11yrum/sourcemaps/shop-web/1/_/x.map":                    true,
	}
	if len(left) != len(want) {
		t.Fatalf("objects left %v", left)
	}
	for _, k := range left {
		if !want[k] {
			t.Errorf("unexpected object left %s", k)
		}
	}
}

func TestReplayReadS3(t *testing.T) {
	client, f := newFake(t)
	s := NewWithClient(client, "replays", "o11yrum/")
	gz := putSegment(t, s, 0, gatewayNow.Add(-time.Hour))
	putSegment(t, s, 1, gatewayNow.Add(-31*24*time.Hour)) // expired
	read := replayHandler(t, s, "0s").ReplayReadHandler()
	do := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Authorization", "Bearer "+readToken)
		w := httptest.NewRecorder()
		read.ServeHTTP(w, r)
		return w
	}
	base := "/v1/replay/shop-web/sessions/" + session
	w := do(http.MethodGet, base)
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	var list struct {
		Segments []struct {
			Segment int `json:"segment"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Segments) != 1 || list.Segments[0].Segment != 0 {
		t.Fatalf("list %s %v", w.Body, err)
	}
	// The fake, like S3, labels every object application/json; the read
	// API says it is gzipped.
	w = do(http.MethodGet, base+"/segments/0")
	if w.Code != http.StatusOK || w.Header().Get("Content-Encoding") != "gzip" || !bytes.Equal(w.Body.Bytes(), gz) {
		t.Fatalf("get: %d %v", w.Code, w.Header())
	}
	if w := do(http.MethodGet, base+"/segments/1"); w.Code != http.StatusNotFound {
		t.Fatalf("expired get: %d", w.Code)
	}
	w = do(http.MethodDelete, base)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	var del struct {
		Deleted  int   `json:"deleted"`
		Segments []int `json:"segments"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &del); err != nil || del.Deleted != 4 || len(del.Segments) != 2 {
		t.Fatalf("delete body %s %v", w.Body, err)
	}
	f.mu.Lock()
	n := len(f.objects)
	f.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d objects left after erasure", n)
	}
	if w := do(http.MethodGet, base); w.Code != http.StatusNotFound {
		t.Fatalf("list after delete: %d", w.Code)
	}
}
