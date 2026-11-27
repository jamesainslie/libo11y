package o11yrum

import (
	"bytes"
	"math"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/uaparse"
)

const windowsChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

func resourceWith(kv ...string) pcommon.Resource {
	res := pcommon.NewResource()
	for i := 0; i+1 < len(kv); i += 2 {
		res.Attributes().PutStr(kv[i], kv[i+1])
	}
	return res
}

func wantAttrs(t *testing.T, m pcommon.Map, want map[string]string) {
	t.Helper()
	for k, v := range want {
		got, ok := m.Get(k)
		switch {
		case v == "" && ok:
			t.Errorf("%s = %q, want it absent", k, got.AsString())
		case v != "" && !ok:
			t.Errorf("%s is absent, want %q", k, v)
		case v != "" && got.Str() != v:
			t.Errorf("%s = %q, want %q", k, got.AsString(), v)
		}
	}
}

func TestEnrichResourceWeb(t *testing.T) {
	res := resourceWith(keyPlatform, "web")
	enrichResource(res, clientInfo{country: "DE", ua: uaparse.Result{Family: "chrome", OS: "Windows", Device: "desktop"}}, "web")
	wantAttrs(t, res.Attributes(), map[string]string{
		keyBrowserFamily: "chrome", keyOSName: "Windows", keyDeviceClass: "desktop", keyCountry: "DE",
	})
}

func TestEnrichResourceWithoutPlatform(t *testing.T) {
	res := resourceWith()
	enrichResource(res, clientInfo{ua: uaparse.Result{Family: "firefox", OS: "Linux", Device: "desktop"}}, "")
	wantAttrs(t, res.Attributes(), map[string]string{
		keyBrowserFamily: "firefox", keyOSName: "Linux", keyDeviceClass: "desktop", keyCountry: "",
	})
}

func TestEnrichResourceKeepsClientDeviceClass(t *testing.T) {
	res := resourceWith(keyPlatform, "webext", keyDeviceClass, "tablet")
	enrichResource(res, clientInfo{ua: uaparse.Result{Family: "chrome", OS: "Android", Device: "mobile"}}, "webext")
	wantAttrs(t, res.Attributes(), map[string]string{keyDeviceClass: "tablet"})

	res = resourceWith(keyPlatform, "web", keyDeviceClass, "tablet")
	enrichResource(res, clientInfo{ua: uaparse.Result{Family: "chrome", OS: "Linux", Device: "bot"}}, "web")
	wantAttrs(t, res.Attributes(), map[string]string{keyDeviceClass: "bot"})
}

func TestEnrichResourceReactNative(t *testing.T) {
	res := resourceWith(keyPlatform, "react_native", keyOSName, "iOS")
	enrichResource(res, clientInfo{country: "JP", ua: uaparse.Result{OS: "", Device: "unknown"}}, "react_native")
	wantAttrs(t, res.Attributes(), map[string]string{
		keyCountry: "JP", keyOSName: "iOS", keyBrowserFamily: "", keyDeviceClass: "",
	})
	// A React Native agent that looks like a browser still gets no
	// browser family or OS from it.
	res = resourceWith(keyPlatform, "react_native")
	enrichResource(res, clientInfo{ua: uaparse.Result{Family: "chrome", OS: "Android", Device: "mobile"}}, "react_native")
	wantAttrs(t, res.Attributes(), map[string]string{keyOSName: "", keyBrowserFamily: "", keyDeviceClass: ""})
}

func TestShiftTraces(t *testing.T) {
	td := ptrace.NewTraces()
	spans := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	s := spans.AppendEmpty()
	s.SetStartTimestamp(pcommon.Timestamp(10 * time.Second))
	s.SetEndTimestamp(pcommon.Timestamp(11 * time.Second))
	s.Events().AppendEmpty().SetTimestamp(pcommon.Timestamp(10500 * time.Millisecond))
	s.Events().AppendEmpty() // zero timestamp
	shiftTraces(td, 3*time.Second)
	if s.StartTimestamp() != pcommon.Timestamp(13*time.Second) || s.EndTimestamp() != pcommon.Timestamp(14*time.Second) {
		t.Errorf("span %v to %v", s.StartTimestamp(), s.EndTimestamp())
	}
	if got := s.Events().At(0).Timestamp(); got != pcommon.Timestamp(13500*time.Millisecond) {
		t.Errorf("event %v", got)
	}
	if got := s.Events().At(1).Timestamp(); got != 0 {
		t.Errorf("an unset event timestamp became %v", got)
	}

	shiftTraces(td, -3*time.Second)
	if s.StartTimestamp() != pcommon.Timestamp(10*time.Second) {
		t.Errorf("negative shift: %v", s.StartTimestamp())
	}
}

