package o11yrum

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
)

// dupServiceLogs is an OTLP/JSON body whose resource carries service.name
// twice. pdata keeps both: Get returns the first and AsRaw the last.
const dupServiceLogs = `{"resourceLogs":[{"resource":{"attributes":[` +
	`{"key":"service.name","value":{"stringValue":"shop-web"}},` +
	`{"key":"service.name","value":{"stringValue":"shop-mobile"}}]},` +
	`"scopeLogs":[{"logRecords":[{"body":{"stringValue":"hi"}}]}]}]}`

func TestIngestRefusesDuplicateServiceName(t *testing.T) {
	sink := &recordingSink{}
	w := send(newTestHandler(t, sink), http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.5:1000", []byte(dupServiceLogs))
	if w.Code != 400 {
		t.Fatalf("status %d, want 400", w.Code)
	}
	if sink.count() != 0 {
		t.Fatal("a batch with two service names reached the sink")
	}
}

func TestAttrPolicyRemovesDuplicateKeys(t *testing.T) {
	d, err := decodeBody(SignalLogs, "application/json", "", strings.NewReader(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[`+
		`{"key":"shop.k","value":{"stringValue":"first"}},`+
		`{"key":"shop.k","value":{"stringValue":"second"}}]}]}]}]}`), 1<<20, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	attrs := d.logs.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes()
	if attrs.Len() != 2 {
		t.Fatalf("pdata kept %d attributes; the test needs the duplicate on the wire", attrs.Len())
	}
	p := newAttrPolicy(AppConfig{PII: piiDrop}, defaultLimits())
	if got := p.apply(attrs); got != 1 {
		t.Errorf("removed %d, want 1", got)
	}
	if raw := attrs.AsRaw(); len(raw) != 1 || raw["shop.k"] != "first" {
		t.Errorf("attributes %v, want only the first shop.k", raw)
	}
}

func TestAttrPolicyCapKeepsServiceName(t *testing.T) {
	p := newAttrPolicy(AppConfig{PII: piiDrop}, LimitsConfig{MaxAttributes: 1, MaxValueLength: 64, MaxArrayLength: 4})
	m := pcommon.NewMap()
	m.PutStr("a.one", "1")
	m.PutStr("service.name", "shop-web")
	p.apply(m)
	if v, ok := m.Get("service.name"); !ok || v.Str() != "shop-web" {
		t.Fatalf("the attribute cap removed service.name: %v", m.AsRaw())
	}
}

func TestAttrPolicySecretHeadersAnyCase(t *testing.T) {
	p := newAttrPolicy(AppConfig{PII: piiAllow}, defaultLimits())
	m := pcommon.NewMap()
	m.PutStr("http.request.header.Authorization", "Bearer x")
	m.PutStr("http.response.header.Set-Cookie", "s=1")
	m.PutStr("http.request.header.COOKIE", "s=1")
	if got := p.apply(m); got != 3 || m.Len() != 0 {
		t.Fatalf("removed %d, kept %v", got, m.AsRaw())
	}
}

func TestAttrPolicyCleansEveryURLKey(t *testing.T) {
	p := newAttrPolicy(AppConfig{PII: piiDrop, QueryAllowList: []string{"page"}}, defaultLimits())
	for name, tc := range map[string]struct {
		key, in, want string
	}{
		"credentials removed":      {"url.full", "https://user:secret@api.example/x?token=a&page=1", "https://api.example/x?page=1"},
		"user without password":    {"url.full", "https://user@api.example/x", "https://api.example/x"},
		"at sign in the path kept": {"url.full", "https://api.example/u/@me", "https://api.example/u/@me"},
		"at sign in the query":     {"url.full", "https://api.example/x?e=a@b", "https://api.example/x"},
		"http.url":                 {"http.url", "https://u:p@api.example/x?token=a#f", "https://api.example/x"},
		"url.original":             {"url.original", "https://api.example/x?token=a&page=2", "https://api.example/x?page=2"},
		"http.target":              {"http.target", "/x?token=a&page=3", "/x?page=3"},
	} {
		t.Run(name, func(t *testing.T) {
			m := pcommon.NewMap()
			m.PutStr(tc.key, tc.in)
			p.apply(m)
			if v, _ := m.Get(tc.key); v.Str() != tc.want {
				t.Errorf("%s = %q, want %q", tc.key, v.Str(), tc.want)
			}
		})
	}
	m := pcommon.NewMap()
	m.PutEmptySlice("url.full").AppendEmpty().SetStr("https://api.example/x?token=a")
	if got := p.apply(m); got != 1 || m.Len() != 0 {
		t.Errorf("a non-string url.full was kept: %v", m.AsRaw())
	}
}

func TestParseConfigRefusesForwardedHeader(t *testing.T) {
	_, err := ParseConfig([]byte("edge: {forwarded_header: forwarded}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n"))
	if err == nil || !strings.Contains(err.Error(), "forwarded_header") {
		t.Fatalf("err = %v", err)
	}
}

func TestNewHandlerValidatesAndCopiesConfig(t *testing.T) {
	cfg := &Config{Apps: []AppConfig{{ServiceName: "shop-web", Origins: []string{"https://SHOP.example"}}}}
	sink := &recordingSink{}
	h, err := NewHandler(WithConfig(cfg), WithSinks(sink))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Edge.MaxBodyBytes != 0 || cfg.Apps[0].Origins[0] != "https://SHOP.example" || cfg.Apps[0].PII != "" {
		t.Errorf("NewHandler modified the caller's Config: %+v", cfg)
	}
	if w := postLogs(t, h, "shop-web", "https://shop.example", "", "203.0.113.5:1000"); w.Code != 200 || sink.count() != 1 {
		t.Fatalf("status %d, %d batches: defaults were not applied", w.Code, sink.count())
	}
	cfg.Apps[0].ServiceName = "changed"
	if w := postLogs(t, h, "shop-web", "https://shop.example", "", "203.0.113.6:1000"); w.Code != 200 {
		t.Fatalf("a later change to the caller's Config reached the handler: %d", w.Code)
	}
	if _, err := NewHandler(WithConfig(&Config{Edge: EdgeConfig{RateLimitPerMinute: -1}, Apps: cfg.Apps})); err == nil {
		t.Fatal("NewHandler accepted an invalid Config")
	}
}

type panickingSink struct{}

func (panickingSink) Name() string { return "panicking" }

func (panickingSink) Export(context.Context, Batch) error { panic("boom") }

func TestIngestSinkPanicIs503(t *testing.T) {
	after := &recordingSink{}
	w := postLogs(t, newTestHandler(t, panickingSink{}, after), "shop-web", "https://shop.example", "", "203.0.113.5:1000")
	if w.Code != 503 {
		t.Fatalf("status %d, want 503", w.Code)
	}
	if after.count() != 1 {
		t.Fatal("a panicking sink stopped the sinks after it")
	}
}

func TestExportAllRecoversPanic(t *testing.T) {
	err := exportAll(context.Background(), []Sink{panickingSink{}}, Batch{})
	if err == nil || !strings.Contains(err.Error(), "sink panicking") || !errors.Is(err, errSinkPanic) {
		t.Fatalf("err = %v", err)
	}
}

func TestWithSinksSkipsNil(t *testing.T) {
	h := newTestHandler(t, nil)
	if w := postLogs(t, h, "shop-web", "https://shop.example", "", "203.0.113.5:1000"); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
}

func TestLimiterSweepsAFullTableAtMostOncePerSecond(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newLimiter(60, 2, func() time.Time { return now })
	l.allow(1)
	l.allow(2)
	before := l.sweeps
	for k := range uint64(1000) {
		l.allow(100 + k)
	}
	if got := l.sweeps - before; got > 1 {
		t.Fatalf("%d sweeps for 1000 new clients in one instant, want at most 1", got)
	}
	now = now.Add(2 * time.Second)
	l.allow(5000)
	if l.sweeps-before > 2 {
		t.Fatalf("%d sweeps after a second passed", l.sweeps-before)
	}
}

func TestDecodeStopsAGzipBomb(t *testing.T) {
	bomb := gz(t, bytes.Repeat([]byte{' '}, 16<<20))
	if len(bomb) > 512<<10 {
		t.Fatalf("the bomb is %d bytes compressed; it must fit the body cap", len(bomb))
	}
	start := time.Now()
	_, err := decodeBody(SignalLogs, "application/json", "gzip", bytes.NewReader(bomb), 512<<10, 5<<20)
	if !errors.Is(err, errDecompressedTooLarge) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("inflating the bomb took too long")
	}
}

func TestValidateEventNameReadBeforeCap(t *testing.T) {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	lr := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	lr.Attributes().PutStr("shop.a", "1")
	lr.Attributes().PutStr("event.name", "o11y.rum.made_up")
	v := &validator{
		policy: newAttrPolicy(AppConfig{PII: piiDrop}, LimitsConfig{MaxAttributes: 1, MaxValueLength: 64, MaxArrayLength: 4}),
		limits: defaultLimits(),
	}
	if drops := v.logs(ld); drops[reasonEventUnregistered] != 1 {
		t.Fatalf("drops %v: an event name past the attribute cap escaped the check", drops)
	}
}

func TestValidateEventTemplateRequirement(t *testing.T) {
	for name, tc := range map[string]struct {
		set    func(pcommon.Map)
		reason string
	}{
		"template present": {func(m pcommon.Map) { m.PutStr("o11y.config.sampler", "always_on") }, ""},
		"template missing": {func(pcommon.Map) {}, reasonEventRequired},
	} {
		t.Run(name, func(t *testing.T) {
			ld := plog.NewLogs()
			rl := ld.ResourceLogs().AppendEmpty()
			rl.Resource().Attributes().PutStr("service.name", "shop-web")
			lr := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
			lr.SetEventName("o11y.telemetry.configured")
			tc.set(lr.Attributes())
			drops := testValidator().logs(ld)
			if tc.reason == "" && drops.total() != 0 || tc.reason != "" && drops[tc.reason] != 1 {
				t.Fatalf("drops %v, want %q", drops, tc.reason)
			}
		})
	}
}

// TestIngestNeverExportsClientAddress posts through a trusted proxy and
// checks nothing the sink receives mentions the client or proxy address.
func TestIngestNeverExportsClientAddress(t *testing.T) {
	sink := &recordingSink{}
	h := newTestHandler(t, sink)
	ld := sampleLogs()
	attrs := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes()
	attrs.PutStr("client.address", "198.51.100.77")
	attrs.PutStr("network.peer.address", "198.51.100.77")
	r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/logs", bytes.NewReader(logsBody(t, ld)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://shop.example")
	r.Header.Set("X-Forwarded-For", "198.51.100.77")
	r.RemoteAddr = "10.0.0.9:443"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || sink.count() != 1 {
		t.Fatalf("status %d, %d batches", w.Code, sink.count())
	}
	out, err := marshalLogsJSON(sink.batches[0].Logs)
	if err != nil {
		t.Fatal(err)
	}
	for _, addr := range []string{"198.51.100.77", "10.0.0.9"} {
		if strings.Contains(out, addr) {
			t.Errorf("the exported batch contains %s: %s", addr, out)
		}
	}
}

func marshalLogsJSON(ld plog.Logs) (string, error) {
	var m plog.JSONMarshaler
	b, err := m.MarshalLogs(ld)
	return string(b), err
}

func TestIngestConcurrent(t *testing.T) {
	sink := &recordingSink{}
	h := newTestHandler(t, sink)
	body := logsBody(t, sampleLogs())
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			remote := fmt.Sprintf("203.0.113.%d:1000", i%10)
			send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", remote, body)
		}()
	}
	wg.Wait()
	if sink.count() == 0 {
		t.Fatal("no request got through")
	}
}
