package o11yrum

import (
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

// collectorRequest is one request the fake collector received, with its
// body decompressed.
type collectorRequest struct {
	path   string
	header http.Header
	body   []byte
}

// fakeCollector records requests and answers with status.
func fakeCollector(t *testing.T, status int) (*httptest.Server, func() []collectorRequest) {
	t.Helper()
	var mu sync.Mutex
	var got []collectorRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			zr, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Errorf("gzip: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			body = zr
		}
		raw, err := io.ReadAll(body)
		if err != nil {
			t.Errorf("read: %v", err)
		}
		mu.Lock()
		got = append(got, collectorRequest{path: r.URL.Path, header: r.Header.Clone(), body: raw})
		mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []collectorRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]collectorRequest(nil), got...)
	}
}

func newSink(t *testing.T, cfg OTLPSinkConfig) *OTLPSink {
	t.Helper()
	s, err := NewOTLPSink(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestOTLPSinkTraces(t *testing.T) {
	srv, got := fakeCollector(t, http.StatusOK)
	s := newSink(t, OTLPSinkConfig{Endpoint: srv.URL, Headers: map[string]string{"X-Scope-OrgID": "lor"}})
	if s.Name() != "otlp" {
		t.Errorf("name %q", s.Name())
	}
	if err := s.Export(context.Background(), Batch{Service: "shop-web", Signal: SignalTraces, Traces: sampleTraces()}); err != nil {
		t.Fatal(err)
	}
	reqs := got()
	if len(reqs) != 1 {
		t.Fatalf("%d requests", len(reqs))
	}
	r := reqs[0]
	if r.path != "/v1/traces" || r.header.Get("Content-Type") != "application/x-protobuf" ||
		r.header.Get("Content-Encoding") != "gzip" || r.header.Get("X-Scope-OrgID") != "lor" {
		t.Errorf("path %s headers %v", r.path, r.header)
	}
	req := ptraceotlp.NewExportRequest()
	if err := req.UnmarshalProto(r.body); err != nil {
		t.Fatal(err)
	}
	if n := req.Traces().SpanCount(); n != 1 {
		t.Errorf("%d spans", n)
	}
}

func TestOTLPSinkLogs(t *testing.T) {
	srv, got := fakeCollector(t, http.StatusOK)
	s := newSink(t, OTLPSinkConfig{Endpoint: srv.URL + "/", Compression: "none"})
	if err := s.Export(context.Background(), Batch{Service: "shop-web", Signal: SignalLogs, Logs: sampleLogs()}); err != nil {
		t.Fatal(err)
	}
	reqs := got()
	if len(reqs) != 1 || reqs[0].path != "/v1/logs" || reqs[0].header.Get("Content-Encoding") != "" {
		t.Fatalf("requests %+v", reqs)
	}
	req := plogotlp.NewExportRequest()
	if err := req.UnmarshalProto(reqs[0].body); err != nil {
		t.Fatal(err)
	}
	if n := req.Logs().LogRecordCount(); n != 1 {
		t.Errorf("%d records", n)
	}
}

func TestOTLPSinkEndpointWithPath(t *testing.T) {
	srv, got := fakeCollector(t, http.StatusOK)
	s := newSink(t, OTLPSinkConfig{Endpoint: srv.URL + "/otlp"})
	if err := s.Export(context.Background(), Batch{Signal: SignalTraces, Traces: sampleTraces()}); err != nil {
		t.Fatal(err)
	}
	if reqs := got(); len(reqs) != 1 || reqs[0].path != "/otlp/v1/traces" {
		t.Fatalf("requests %+v", reqs)
	}
}

func TestOTLPSinkErrors(t *testing.T) {
	down, _ := fakeCollector(t, http.StatusServiceUnavailable)
	s := newSink(t, OTLPSinkConfig{Endpoint: down.URL})
	err := s.Export(context.Background(), Batch{Signal: SignalLogs, Logs: sampleLogs()})
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Errorf("503: err = %v", err)
	}

	closed, _ := fakeCollector(t, http.StatusOK)
	closed.Close()
	if err := newSink(t, OTLPSinkConfig{Endpoint: closed.URL}).Export(context.Background(), Batch{Signal: SignalLogs, Logs: sampleLogs()}); err == nil {
		t.Error("a closed collector gave no error")
	}

	if err := s.Export(context.Background(), Batch{Signal: SignalMetrics}); err == nil {
		t.Error("an unsupported signal gave no error")
	}
}

func TestOTLPSinkTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	s := newSink(t, OTLPSinkConfig{Endpoint: srv.URL, Timeout: 50 * time.Millisecond})
	start := time.Now()
	if err := s.Export(context.Background(), Batch{Signal: SignalLogs, Logs: sampleLogs()}); err == nil {
		t.Fatal("a stalled collector gave no error")
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("export took %v", d)
	}
}

func TestNewOTLPSinkValidates(t *testing.T) {
	for name, cfg := range map[string]OTLPSinkConfig{
		"empty endpoint":  {},
		"not a url":       {Endpoint: "collector:4318"},
		"bad compression": {Endpoint: "http://collector:4318", Compression: "zstd"},
		"bad scheme":      {Endpoint: "ftp://collector:4318"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewOTLPSink(cfg); err == nil {
				t.Fatal("no error")
			}
		})
	}
}

func TestParseConfigSinks(t *testing.T) {
	cfg, err := ParseConfig([]byte(`
apps:
  - {service_name: a, origins: ["https://a"]}
sinks:
  otlp:
    endpoint: http://collector:4318
    headers: {X-Scope-OrgID: lor}
    timeout: 2s
    compression: none
`))
	if err != nil {
		t.Fatal(err)
	}
	o := cfg.Sinks.OTLP
	if o.Endpoint != "http://collector:4318" || o.Headers["X-Scope-OrgID"] != "lor" || o.Timeout != 2*time.Second || o.Compression != "none" {
		t.Fatalf("%+v", o)
	}
	clone := cfg.clone()
	clone.Sinks.OTLP.Headers["X-Scope-OrgID"] = "other"
	if cfg.Sinks.OTLP.Headers["X-Scope-OrgID"] != "lor" {
		t.Error("clone shares the headers map")
	}
}
