package o11yrum

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jamesainslie/libo11y/go/o11ytest"
)

const replaySession = "0b7e5c1e-6f2a-4c55-9b1e-1f2d3c4b5a69"

const replayConfig = `
edge: {rate_limit_per_minute: 1000}
replay: {max_body_bytes: 65536, max_decompressed_bytes: 262144, max_events: 50}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    query_allow_list: [page]
    replay: {enabled: true}
  - service_name: shop-trusted
    origins: ["https://shop.example"]
    client_token: pub-1
    replay: {enabled: true, unmasked_text: true, namespace: trusted}
  - service_name: shop-off
    origins: ["https://shop.example"]
`

// gatewayNow is the gateway clock in the replay tests.
var gatewayNow = time.UnixMilli(1_764_000_000_000)

type replayFixture struct {
	h     *Handler
	store *FileStore
	rec   *o11ytest.Recorder
}

func newReplayFixture(t *testing.T, yaml string, store ObjectStore) replayFixture {
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
	rec := o11ytest.Start(t)
	h, err := NewHandler(WithConfig(cfg), WithObjectStore(store), WithSDK(rec.SDK),
		WithClock(func() time.Time { return gatewayNow }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return replayFixture{h: h, store: fs, rec: rec}
}

func replayQuery(service string) url.Values {
	return url.Values{
		"service": {service},
		"session": {replaySession},
		"segment": {"0"},
		"sent_at": {fmt.Sprint(gatewayNow.UnixMilli())},
	}
}

// sampleEnvelope is a segment as the collector sends it: a full snapshot
// with a name in it, an input event and a value attribute.
func sampleEnvelope() map[string]any {
	return map[string]any{
		"format":    1,
		"recording": "rec_0123456789",
		"start":     1000,
		"end":       2000,
		"views":     []any{map[string]any{"id": "v1", "name": "/orders/$id", "at": 1000, "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7", "extra": "x"}},
		"requests":  []any{map[string]any{"trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b8", "at": 1500}},
		"unknown":   "dropped",
		"events": []any{
			map[string]any{"type": 4, "timestamp": 1000, "data": map[string]any{"href": "https://shop.example/orders/7?token=SECRET&page=2", "width": 800, "height": 600}},
			map[string]any{"type": 2, "timestamp": 1001, "data": map[string]any{"node": map[string]any{
				"type": 0, "id": 1, "childNodes": []any{
					map[string]any{"type": 2, "id": 2, "tagName": "p", "attributes": map[string]any{"class": "name"}, "childNodes": []any{
						map[string]any{"type": 3, "id": 3, "textContent": "Jane Doe"},
					}},
					map[string]any{"type": 2, "id": 4, "tagName": "input", "attributes": map[string]any{"value": "hunter2", "type": "text"}, "childNodes": []any{}},
				},
			}, "initialOffset": map[string]any{"top": 0, "left": 0}}},
			map[string]any{"type": 3, "timestamp": 2000, "data": map[string]any{"source": 5, "id": 4, "text": "hunter2", "isChecked": false}},
		},
	}
}

func postReplay(t *testing.T, h http.Handler, q url.Values, env any, gzipped bool) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return postReplayRaw(t, h, q, body, gzipped, nil)
}

func postReplayRaw(t *testing.T, h http.Handler, q url.Values, body []byte, gzipped bool, hdr http.Header) *httptest.ResponseRecorder {
	t.Helper()
	if gzipped {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write(body)
		_ = zw.Close()
		body = buf.Bytes()
	}
	r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/replay?"+q.Encode(), bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://shop.example")
	if gzipped {
		r.Header.Set("Content-Encoding", "gzip")
	}
	for k, v := range hdr {
		r.Header[k] = v
	}
	r.RemoteAddr = "203.0.113.5:1000"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// stored reads and decodes a stored segment and its metadata.
func stored(t *testing.T, s ObjectStore, ns string, segment int) (env, meta map[string]any, gz []byte) {
	t.Helper()
	ctx := context.Background()
	gz, err := s.Get(ctx, replayKey(ns, replaySession, segment))
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	mraw, err := s.Get(ctx, replayMetaKey(ns, replaySession, segment))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(mraw, &meta); err != nil {
		t.Fatal(err)
	}
	return env, meta, gz
}

func TestReplayAccepted(t *testing.T) {
	f := newReplayFixture(t, replayConfig, nil)
	w := postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://shop.example" {
		t.Errorf("Access-Control-Allow-Origin %q", got)
	}
	env, meta, gz := stored(t, f.store, "shop-web", 0)
	for k, want := range map[string]any{
		"service": "shop-web", "session": replaySession, "segment": 0.0, "format": 1.0,
		"recording": "rec_0123456789", "stored_at": float64(gatewayNow.UnixMilli()), "clock_offset_ms": 0.0,
		"start": 1000.0, "end": 2000.0,
	} {
		if env[k] != want {
			t.Errorf("envelope %s = %v, want %v", k, env[k], want)
		}
	}
	if _, ok := env["unknown"]; ok {
		t.Error("an unknown envelope field was stored")
	}
	raw := marshal(t, env)
	for _, leak := range []string{"Jane", "hunter2", "SECRET", `"extra"`} {
		if strings.Contains(raw, leak) {
			t.Errorf("stored %q: %s", leak, raw)
		}
	}
	for _, want := range []string{`"textContent":"**** ***"`, `"href":"https://shop.example/orders/7?page=2"`, `"name":"/orders/$id"`} {
		if !strings.Contains(raw, want) {
			t.Errorf("missing %s in %s", want, raw)
		}
	}
	if n := len(env["events"].([]any)); n != 2 {
		t.Errorf("%d events stored, want 2 (the input event dropped)", n)
	}
	if _, ok := meta["events"]; ok {
		t.Error("the metadata holds the events")
	}
	if meta["event_count"] != 2.0 || meta["bytes"] != float64(len(gz)) || meta["session"] != replaySession || meta["recording"] != "rec_0123456789" {
		t.Errorf("metadata %v (stored %d bytes)", meta, len(gz))
	}
	rm := f.rec.Metrics()
	if got := sumPoints(t, metricByName(t, rm, "o11yrum.replay.segments"))[set(telApp, "shop-web", telOutcome, outcomeAccepted, telReason, reasonOK)]; got != 1 {
		t.Errorf("accepted segments %d", got)
	}
	if got := sumPoints(t, metricByName(t, rm, "o11yrum.replay.bytes"))[set(telApp, "shop-web")]; got != int64(len(gz)) {
		t.Errorf("bytes %d, want %d", got, len(gz))
	}
	if got := sumPoints(t, metricByName(t, rm, "o11yrum.replay.events.dropped"))[set(telApp, "shop-web", telReason, dropInput)]; got != 1 {
		t.Errorf("dropped input events %d", got)
	}
	hist, ok := metricByName(t, rm, "o11yrum.replay.store.duration").Data.(metricdata.Histogram[float64])
	if !ok {
		t.Fatal("o11yrum.replay.store.duration is not a float64 histogram")
	}
	var puts uint64
	for _, dp := range hist.DataPoints {
		if dp.Attributes.Equivalent() == set(telOperation, "put", telOutcome, "ok") {
			puts = dp.Count
		}
	}
	if puts != 2 {
		t.Errorf("timed puts %d, want 2", puts)
	}
}

