// Package fixture builds OTLP/JSON traffic for one RUM session, shaped the
// way the libo11y RUM libraries send it. The catalog test sends it through
// the real gateway so every metric family and label the gateway derives
// shows up on its Prometheus endpoint.
package fixture

import (
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

// The session the fixture describes.
const (
	Service   = "shop-web"
	Origin    = "https://shop.example"
	SessionID = "0b7e5c1e-6f2a-4c55-9b1e-1f2d3c4b5a69"
	View0     = "v0-3f1c"
	View1     = "v1-9a2e"
)

// The gateway's public paths: OTLP, and the source map upload.
const (
	PathTraces     = "/_o11y/v1/traces"
	PathLogs       = "/_o11y/v1/logs"
	PathSourcemaps = "/_o11y/v1/sourcemaps"
)

// The release Symbolicated traffic comes from, and the minified script its
// stack names. The source map from SourceMap is uploaded for this pair.
const (
	Version   = "1.4.0"
	ScriptURL = Origin + "/assets/app.min.js"
)

// Unminted is an o11y.* key the specification does not define. The
// gateway's policy removes it, so Policy traffic moves the attributes
// removed counter.
const Unminted = "o11y.fixture.unminted"

// The values the summaries cover. The fixture test checks them against the
// spec registry, so a new enum member fails the test until it is added.
var (
	errorSources     = []string{"uncaught", "unhandled_rejection", "console", "boundary", "resource", "csp", "network", "crash", "anr", "hang", "custom"}
	frustrationTypes = []string{"rage", "dead", "error"}
)

// Request is one POST the fixture sends to the gateway's public handler.
type Request struct {
	Path string // PathTraces or PathLogs
	Body []byte // OTLP/JSON
}

// view is one view of the session.
type view struct {
	id, name, kind      string
	start               time.Duration // from the session start
	lcp, inp, cls, fcp  float64
	ttfb, timeOnViewSec float64
}

// The initial view is slow, so every vital rating appears across the two.
var views = []view{
	{id: View0, name: "/products", kind: "initial", start: 0, lcp: 4.2, inp: 0.35, cls: 0.12, fcp: 1.1, ttfb: 0.4, timeOnViewSec: 5},
	{id: View1, name: "/products/:id", kind: "soft", start: 5 * time.Second, lcp: 1.9, inp: 0.1, cls: 0.02, fcp: 0.9, ttfb: 0.3, timeOnViewSec: 4},
}

// Traffic returns the requests for one session that started at now: an
// initial view and a soft view with view, action, fetch and app_load
// spans; a view summary per view with every vital, every error source
// count and every frustration type count, requests and long animation
// frames; two o11y.rum.error events, one o11y.rum.frustration event, and
// the session start.
func Traffic(now time.Time) []Request {
	return []Request{
		{Path: PathTraces, Body: mustJSON(ptraceotlp.NewExportRequestFromTraces(spans(now)).MarshalJSON())},
		{Path: PathLogs, Body: mustJSON(plogotlp.NewExportRequestFromLogs(events(now)).MarshalJSON())},
	}
}

// Policy returns a logs request the gateway accepts in part: an
// o11y.rum.error without exception.type, which validation drops, and a
// log record carrying Unminted, which the policy removes.
func Policy(now time.Time) Request {
	ld, sl := newLogs()
	broken := record(sl, now.Add(9*time.Second), "o11y.rum.error", View1)
	broken.Attributes().PutStr("o11y.rum.error.source", "uncaught")
	kept := sl.LogRecords().AppendEmpty()
	kept.SetTimestamp(pcommon.NewTimestampFromTime(now.Add(9 * time.Second)))
	kept.Body().SetStr("fixture: a record with an attribute the policy removes")
	kept.Attributes().PutStr("session.id", SessionID)
	kept.Attributes().PutStr("o11y.rum.view.id", View1)
	kept.Attributes().PutStr(Unminted, "removed")
	return Request{Path: PathLogs, Body: mustJSON(plogotlp.NewExportRequestFromLogs(ld).MarshalJSON())}
}

// Bad returns a request the gateway refuses because its Origin is not one
// the app allows, and the headers to send it with.
func Bad(now time.Time) (Request, http.Header) {
	ld, sl := newLogs()
	record(sl, now, "o11y.rum.session.start", "")
	h := http.Header{}
	h.Set("Origin", "https://elsewhere.example")
	h.Set("Content-Type", "application/json")
	return Request{Path: PathLogs, Body: mustJSON(plogotlp.NewExportRequestFromLogs(ld).MarshalJSON())}, h
}

func resource(m pcommon.Map) {
	m.PutStr("service.name", Service)
	m.PutStr("o11y.rum.platform", "web")
	m.PutStr("telemetry.sdk.language", "webjs")
}

func spans(now time.Time) ptrace.Traces {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	resource(rs.Resource().Attributes())
	ss := rs.ScopeSpans().AppendEmpty()
	ss.Scope().SetName("@libo11y/rum")
	at := func(d time.Duration) pcommon.Timestamp { return pcommon.NewTimestampFromTime(now.Add(d)) }

	// The initial view and the app load inside it.
	v0 := span(ss, 1, 1, 0, views[0].name, ptrace.SpanKindInternal, at(0), at(5*time.Second))
	viewAttrs(v0, views[0])
	load := span(ss, 1, 2, 1, "app_load", ptrace.SpanKindInternal, at(0), at(1500*time.Millisecond))
	rum(load, View0)
	load.Attributes().PutStr("o11y.rum.span.shape", "app_load")

	// The soft view, a click on it and the fetch the click made.
	v1 := span(ss, 2, 3, 0, views[1].name, ptrace.SpanKindInternal, at(5*time.Second), at(9*time.Second))
	viewAttrs(v1, views[1])
	click := span(ss, 2, 4, 3, "click button#add-to-cart", ptrace.SpanKindInternal, at(6*time.Second), at(6200*time.Millisecond))
	rum(click, View1)
	click.Attributes().PutStr("o11y.rum.span.shape", "action")
	click.Attributes().PutStr("o11y.rum.action.type", "click")
	fetch := span(ss, 2, 5, 4, "POST", ptrace.SpanKindClient, at(6050*time.Millisecond), at(6180*time.Millisecond))
	rum(fetch, View1)
	fetch.Attributes().PutStr("http.request.method", "POST")
	fetch.Attributes().PutStr("url.full", Origin+"/api/cart")
	fetch.Attributes().PutInt("http.response.status_code", 200)
	return td
}

// span appends a span. trace, id and parent are small numbers turned into
// fixed IDs, so the traffic is the same on every call; parent 0 is a root.
func span(ss ptrace.ScopeSpans, trace, id, parent byte, name string, kind ptrace.SpanKind, start, end pcommon.Timestamp) ptrace.Span {
	s := ss.Spans().AppendEmpty()
	s.SetTraceID(pcommon.TraceID{0x0b, 0x7e, 15: trace})
	s.SetSpanID(pcommon.SpanID{0x5e, 7: id})
	if parent != 0 {
		s.SetParentSpanID(pcommon.SpanID{0x5e, 7: parent})
	}
	s.SetName(name)
	s.SetKind(kind)
	s.SetStartTimestamp(start)
	s.SetEndTimestamp(end)
	return s
}

func rum(s ptrace.Span, viewID string) {
	s.Attributes().PutStr("session.id", SessionID)
	s.Attributes().PutStr("o11y.rum.view.id", viewID)
}

func viewAttrs(s ptrace.Span, v view) {
	rum(s, v.id)
	a := s.Attributes()
	a.PutStr("o11y.rum.span.shape", "view")
	a.PutStr("o11y.rum.platform", "web")
	a.PutStr("o11y.rum.view.name", v.name)
	a.PutStr("o11y.rum.view.kind", v.kind)
}

func newLogs() (plog.Logs, plog.ScopeLogs) {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	resource(rl.Resource().Attributes())
	sl := rl.ScopeLogs().AppendEmpty()
	sl.Scope().SetName("@libo11y/rum")
	return ld, sl
}

// record appends an event. It names the event in the EventName field and
// in the event.name attribute, as the libo11y cores do.
func record(sl plog.ScopeLogs, at time.Time, name, viewID string) plog.LogRecord {
	lr := sl.LogRecords().AppendEmpty()
	ts := pcommon.NewTimestampFromTime(at)
	lr.SetTimestamp(ts)
	lr.SetObservedTimestamp(ts)
	lr.SetEventName(name)
	a := lr.Attributes()
	a.PutStr("event.name", name)
	a.PutStr("session.id", SessionID)
	if viewID != "" {
		a.PutStr("o11y.rum.view.id", viewID)
	}
	return lr
}

func events(now time.Time) plog.Logs {
	ld, sl := newLogs()
	record(sl, now, "o11y.rum.session.start", "")

	for i, v := range views {
		viewEnd := now.Add(v.start + time.Duration(v.timeOnViewSec*float64(time.Second)))
		e := record(sl, now.Add(v.start+time.Second), "o11y.rum.error", v.id)
		e.SetSeverityNumber(plog.SeverityNumberError)
		e.SetSeverityText("ERROR")
		e.Attributes().PutStr("o11y.rum.error.source", "uncaught")
		e.Attributes().PutStr("exception.type", "TypeError")
		e.Attributes().PutStr("o11y.rum.view.name", v.name)
		if i == 1 {
			f := record(sl, now.Add(v.start+2*time.Second), "o11y.rum.frustration", v.id)
			f.Attributes().PutStr("o11y.rum.frustration.type", "rage")
			f.Attributes().PutStr("o11y.rum.view.name", v.name)
			f.Attributes().PutStr("o11y.rum.element.selector", "button#add-to-cart")
		}
		summary(record(sl, viewEnd, "o11y.rum.view.summary", v.id), v)
	}
	return ld
}

func summary(lr plog.LogRecord, v view) {
	a := lr.Attributes()
	a.PutStr("o11y.rum.view.name", v.name)
	a.PutStr("o11y.rum.view.kind", v.kind)
	a.PutStr("o11y.rum.device.class", "desktop")
	a.PutStr("o11y.rum.connection.effective", "4g")
	a.PutInt("o11y.rum.summary.seq", 0)
	a.PutDouble("o11y.rum.summary.time_on_view", v.timeOnViewSec)
	a.PutInt("o11y.rum.summary.requests", 3)
	a.PutInt("o11y.rum.summary.long_animation_frames", 2)
	for _, src := range errorSources {
		a.PutInt("o11y.rum.summary.errors."+src, 1)
	}
	for _, typ := range frustrationTypes {
		a.PutInt("o11y.rum.summary.frustrations."+typ, 1)
	}
	a.PutDouble("o11y.rum.summary.lcp.value", v.lcp)
	a.PutDouble("o11y.rum.summary.inp.value", v.inp)
	a.PutDouble("o11y.rum.summary.cls.value", v.cls)
	a.PutDouble("o11y.rum.summary.fcp.value", v.fcp)
	a.PutDouble("o11y.rum.summary.ttfb.value", v.ttfb)
}

// mustJSON unwraps a marshal of a request the fixture built itself, which
// cannot fail.
func mustJSON(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("fixture: marshal OTLP/JSON: %v", err))
	}
	return b
}