func TestShiftLogs(t *testing.T) {
	ld := plog.NewLogs()
	lr := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	lr.SetTimestamp(pcommon.Timestamp(10 * time.Second))
	lr.SetObservedTimestamp(pcommon.Timestamp(12 * time.Second))
	unset := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().AppendEmpty()
	shiftLogs(ld, 2*time.Second)
	if lr.Timestamp() != pcommon.Timestamp(12*time.Second) || lr.ObservedTimestamp() != pcommon.Timestamp(14*time.Second) {
		t.Errorf("record %v observed %v", lr.Timestamp(), lr.ObservedTimestamp())
	}
	if unset.Timestamp() != 0 || unset.ObservedTimestamp() != 0 {
		t.Errorf("unset timestamps moved: %v %v", unset.Timestamp(), unset.ObservedTimestamp())
	}
}

var fixedNow = time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)

func newClockHandler(t *testing.T, sinks ...Sink) *Handler {
	t.Helper()
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithSinks(sinks...), WithClock(func() time.Time { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

func sentAt(d time.Duration) string {
	return strconv.FormatInt(fixedNow.Add(-d).UnixMilli(), 10)
}

func TestClientInfoSkew(t *testing.T) {
	h := newClockHandler(t)
	for name, tc := range map[string]struct {
		query string
		want  time.Duration
	}{
		"behind":          {"sent_at=" + sentAt(5*time.Second), 5 * time.Second},
		"ahead":           {"sent_at=" + sentAt(-4*time.Second), -4 * time.Second},
		"under threshold": {"sent_at=" + sentAt(200*time.Millisecond), 0},
		"not a number":    {"sent_at=soon", 0},
		"zero":            {"sent_at=0", 0},
		"absent":          {"", 0},
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/logs?"+tc.query, nil)
			if got := h.clientInfo(r, netip.Addr{}, fixedNow).skew; got != tc.want {
				t.Errorf("skew %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIngestEnriches(t *testing.T) {
	sink := &recordingSink{}
	h := newClockHandler(t, sink)
	ld := sampleLogs()
	lr := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0)
	ts := pcommon.NewTimestampFromTime(fixedNow.Add(-time.Minute))
	lr.SetTimestamp(ts)
	r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/logs?sent_at="+sentAt(10*time.Second), bytes.NewReader(logsBody(t, ld)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://shop.example")
	r.Header.Set("User-Agent", windowsChrome)
	r.RemoteAddr = "203.0.113.5:1000"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if sink.count() != 1 {
		t.Fatalf("%d batches", sink.count())
	}
	rl := sink.batches[0].Logs.ResourceLogs().At(0)
	wantAttrs(t, rl.Resource().Attributes(), map[string]string{
		keyBrowserFamily: "chrome", keyOSName: "Windows", keyDeviceClass: "desktop",
	})
	got := rl.ScopeLogs().At(0).LogRecords().At(0).Timestamp()
	if want := ts + pcommon.Timestamp(10*time.Second); got != want {
		t.Errorf("timestamp %v, want %v", got.AsTime(), want.AsTime())
	}
}

func TestIngestCountryFromTrustedProxy(t *testing.T) {
	cfg, err := ParseConfig([]byte(`
edge: {trusted_proxies: ["10.0.0.0/8"], country: {header: CF-IPCountry, trusted_from: ["173.245.48.0/20"]}}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
`))
	if err != nil {
		t.Fatal(err)
	}
	sink := &recordingSink{}
	h, err := NewHandler(WithConfig(cfg), WithSinks(sink))
	if err != nil {
		t.Fatal(err)
	}
	for _, xff := range []string{"198.51.100.1, 173.245.48.7", "198.51.100.1"} {
		r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/logs", bytes.NewReader(logsBody(t, sampleLogs())))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://shop.example")
		r.Header.Set("X-Forwarded-For", xff)
		r.Header.Set("CF-IPCountry", "NL")
		r.RemoteAddr = "10.1.2.3:443"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
	}
	wantAttrs(t, sink.batches[0].Logs.ResourceLogs().At(0).Resource().Attributes(), map[string]string{keyCountry: "NL"})
	wantAttrs(t, sink.batches[1].Logs.ResourceLogs().At(0).Resource().Attributes(), map[string]string{keyCountry: ""})
}

// walkValues calls f with every attribute key and string form of its value
// in td and ld: resources, scopes, spans, events, links and records.
func walkValues(td ptrace.Traces, ld plog.Logs, f func(k, v string)) {
	each := func(m pcommon.Map) {
		for k, v := range m.All() {
			f(k, v.AsString())
		}
	}
	for i := range td.ResourceSpans().Len() {
		rs := td.ResourceSpans().At(i)
		each(rs.Resource().Attributes())
		for j := range rs.ScopeSpans().Len() {
			ss := rs.ScopeSpans().At(j)
			each(ss.Scope().Attributes())
			for k := range ss.Spans().Len() {
				s := ss.Spans().At(k)
				each(s.Attributes())
				for e := range s.Events().Len() {
					each(s.Events().At(e).Attributes())
				}
				for l := range s.Links().Len() {
					each(s.Links().At(l).Attributes())
				}
			}
		}
	}
	for i := range ld.ResourceLogs().Len() {
		rl := ld.ResourceLogs().At(i)
		each(rl.Resource().Attributes())
		for j := range rl.ScopeLogs().Len() {
			sl := rl.ScopeLogs().At(j)
			each(sl.Scope().Attributes())
			for k := range sl.LogRecords().Len() {
				lr := sl.LogRecords().At(k)
				each(lr.Attributes())
				f("body", lr.Body().AsString())
			}
		}
	}
}

func TestIngestNeverExportsDirectClientAddress(t *testing.T) {
	const addr = "203.0.113.77"
	sink := &recordingSink{}
	h := newTestHandler(t, sink)
	plant := func(m pcommon.Map) {
		m.PutStr("client.address", addr)
		m.PutStr("network.peer.address", addr)
	}
	td := sampleTraces()
	rs := td.ResourceSpans().At(0)
	plant(rs.Resource().Attributes())
	plant(rs.ScopeSpans().At(0).Scope().Attributes())
	s := rs.ScopeSpans().At(0).Spans().At(0)
	plant(s.Attributes())
	s.Attributes().PutStr("shop.ip", addr)
	plant(s.Events().AppendEmpty().Attributes())
	link := s.Links().AppendEmpty()
	link.SetTraceID(pcommon.TraceID{2})
	link.SetSpanID(pcommon.SpanID{2})
	plant(link.Attributes())
	ld := sampleLogs()
	plant(ld.ResourceLogs().At(0).Resource().Attributes())
	plant(ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes())

	traceBody, err := ptraceotlp.NewExportRequestFromTraces(td).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, req := range []struct{ path, body string }{
		{"/_o11y/v1/traces", string(traceBody)},
		{"/_o11y/v1/logs", string(logsBody(t, ld))},
	} {
		r := httptest.NewRequest(http.MethodPost, req.path, strings.NewReader(req.body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://shop.example")
		r.Header.Set("User-Agent", windowsChrome)
		r.RemoteAddr = addr + ":1234"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: status %d: %s", req.path, w.Code, w.Body)
		}
	}
	if sink.count() != 2 {
		t.Fatalf("%d batches", sink.count())
	}
	var carriers []string
	for _, b := range sink.batches {
		td, ld := ptrace.NewTraces(), plog.NewLogs()
		if b.Signal == SignalTraces {
			td = b.Traces
		} else {
			ld = b.Logs
		}
		walkValues(td, ld, func(k, v string) {
			if strings.Contains(v, addr) {
				carriers = append(carriers, k)
			}
		})
	}
	// An app's own keys are the app's responsibility; the gateway never
	// adds the address itself.
	if len(carriers) != 1 || carriers[0] != "shop.ip" {
		t.Fatalf("the client address reached the sink in %v, want only the app's own shop.ip", carriers)
	}
}

func TestShiftSkipsBatchThatWouldGoNegative(t *testing.T) {
	td := ptrace.NewTraces()
	s := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	s.SetStartTimestamp(pcommon.Timestamp(10 * time.Second))
	s.SetEndTimestamp(pcommon.Timestamp(15 * time.Second))
	// Shifting by -12s would take the start below zero but not the end;
	// moving one and not the other would put the end before the start.
	shiftTraces(td, -12*time.Second)
	if s.StartTimestamp() != pcommon.Timestamp(10*time.Second) || s.EndTimestamp() != pcommon.Timestamp(15*time.Second) {
		t.Errorf("span moved to %v..%v", s.StartTimestamp(), s.EndTimestamp())
	}

	ld := plog.NewLogs()
	records := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords()
	a, b := records.AppendEmpty(), records.AppendEmpty()
	a.SetTimestamp(pcommon.Timestamp(2 * time.Second))
	b.SetTimestamp(pcommon.Timestamp(20 * time.Second))
	shiftLogs(ld, -5*time.Second)
	if a.Timestamp() != pcommon.Timestamp(2*time.Second) || b.Timestamp() != pcommon.Timestamp(20*time.Second) {
		t.Errorf("records moved to %v and %v", a.Timestamp(), b.Timestamp())
	}

	// Overflowing int64 upwards is skipped too.
	s.SetEndTimestamp(pcommon.Timestamp(math.MaxInt64 - 1))
	shiftTraces(td, time.Second)
	if s.StartTimestamp() != pcommon.Timestamp(10*time.Second) {
		t.Errorf("an overflowing shift moved the start to %v", s.StartTimestamp())
	}
}

func TestIngestMeasuresSkewAtArrival(t *testing.T) {
	// The clock advances while the body is decoded; the skew is measured
	// from the moment the request arrived.
	sink := &recordingSink{}
	cfg, err := ParseConfig([]byte(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	clock := func() time.Time {
		calls++
		if calls == 1 {
			return fixedNow
		}
		return fixedNow.Add(time.Hour)
	}
	h, err := NewHandler(WithConfig(cfg), WithSinks(sink), WithClock(clock))
	if err != nil {
		t.Fatal(err)
	}
	calls = 0 // the request's first reading of the clock is its arrival
	ld := sampleLogs()
	ts := pcommon.NewTimestampFromTime(fixedNow.Add(-time.Minute))
	ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).SetTimestamp(ts)
	w := send(h, http.MethodPost, "/_o11y/v1/logs?sent_at="+sentAt(10*time.Second), "application/json", "https://shop.example", "203.0.113.5:1000", logsBody(t, ld))
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	got := sink.batches[0].Logs.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Timestamp()
	if want := ts + pcommon.Timestamp(10*time.Second); got != want {
		t.Errorf("timestamp %v, want %v", got.AsTime(), want.AsTime())
	}
}

func TestEnrichResourceReplacesClientOSForBrowsers(t *testing.T) {
	// A web page's os.name is the gateway's to set; an unknown agent
	// leaves none rather than the client's own value.
	res := resourceWith(keyPlatform, "web", keyOSName, "TempleOS 9000")
	enrichResource(res, clientInfo{ua: uaparse.Result{Family: "other", Device: "unknown"}}, "web")
	wantAttrs(t, res.Attributes(), map[string]string{keyOSName: ""})
	res = resourceWith(keyOSName, "Plan 9")
	enrichResource(res, clientInfo{ua: uaparse.Result{Family: "chrome", OS: "Linux", Device: "desktop"}}, "")
	wantAttrs(t, res.Attributes(), map[string]string{keyOSName: "Linux"})
}
