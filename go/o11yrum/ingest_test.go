package o11yrum

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

type recordingSink struct {
	mu      sync.Mutex
	batches []Batch
	err     error
}

func (s *recordingSink) Name() string { return "recording" }

func (s *recordingSink) Export(_ context.Context, b Batch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.batches = append(s.batches, b)
	return nil
}

func (s *recordingSink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.batches)
}

const testConfig = `
edge: {rate_limit_per_minute: 3, trusted_proxies: ["10.0.0.0/8"], max_body_bytes: 4096}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
  - service_name: shop-mobile
    allow_missing_origin: true
    client_token: pub-123
  - service_name: shop-off
    origins: ["https://shop.example"]
    disabled: true
`

func newTestHandler(t *testing.T, sinks ...Sink) *Handler {
	t.Helper()
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithSinks(sinks...))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func logsBody(t *testing.T, ld plog.Logs) []byte {
	t.Helper()
	body, err := plogotlp.NewExportRequestFromLogs(ld).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func send(h http.Handler, method, target, ctype, origin, remote string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, bytes.NewReader(body))
	if ctype != "" {
		r.Header.Set("Content-Type", ctype)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func postLogs(t *testing.T, h http.Handler, service, origin, query, remote string) *httptest.ResponseRecorder {
	t.Helper()
	ld := sampleLogs()
	ld.ResourceLogs().At(0).Resource().Attributes().PutStr("service.name", service)
	return send(h, http.MethodPost, "/_o11y/v1/logs"+query, "application/json", origin, remote, logsBody(t, ld))
}

func TestIngestEdge(t *testing.T) {
	for name, tc := range map[string]struct {
		service, origin, query string
		want                   int
	}{
		"accepted":              {"shop-web", "https://shop.example", "", 200},
		"origin case and port":  {"shop-web", "https://SHOP.example:443", "", 200},
		"origin not allowed":    {"shop-web", "https://evil.example", "", 403},
		"origin missing":        {"shop-web", "", "", 403},
		"unknown service":       {"nope", "https://shop.example", "", 403},
		"disabled app":          {"shop-off", "https://shop.example", "", 403},
		"mobile without origin": {"shop-mobile", "", "?client_token=pub-123", 200},
		"mobile wrong token":    {"shop-mobile", "", "?client_token=nope", 403},
		"mobile missing token":  {"shop-mobile", "", "", 403},
		"mobile foreign origin": {"shop-mobile", "https://shop.example", "?client_token=pub-123", 403},
	} {
		t.Run(name, func(t *testing.T) {
			sink := &recordingSink{}
			w := postLogs(t, newTestHandler(t, sink), tc.service, tc.origin, tc.query, "203.0.113.5:1000")
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body)
			}
			wantBatches := 0
			if tc.want == 200 {
				wantBatches = 1
			}
			if sink.count() != wantBatches {
				t.Fatalf("%d batches reached the sink", sink.count())
			}
		})
	}
}

func TestIngestSetsCORSForAdmittedOrigin(t *testing.T) {
	w := postLogs(t, newTestHandler(t), "shop-web", "https://shop.example", "", "203.0.113.5:1000")
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://shop.example" {
		t.Errorf("Access-Control-Allow-Origin %q", got)
	}
	if got := w.Header().Values("Vary"); len(got) != 1 || got[0] != "Origin" {
		t.Errorf("Vary %q", got)
	}
	w = postLogs(t, newTestHandler(t), "shop-web", "https://evil.example", "", "203.0.113.5:1000")
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("a refused origin got Access-Control-Allow-Origin %q", got)
	}
}