func TestReplayUnmaskedText(t *testing.T) {
	f := newReplayFixture(t, replayConfig, nil)
	q := replayQuery("shop-trusted")
	q.Set("client_token", "pub-1")
	if w := postReplay(t, f.h, q, sampleEnvelope(), false); w.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	env, _, _ := stored(t, f.store, "trusted", 0)
	raw := marshal(t, env)
	if !strings.Contains(raw, `"textContent":"Jane Doe"`) {
		t.Errorf("unmasked_text did not keep the client's text: %s", raw)
	}
	if strings.Contains(raw, "hunter2") || strings.Contains(raw, `"value"`) || strings.Contains(raw, "SECRET") {
		t.Errorf("unmasked_text let an input or a query through: %s", raw)
	}
	if got := sumPoints(t, metricByName(t, f.rec.Metrics(), "o11yrum.replay.events.dropped"))[set(telApp, "shop-trusted", telReason, dropInput)]; got != 1 {
		t.Errorf("dropped input events %d", got)
	}
}

func TestReplayClockSkew(t *testing.T) {
	f := newReplayFixture(t, replayConfig, nil)
	q := replayQuery("shop-web")
	q.Set("sent_at", fmt.Sprint(gatewayNow.UnixMilli()-10000))
	if w := postReplay(t, f.h, q, sampleEnvelope(), true); w.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	env, meta, _ := stored(t, f.store, "shop-web", 0)
	if env["clock_offset_ms"] != 10000.0 || meta["clock_offset_ms"] != 10000.0 {
		t.Errorf("clock_offset_ms %v", env["clock_offset_ms"])
	}
	if env["start"] != 11000.0 || env["end"] != 12000.0 {
		t.Errorf("start %v end %v", env["start"], env["end"])
	}
	for i, e := range env["events"].([]any) {
		if ts := e.(map[string]any)["timestamp"].(float64); ts != []float64{11000, 11001}[i] {
			t.Errorf("event %d timestamp %v", i, ts)
		}
	}
	if at := env["views"].([]any)[0].(map[string]any)["at"]; at != 11000.0 {
		t.Errorf("view at %v", at)
	}
	if at := env["requests"].([]any)[0].(map[string]any)["at"]; at != 11500.0 {
		t.Errorf("request at %v", at)
	}
}