// Symbolicated returns a logs request from release Version with one
// o11y.rum.error whose stack has a frame in ScriptURL. Sent after
// SourceMap is uploaded, it moves the symbolication frames counter.
func Symbolicated(now time.Time) Request {
	ld, sl := newLogs()
	ld.ResourceLogs().At(0).Resource().Attributes().PutStr("service.version", Version)
	e := record(sl, now.Add(7*time.Second), "o11y.rum.error", View1)
	e.SetSeverityNumber(plog.SeverityNumberError)
	e.SetSeverityText("ERROR")
	a := e.Attributes()
	a.PutStr("o11y.rum.error.source", "uncaught")
	a.PutStr("o11y.rum.view.name", views[1].name)
	a.PutStr("exception.type", "TypeError")
	a.PutStr("exception.message", "cart is undefined")
	a.PutStr("exception.stacktrace", "TypeError: cart is undefined\n    at n ("+ScriptURL+":1:1)")
	return Request{Path: PathLogs, Body: mustJSON(plogotlp.NewExportRequestFromLogs(ld).MarshalJSON())}
}

// SourceMap returns a version 3 source map for ScriptURL that maps its
// first column to addToCart in src/cart.ts.
func SourceMap() []byte {
	return []byte(`{"version":3,"file":"app.min.js","sources":["src/cart.ts"],"names":["addToCart"],"mappings":"AAAAA"}`)
}