func TestIngestRateLimitPerClient(t *testing.T) {
	h := newTestHandler(t, &recordingSink{})
	for i := range 3 {
		if w := postLogs(t, h, "shop-web", "https://shop.example", "", "203.0.113.5:1000"); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := postLogs(t, h, "shop-web", "https://shop.example", "", "203.0.113.5:2000")
	if w.Code != 429 || w.Header().Get("Retry-After") != "20" {
		t.Fatalf("status %d Retry-After %q, want 429 and 20", w.Code, w.Header().Get("Retry-After"))
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://shop.example" {
		t.Errorf("a rate-limited browser cannot read the refusal: Access-Control-Allow-Origin %q", got)
	}
	if got := w.Header().Get("Access-Control-Expose-Headers"); got != "Retry-After" {
		t.Errorf("Access-Control-Expose-Headers %q", got)
	}
	if w := postLogs(t, h, "shop-web", "https://shop.example", "", "203.0.113.6:1000"); w.Code != 200 {
		t.Fatalf("another client got %d", w.Code)
	}
}

func TestIngestRateLimitBehindTrustedProxy(t *testing.T) {
	h := newTestHandler(t, &recordingSink{})
	post := func(xff string) int {
		ld := sampleLogs()
		r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/logs", bytes.NewReader(logsBody(t, ld)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://shop.example")
		r.Header.Set("X-Forwarded-For", xff)
		r.RemoteAddr = "10.0.0.1:443"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	for range 3 {
		post("198.51.100.1")
	}
	if got := post("198.51.100.1"); got != 429 {
		t.Fatalf("fourth request from one client behind the proxy: %d, want 429", got)
	}
	if got := post("198.51.100.2"); got != 200 {
		t.Fatalf("another client behind the same proxy: %d, want 200", got)
	}
}

func TestIngestSinkFailureIs503(t *testing.T) {
	h := newTestHandler(t, &recordingSink{err: errors.New("collector down")})
	w := postLogs(t, h, "shop-web", "https://shop.example", "", "203.0.113.5:1000")
	if w.Code != 503 || w.Header().Get("Retry-After") != "5" {
		t.Fatalf("status %d Retry-After %q, want 503 and 5", w.Code, w.Header().Get("Retry-After"))
	}
}

func TestIngestPartialSuccess(t *testing.T) {
	sink := &recordingSink{}
	h := newTestHandler(t, sink)
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	records := rl.ScopeLogs().AppendEmpty().LogRecords()
	summaryRecord(records.AppendEmpty())
	bad := records.AppendEmpty()
	summaryRecord(bad)
	bad.Attributes().Remove("o11y.rum.summary.seq")
	w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.5:1000", logsBody(t, ld))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	resp := plogotlp.NewExportResponse()
	if err := resp.UnmarshalJSON(w.Body.Bytes()); err != nil {
		t.Fatal(err)
	}
	if got := resp.PartialSuccess().RejectedLogRecords(); got != 1 {
		t.Errorf("rejected %d, want 1", got)
	}
	if msg := resp.PartialSuccess().ErrorMessage(); !strings.Contains(msg, "event_required=1") {
		t.Errorf("message %q", msg)
	}
	if sink.count() != 1 || sink.batches[0].Logs.LogRecordCount() != 1 || sink.batches[0].Service != "shop-web" || sink.batches[0].Signal != SignalLogs {
		t.Fatalf("sink got %+v", sink.batches)
	}
}

func TestIngestAllDroppedSkipsSinks(t *testing.T) {
	sink := &recordingSink{}
	h := newTestHandler(t, sink)
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty().SetEventName("o11y.rum.made_up")
	w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.5:1000", logsBody(t, ld))
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if sink.count() != 0 {
		t.Fatal("a batch with nothing left reached the sink")
	}
}

func TestIngestTraces(t *testing.T) {
	sink := &recordingSink{}
	h := newTestHandler(t, sink)
	body, err := ptraceotlp.NewExportRequestFromTraces(sampleTraces()).MarshalProto()
	if err != nil {
		t.Fatal(err)
	}
	w := send(h, http.MethodPost, "/_o11y/v1/traces", "application/x-protobuf", "https://shop.example", "203.0.113.5:1000", body)
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	resp := ptraceotlp.NewExportResponse()
	if err := resp.UnmarshalProto(w.Body.Bytes()); err != nil {
		t.Fatal(err)
	}
	if resp.PartialSuccess().RejectedSpans() != 0 {
		t.Errorf("rejected %d", resp.PartialSuccess().RejectedSpans())
	}
	if sink.count() != 1 || sink.batches[0].Signal != SignalTraces || sink.batches[0].Traces.SpanCount() != 1 {
		t.Fatalf("sink got %+v", sink.batches)
	}
}

func TestIngestMixedServiceIs400(t *testing.T) {
	ld := sampleLogs()
	other := ld.ResourceLogs().AppendEmpty()
	other.Resource().Attributes().PutStr("service.name", "shop-mobile")
	other.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	missing := sampleLogs()
	missing.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	for name, ld := range map[string]plog.Logs{"two services": ld, "one missing": missing} {
		t.Run(name, func(t *testing.T) {
			w := send(newTestHandler(t), http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.5:1000", logsBody(t, ld))
			if w.Code != 400 {
				t.Fatalf("status %d, want 400", w.Code)
			}
		})
	}
}

func TestIngestEmptyBatch(t *testing.T) {
	sink := &recordingSink{}
	w := send(newTestHandler(t, sink), http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.5:1000", []byte("{}"))
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if sink.count() != 0 {
		t.Fatal("an empty batch reached the sink")
	}
}

func TestIngestResponseMatchesEncoding(t *testing.T) {
	h := newTestHandler(t)
	proto, err := plogotlp.NewExportRequestFromLogs(sampleLogs()).MarshalProto()
	if err != nil {
		t.Fatal(err)
	}
	w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/x-protobuf", "https://shop.example", "203.0.113.5:1000", proto)
	if got := w.Header().Get("Content-Type"); w.Code != 200 || got != "application/x-protobuf" {
		t.Errorf("protobuf request: %d %q", w.Code, got)
	}
	w = send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.6:1000", logsBody(t, sampleLogs()))
	if got := w.Header().Get("Content-Type"); w.Code != 200 || got != "application/json" {
		t.Errorf("json request: %d %q", w.Code, got)
	}
}

func TestIngestStatusCodes(t *testing.T) {
	body := logsBody(t, sampleLogs())
	big := sampleLogs()
	big.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Body().SetStr(strings.Repeat("x", 8192))
	for name, tc := range map[string]struct {
		method, target, ctype, encoding, remote string
		body                                    []byte
		want                                    int
	}{
		"get":             {http.MethodGet, "/_o11y/v1/logs", "", "", "203.0.113.5:1000", nil, 405},
		"text/plain":      {http.MethodPost, "/_o11y/v1/logs", "text/plain", "", "203.0.113.5:1000", body, 415},
		"too large":       {http.MethodPost, "/_o11y/v1/logs", "application/json", "", "203.0.113.5:1000", logsBody(t, big), 413},
		"brotli":          {http.MethodPost, "/_o11y/v1/logs", "application/json", "br", "203.0.113.5:1000", body, 415},
		"garbage":         {http.MethodPost, "/_o11y/v1/logs", "application/json", "", "203.0.113.5:1000", []byte("{"), 400},
		"unknown path":    {http.MethodPost, "/_o11y/v1/unknown", "application/json", "", "203.0.113.5:1000", body, 404},
		"bad remote addr": {http.MethodPost, "/_o11y/v1/logs", "application/json", "", "pipe", body, 400},
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.target, bytes.NewReader(tc.body))
			r.Header.Set("Origin", "https://shop.example")
			if tc.ctype != "" {
				r.Header.Set("Content-Type", tc.ctype)
			}
			if tc.encoding != "" {
				r.Header.Set("Content-Encoding", tc.encoding)
			}
			r.RemoteAddr = tc.remote
			w := httptest.NewRecorder()
			newTestHandler(t).ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d", w.Code, tc.want)
			}
			if tc.want == 405 && w.Header().Get("Allow") != "POST, OPTIONS" {
				t.Errorf("Allow %q", w.Header().Get("Allow"))
			}
		})
	}
}