func TestReplayRetryOverwrites(t *testing.T) {
	f := newReplayFixture(t, replayConfig, nil)
	for i := range 2 {
		if w := postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true); w.Code != http.StatusNoContent {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	n := 0
	if err := f.store.List(context.Background(), replayPrefix("shop-web", replaySession), func(ObjectInfo) error { n++; return nil }); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("%d objects, want the segment and its metadata", n)
	}
}

// failingReplayStore fails every write.
type failingReplayStore struct{ putGetOnly }

func (failingReplayStore) Put(context.Context, string, []byte) error { return errors.New("disk full") }
func (failingReplayStore) List(context.Context, string, func(ObjectInfo) error) error {
	return nil
}
func (failingReplayStore) Delete(context.Context, string) error { return nil }

func TestReplayRefusals(t *testing.T) {
	big := sampleEnvelope()
	evs := make([]any, 51)
	for i := range evs {
		evs[i] = map[string]any{"type": 0, "timestamp": i}
	}
	big["events"] = evs
	badFormat := sampleEnvelope()
	badFormat["format"] = 2
	bomb := bytes.Repeat([]byte(" "), 300000)
	for name, tc := range map[string]struct {
		query   func(url.Values)
		body    []byte
		env     any
		gzip    bool
		header  http.Header
		store   ObjectStore
		status  int
		reason  string
		retry   string
		app     string
		corsSet bool
	}{
		"replay disabled":  {query: func(q url.Values) { q.Set("service", "shop-off") }, status: 403, reason: "replay_disabled", app: "shop-off", corsSet: true},
		"unknown service":  {query: func(q url.Values) { q.Set("service", "nope") }, status: 403, reason: "unknown_service", app: appUnknown},
		"bad origin":       {header: http.Header{"Origin": {"https://evil.example"}}, status: 403, reason: "origin", app: "shop-web"},
		"bad client token": {query: func(q url.Values) { q.Set("service", "shop-trusted"); q.Set("client_token", "x") }, status: 403, reason: "client_token", app: "shop-trusted"},
		"bad session":      {query: func(q url.Values) { q.Set("session", "../x") }, status: 400, reason: "query", app: "shop-web", corsSet: true},
		"negative segment": {query: func(q url.Values) { q.Set("segment", "-1") }, status: 400, reason: "query", app: "shop-web", corsSet: true},
		"huge segment":     {query: func(q url.Values) { q.Set("segment", "1000000") }, status: 400, reason: "query", app: "shop-web", corsSet: true},
		"text/plain":       {header: http.Header{"Content-Type": {"text/plain"}}, status: 415, reason: "content_type", app: "shop-web", corsSet: true},
		"brotli":           {header: http.Header{"Content-Encoding": {"br"}}, status: 415, reason: "content_encoding", app: "shop-web", corsSet: true},
		"body too large":   {body: bytes.Repeat([]byte("x"), 70000), status: 413, reason: "too_large", app: "shop-web", corsSet: true},
		"gzip bomb":        {body: bomb, gzip: true, status: 413, reason: "decompressed_too_large", app: "shop-web", corsSet: true},
		"format 2":         {env: badFormat, status: 400, reason: "envelope", app: "shop-web", corsSet: true},
		"not json":         {body: []byte("{"), status: 400, reason: "envelope", app: "shop-web", corsSet: true},
		"too many events":  {env: big, status: 413, reason: "too_many_events", app: "shop-web", corsSet: true},
		"store failure":    {store: failingReplayStore{}, status: 503, reason: "store", retry: "5", app: "shop-web", corsSet: true},
		"trailing data":    {body: []byte(`{"format":1} {}`), status: 400, reason: "envelope", app: "shop-web", corsSet: true},
		"bad gzip":         {body: []byte("not gzip"), header: http.Header{"Content-Encoding": {"gzip"}}, status: 400, reason: "decode", app: "shop-web", corsSet: true},
	} {
		t.Run(name, func(t *testing.T) {
			f := newReplayFixture(t, replayConfig, tc.store)
			q := replayQuery("shop-web")
			if tc.query != nil {
				tc.query(q)
			}
			body := tc.body
			if body == nil {
				env := tc.env
				if env == nil {
					env = sampleEnvelope()
				}
				body, _ = json.Marshal(env)
			}
			w := postReplayRaw(t, f.h, q, body, tc.gzip, tc.header)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body)
			}
			if got := w.Header().Get("Retry-After"); got != tc.retry {
				t.Errorf("Retry-After %q, want %q", got, tc.retry)
			}
			if got := w.Header().Get("Access-Control-Allow-Origin") != ""; got != tc.corsSet {
				t.Errorf("CORS set %v, want %v", got, tc.corsSet)
			}
			got := sumPoints(t, metricByName(t, f.rec.Metrics(), "o11yrum.replay.segments"))
			if n := got[set(telApp, tc.app, telOutcome, outcomeRejected, telReason, tc.reason)]; n != 1 {
				t.Errorf("rejection not recorded as %s/%s: %v", tc.app, tc.reason, got)
			}
			if tc.status != 503 {
				n := 0
				_ = f.store.List(context.Background(), "", func(ObjectInfo) error { n++; return nil })
				if n != 0 {
					t.Errorf("a refused segment stored %d objects", n)
				}
			}
		})
	}
}

func TestReplayEnvelopeValidation(t *testing.T) {
	f := newReplayFixture(t, replayConfig, nil)
	for name, mutate := range map[string]func(map[string]any){
		"no recording":      func(e map[string]any) { delete(e, "recording") },
		"short recording":   func(e map[string]any) { e["recording"] = "abc" },
		"recording charset": func(e map[string]any) { e["recording"] = "rec/0123456789" },
		"start after end":   func(e map[string]any) { e["start"] = 3000 },
		"start not number":  func(e map[string]any) { e["start"] = "1000" },
		"views not array":   func(e map[string]any) { e["views"] = map[string]any{} },
		"view without id":   func(e map[string]any) { e["views"] = []any{map[string]any{"name": "x", "at": 1}} },
		"view bad trace": func(e map[string]any) {
			e["views"] = []any{map[string]any{"id": "v", "name": "x", "at": 1, "trace_id": "Jane"}}
		},
		"request bad span": func(e map[string]any) {
			e["requests"] = []any{map[string]any{"trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "x", "at": 1}}
		},
		"events not array":   func(e map[string]any) { e["events"] = "x" },
		"event not object":   func(e map[string]any) { e["events"] = []any{1} },
		"event without time": func(e map[string]any) { e["events"] = []any{map[string]any{"type": 2}} },
		"event type string":  func(e map[string]any) { e["events"] = []any{map[string]any{"type": "2", "timestamp": 1}} },
		"too many views":     func(e map[string]any) { e["views"] = manyViews(maxReplayViews + 1) },
		"not an object":      nil,
	} {
		t.Run(name, func(t *testing.T) {
			var env any = []any{}
			if mutate != nil {
				e := sampleEnvelope()
				mutate(e)
				env = e
			}
			if w := postReplay(t, f.h, replayQuery("shop-web"), env, false); w.Code != http.StatusBadRequest {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
		})
	}
}

func manyViews(n int) []any {
	out := make([]any, n)
	for i := range out {
		out[i] = map[string]any{"id": fmt.Sprint("v", i), "name": "/", "at": 1}
	}
	return out
}

func TestReplayMethodAndRateLimit(t *testing.T) {
	f := newReplayFixture(t, strings.Replace(replayConfig, "rate_limit_per_minute: 1000", "rate_limit_per_minute: 2", 1), nil)
	r := httptest.NewRequest(http.MethodGet, "/_o11y/v1/replay", nil)
	r.RemoteAddr = "203.0.113.9:1"
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST, OPTIONS" {
		t.Fatalf("GET: %d Allow %q", w.Code, w.Header().Get("Allow"))
	}
	for i := range 2 {
		if w := postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true); w.Code != http.StatusNoContent {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w = postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("third request: %d Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
	if got := sumPoints(t, metricByName(t, f.rec.Metrics(), "o11yrum.replay.segments"))[set(telApp, "shop-web", telOutcome, outcomeRejected, telReason, "rate_limited")]; got != 1 {
		t.Errorf("rate limiting not recorded: %d", got)
	}
}

func TestReplayNeedsAStore(t *testing.T) {
	// Without any replay app and without a store, the endpoint does not
	// exist, as the source map endpoint does not.
	cfg, err := ParseConfig([]byte("apps:\n  - service_name: a\n    origins: [https://a.example]\n"))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg))
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/replay", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status %d", w.Code)
	}
}