func TestPreflight(t *testing.T) {
	h := newTestHandler(t)
	w := send(h, http.MethodOptions, "/_o11y/v1/logs", "", "https://shop.example", "203.0.113.5:1000", nil)
	if w.Code != 204 {
		t.Fatalf("status %d", w.Code)
	}
	for k, want := range map[string]string{
		"Access-Control-Allow-Origin":  "https://shop.example",
		"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Content-Encoding, Authorization",
		"Access-Control-Max-Age":       "86400",
		"Vary":                         "Origin",
	} {
		if got := w.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	w = send(h, http.MethodOptions, "/_o11y/v1/logs", "", "https://evil.example", "203.0.113.5:1000", nil)
	if w.Code != 403 || w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unknown origin: status %d, Access-Control-Allow-Origin %q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
	}
	if w := send(h, http.MethodOptions, "/elsewhere", "", "https://shop.example", "203.0.113.5:1000", nil); w.Code != 404 {
		t.Fatalf("preflight outside /_o11y/v1/: status %d", w.Code)
	}
}

// mutatingSink tries to change the batch it receives and records whether
// pdata refused.
type mutatingSink struct{ panicked bool }

func (s *mutatingSink) Name() string { return "mutating" }

func (s *mutatingSink) Export(_ context.Context, b Batch) error {
	defer func() { s.panicked = recover() != nil }()
	b.Logs.ResourceLogs().AppendEmpty()
	return nil
}

func TestSinkBatchIsReadOnly(t *testing.T) {
	sink := &mutatingSink{}
	if w := postLogs(t, newTestHandler(t, sink), "shop-web", "https://shop.example", "", "203.0.113.5:1000"); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if !sink.panicked {
		t.Fatal("a sink modified the shared batch")
	}
}

func TestNewHandlerRequiresConfig(t *testing.T) {
	if _, err := NewHandler(); err == nil || !strings.Contains(err.Error(), "WithConfig") {
		t.Fatalf("err = %v", err)
	}
}

func TestNewHandlerClock(t *testing.T) {
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithSDK(nil), WithClock(nil))
	if err != nil {
		t.Fatal(err)
	}
	if h.now == nil {
		t.Fatal("WithClock(nil) left the handler without a clock")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal("a second Close failed")
	}
}