// blockingStore holds every Put until release is closed.
type blockingStore struct {
	failingReplayStore
	entered chan struct{}
	release chan struct{}
}

func (s blockingStore) Put(context.Context, string, []byte) error {
	s.entered <- struct{}{}
	<-s.release
	return nil
}

func TestReplayConcurrencyCap(t *testing.T) {
	store := blockingStore{entered: make(chan struct{}, 4), release: make(chan struct{})}
	f := newReplayFixture(t, strings.Replace(replayConfig, "max_events: 50}", "max_events: 50, max_concurrent: 1}", 1), store)
	done := make(chan int)
	go func() { done <- postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true).Code }()
	<-store.entered
	w := postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true)
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "1" {
		t.Errorf("second request: %d Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
	close(store.release)
	<-store.entered // the first request's metadata
	if code := <-done; code != http.StatusNoContent {
		t.Fatalf("first request: %d", code)
	}
	if got := sumPoints(t, metricByName(t, f.rec.Metrics(), "o11yrum.replay.segments"))[set(telApp, "shop-web", telOutcome, outcomeRejected, telReason, "busy")]; got != 1 {
		t.Errorf("busy not recorded: %d", got)
	}
}

func TestReplaySlowUploadHoldsNoSlot(t *testing.T) {
	f := newReplayFixture(t, strings.Replace(replayConfig, "max_events: 50}", "max_events: 50, max_concurrent: 1}", 1), nil)
	pr, pw := io.Pipe()
	r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/replay?"+replayQuery("shop-web").Encode(), pr)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://shop.example")
	r.RemoteAddr = "203.0.113.7:1000"
	done := make(chan int)
	go func() {
		w := httptest.NewRecorder()
		f.h.ServeHTTP(w, r)
		done <- w.Code
	}()
	_, _ = pw.Write([]byte(`{"format":1,`)) // the upload has started and stalls
	if w := postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true); w.Code != http.StatusNoContent {
		t.Errorf("a slow upload blocked another: %d", w.Code)
	}
	_ = pw.Close()
	if code := <-done; code != http.StatusBadRequest {
		t.Errorf("truncated upload: %d", code)
	}
}

// keyedFailStore fails every write with an error naming the key, as the
// S3 store's errors do.
type keyedFailStore struct{ failingReplayStore }

func (keyedFailStore) Put(_ context.Context, key string, _ []byte) error {
	return fmt.Errorf("put %s: disk full", key)
}

func TestReplayStoreFailureLogsNoSession(t *testing.T) {
	f := newReplayFixture(t, replayConfig, keyedFailStore{})
	if w := postReplay(t, f.h, replayQuery("shop-web"), sampleEnvelope(), true); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", w.Code)
	}
	logs := f.rec.Logs()
	if len(logs) == 0 {
		t.Fatal("the store failure was not logged")
	}
	for _, l := range logs {
		if line := l.Record.Message + attrsOf(l); strings.Contains(line, replaySession) {
			t.Errorf("log %q names the session", line)
		}
	}
}
