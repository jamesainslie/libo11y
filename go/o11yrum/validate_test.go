package o11yrum

import (
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

func testValidator() *validator {
	return &validator{policy: newAttrPolicy(AppConfig{PII: "drop"}, defaultLimits()), limits: defaultLimits()}
}

func spanIDs(s ptrace.Span) {
	s.SetTraceID(pcommon.TraceID{1})
	s.SetSpanID(pcommon.SpanID{1})
	s.SetStartTimestamp(1_000)
	s.SetEndTimestamp(2_000)
}

// viewSpan builds a span carrying every attribute the generated view shape
// requires, with a valid value for each.
func viewSpan(s ptrace.Span) {
	spanIDs(s)
	a := s.Attributes()
	a.PutStr("o11y.rum.platform", "web")
	a.PutStr("o11y.rum.view.name", "/documents/$docId")
	a.PutStr("o11y.rum.view.id", "v0")
	a.PutStr("o11y.rum.view.kind", "initial")
	a.PutStr("session.id", "s1")
	if m := defaultShapes.marker; m != "" {
		a.PutStr(m, "view")
	}
}

func TestValidateSpans(t *testing.T) {
	for name, tc := range map[string]struct {
		build  func(ptrace.Span)
		reason string // "" means kept
	}{
		"valid view":                           {viewSpan, ""},
		"view missing view.name":               {func(s ptrace.Span) { viewSpan(s); s.Attributes().Remove("o11y.rum.view.name") }, "rum_shape"},
		"view kind not a member":               {func(s ptrace.Span) { viewSpan(s); s.Attributes().PutStr("o11y.rum.view.kind", "bogus") }, "rum_shape"},
		"view marker names an unknown shape":   {func(s ptrace.Span) { viewSpan(s); s.Attributes().PutStr("o11y.rum.span.shape", "bogus") }, "rum_shape"},
		"action marker on a view span":         {func(s ptrace.Span) { viewSpan(s); s.Attributes().PutStr("o11y.rum.span.shape", "action") }, "rum_shape"},
		"marked view with a stray action type": {func(s ptrace.Span) { viewSpan(s); s.Attributes().PutStr("o11y.rum.action.type", "click") }, ""},
		"action needs session": {func(s ptrace.Span) {
			spanIDs(s)
			s.Attributes().PutStr("o11y.rum.action.type", "click")
			s.Attributes().PutStr("o11y.rum.view.id", "v0")
		}, "rum_shape"},
		"fetch span with rum ids": {func(s ptrace.Span) {
			spanIDs(s)
			s.Attributes().PutStr("o11y.rum.view.id", "v0")
			s.Attributes().PutStr("session.id", "s1")
		}, ""},
		"rum attr without view.id": {func(s ptrace.Span) {
			spanIDs(s)
			s.Attributes().PutStr("session.id", "s1")
			s.Attributes().PutStr("o11y.rum.platform", "web")
		}, "rum_shape"},
		"session without view.id":  {func(s ptrace.Span) { spanIDs(s); s.Attributes().PutStr("session.id", "s1") }, "rum_shape"},
		"plain non-rum span":       {spanIDs, ""},
		"unminted rum key removed": {func(s ptrace.Span) { spanIDs(s); s.Attributes().PutStr("o11y.rum.made_up", "x") }, ""},
		"empty trace id":           {func(s ptrace.Span) { spanIDs(s); s.SetTraceID(pcommon.TraceID{}) }, "span_id"},
		"empty span id":            {func(s ptrace.Span) { spanIDs(s); s.SetSpanID(pcommon.SpanID{}) }, "span_id"},
		"end before start":         {func(s ptrace.Span) { spanIDs(s); s.SetEndTimestamp(500) }, "span_time"},
		"zero start":               {func(s ptrace.Span) { spanIDs(s); s.SetStartTimestamp(0) }, "span_time"},
	} {
		t.Run(name, func(t *testing.T) {
			td := ptrace.NewTraces()
			rs := td.ResourceSpans().AppendEmpty()
			rs.Resource().Attributes().PutStr("service.name", "shop-web")
			tc.build(rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty())
			v := testValidator()
			drops := v.traces(td)
			if tc.reason == "" {
				if td.SpanCount() != 1 || drops.total() != 0 {
					t.Fatalf("dropped: %v", drops)
				}
				return
			}
			if td.SpanCount() != 0 || drops[tc.reason] != 1 {
				t.Fatalf("drops %v, spans %d, want one %s", drops, td.SpanCount(), tc.reason)
			}
		})
	}
}

func TestValidateSpanKeepsRUMIDsFromResource(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "shop-web")
	rs.Resource().Attributes().PutStr("session.id", "s1")
	s := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	spanIDs(s)
	s.Attributes().PutStr("o11y.rum.view.id", "v0")
	if drops := testValidator().traces(td); drops.total() != 0 {
		t.Fatalf("dropped: %v", drops)
	}
}

func TestValidateSpanCapsAndFiltersNested(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "shop-web")
	ss := rs.ScopeSpans().AppendEmpty()
	ss.Scope().Attributes().PutStr("o11y.rum.made_up", "x")
	s := ss.Spans().AppendEmpty()
	spanIDs(s)
	s.SetName(strings.Repeat("n", 5000))
	s.Status().SetMessage(strings.Repeat("m", 5000))
	for range 10 {
		e := s.Events().AppendEmpty()
		e.SetName(strings.Repeat("e", 5000))
		e.Attributes().PutStr("o11y.rum.element.text", "Pay now")
	}
	for range 10 {
		s.Links().AppendEmpty().Attributes().PutStr("http.request.header.cookie", "c")
	}
	v := &validator{
		policy: newAttrPolicy(AppConfig{PII: "drop"}, defaultLimits()),
		limits: LimitsConfig{MaxAttributes: 128, MaxValueLength: 4096, MaxArrayLength: 128, MaxSpanEvents: 8, MaxSpanLinks: 3},
	}
	if drops := v.traces(td); drops.total() != 0 {
		t.Fatalf("dropped: %v", drops)
	}
	if s.Events().Len() != 8 || s.Links().Len() != 3 {
		t.Fatalf("events %d links %d, want 8 and 3", s.Events().Len(), s.Links().Len())
	}
	if _, ok := s.Events().At(0).Attributes().Get("o11y.rum.element.text"); ok {
		t.Error("a pii attribute on a span event survived")
	}
	if s.Links().At(0).Attributes().Len() != 0 {
		t.Error("a secret attribute on a span link survived")
	}
	if ss.Scope().Attributes().Len() != 0 {
		t.Error("an unminted scope attribute survived")
	}
	if len(s.Name()) != 4096 || len(s.Status().Message()) != 4096 || len(s.Events().At(0).Name()) != 4096 {
		t.Errorf("name %d, status %d, event name %d bytes, want 4096 each", len(s.Name()), len(s.Status().Message()), len(s.Events().At(0).Name()))
	}
	// 1 scope + 8 events + 3 links; the events and links beyond the cap
	// were removed whole and are not attributes.
	if v.attrsRemoved != 12 {
		t.Errorf("attrsRemoved %d, want 12", v.attrsRemoved)
	}
}

func TestValidateRemovesEmptyContainers(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "shop-web")
	spanIDs(rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty())
	bad := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	spanIDs(bad)
	bad.SetSpanID(pcommon.SpanID{})
	if drops := testValidator().traces(td); drops["span_id"] != 1 {
		t.Fatalf("drops %v", drops)
	}
	if rs.ScopeSpans().Len() != 1 {
		t.Fatalf("%d scopes left, want the empty one removed", rs.ScopeSpans().Len())
	}
}

func TestValidateResource(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	spanIDs(rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty())
	attrs := rs.Resource().Attributes()
	for _, k := range []string{"host.name", "k8s.pod.name", "service.instance.id", "container.id", "process.pid", "cloud.region", "faas.name", "service.name", "service.version"} {
		attrs.PutStr(k, "x")
	}
	v := testValidator()
	v.traces(td)
	got := attrs.AsRaw()
	if len(got) != 2 || got["service.name"] != "x" || got["service.version"] != "x" {
		t.Fatalf("resource kept %v, want only service.name and service.version", got)
	}
	if v.attrsRemoved != 7 {
		t.Errorf("attrsRemoved %d, want 7", v.attrsRemoved)
	}
}

// summaryRecord builds a valid o11y.rum.view.summary log record.
func summaryRecord(lr plog.LogRecord) {
	a := lr.Attributes()
	a.PutStr("event.name", "o11y.rum.view.summary")
	a.PutStr("o11y.rum.platform", "web")
	a.PutStr("o11y.rum.view.id", "v0")
	a.PutStr("o11y.rum.view.name", "/documents/$docId")
	a.PutStr("o11y.rum.view.kind", "initial")
	a.PutStr("session.id", "s1")
	a.PutInt("o11y.rum.summary.seq", 0)
	a.PutDouble("o11y.rum.summary.time_on_view", 3.2)
}

func TestValidateLogs(t *testing.T) {
	for name, tc := range map[string]struct {
		build      func(plog.LogRecord)
		onResource map[string]string
		reason     string
	}{
		"valid summary":         {build: summaryRecord},
		"summary without seq":   {build: func(lr plog.LogRecord) { summaryRecord(lr); lr.Attributes().Remove("o11y.rum.summary.seq") }, reason: "event_required"},
		"summary negative seq":  {build: func(lr plog.LogRecord) { summaryRecord(lr); lr.Attributes().PutInt("o11y.rum.summary.seq", -1) }, reason: "event_required"},
		"summary seq as string": {build: func(lr plog.LogRecord) { summaryRecord(lr); lr.Attributes().PutStr("o11y.rum.summary.seq", "0") }, reason: "event_required"},
		"session on resource":   {build: func(lr plog.LogRecord) { summaryRecord(lr); lr.Attributes().Remove("session.id") }, onResource: map[string]string{"session.id": "s1"}},
		"event name field": {build: func(lr plog.LogRecord) {
			summaryRecord(lr)
			lr.Attributes().Remove("event.name")
			lr.SetEventName("o11y.rum.view.summary")
		}},
		"event name field wins": {build: func(lr plog.LogRecord) {
			summaryRecord(lr)
			lr.SetEventName("o11y.rum.view.summary")
			lr.Attributes().PutStr("event.name", "o11y.rum.made_up")
		}},
		"unregistered o11y": {build: func(lr plog.LogRecord) { lr.SetEventName("o11y.rum.made_up") }, reason: "event_unregistered"},
		"app event kept":    {build: func(lr plog.LogRecord) { lr.SetEventName("shop.checkout") }},
		"plain log kept":    {build: func(lr plog.LogRecord) { lr.Body().SetStr("hello") }},
		"error needs exc type": {build: func(lr plog.LogRecord) {
			lr.SetEventName("o11y.rum.error")
			lr.Attributes().PutStr("o11y.rum.error.source", "uncaught")
			lr.Attributes().PutStr("session.id", "s1")
			lr.Attributes().PutStr("o11y.rum.view.id", "v0")
		}, reason: "event_required"},
		"non-string event.name":  {build: func(lr plog.LogRecord) { lr.Attributes().PutInt("event.name", 1) }},
		"session start needs id": {build: func(lr plog.LogRecord) { lr.SetEventName("o11y.rum.session.start") }, reason: "event_required"},
	} {
		t.Run(name, func(t *testing.T) {
			ld := plog.NewLogs()
			rl := ld.ResourceLogs().AppendEmpty()
			rl.Resource().Attributes().PutStr("service.name", "shop-web")
			for k, v := range tc.onResource {
				rl.Resource().Attributes().PutStr(k, v)
			}
			tc.build(rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty())
			drops := testValidator().logs(ld)
			if tc.reason == "" {
				if ld.LogRecordCount() != 1 || drops.total() != 0 {
					t.Fatalf("dropped: %v", drops)
				}
				return
			}
			if ld.LogRecordCount() != 0 || drops[tc.reason] != 1 {
				t.Fatalf("drops %v, records %d, want one %s", drops, ld.LogRecordCount(), tc.reason)
			}
		})
	}
}

func TestValidateLogBody(t *testing.T) {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	records := rl.ScopeLogs().AppendEmpty().LogRecords()
	long := records.AppendEmpty()
	long.Body().SetStr(strings.Repeat("é", 3000))
	structured := records.AppendEmpty()
	body := structured.Body().SetEmptyMap()
	body.PutStr("o11y.rum.element.text", "Pay now")
	body.PutStr("shop.note", "kept")
	bytesBody := records.AppendEmpty()
	bytesBody.Body().SetEmptyBytes().FromRaw([]byte{1, 2})
	if drops := testValidator().logs(ld); drops.total() != 0 {
		t.Fatalf("dropped: %v", drops)
	}
	if n := len(long.Body().Str()); n > 4096 || n < 4094 {
		t.Errorf("string body is %d bytes, want it cut to the 4096 cap", n)
	}
	if got := structured.Body().Map().AsRaw(); len(got) != 1 || got["shop.note"] != "kept" {
		t.Errorf("map body %v, want only shop.note", got)
	}
	if bytesBody.Body().Type() != pcommon.ValueTypeEmpty {
		t.Errorf("bytes body survived as %v", bytesBody.Body().Type())
	}
}

func TestDropCountsMessage(t *testing.T) {
	d := dropCounts{"rum_shape": 2, "event_required": 1}
	if got, want := d.message(), "o11yrum dropped 3 records: event_required=1, rum_shape=2"; got != want {
		t.Errorf("message %q, want %q", got, want)
	}
	if d.total() != 3 {
		t.Errorf("total %d", d.total())
	}
	if (dropCounts{}).message() != "" {
		t.Error("an empty count has a message")
	}
}

func TestShapeDetectorFromGeneratedTable(t *testing.T) {
	for name, tc := range map[string]struct {
		set     func(pcommon.Map)
		shape   string
		claimed bool
	}{
		"view by kind":      {func(m pcommon.Map) { m.PutStr("o11y.rum.view.kind", "initial") }, "view", true},
		"action by type":    {func(m pcommon.Map) { m.PutStr("o11y.rum.action.type", "click") }, "action", true},
		"view name alone":   {func(m pcommon.Map) { m.PutStr("o11y.rum.view.name", "/a") }, "", false},
		"ids alone":         {func(m pcommon.Map) { m.PutStr("o11y.rum.view.id", "v0"); m.PutStr("session.id", "s1") }, "", false},
		"two shapes":        {func(m pcommon.Map) { m.PutStr("o11y.rum.view.kind", "soft"); m.PutStr("o11y.rum.action.type", "tap") }, "", true},
		"nothing":           {func(pcommon.Map) {}, "", false},
		"claim with no str": {func(m pcommon.Map) { m.PutInt("o11y.rum.action.type", 1) }, "action", true},
	} {
		t.Run(name, func(t *testing.T) {
			if defaultShapes.marker != "" {
				t.Skip("the generated table has a shape marker; TestShapeDetectorWithMarker covers it")
			}
			m := pcommon.NewMap()
			tc.set(m)
			shape, claimed := defaultShapes.shape(m)
			if shape != tc.shape || claimed != tc.claimed {
				t.Errorf("shape %q claimed %v, want %q %v", shape, claimed, tc.shape, tc.claimed)
			}
		})
	}
}

func TestShapeDetectorWithMarker(t *testing.T) {
	required := map[string][]string{
		"view":     {"o11y.rum.span.shape", "o11y.rum.view.kind", "session.id"},
		"action":   {"o11y.rum.span.shape", "o11y.rum.action.type", "session.id"},
		"app_load": {"o11y.rum.span.shape", "session.id"},
	}
	enums := map[string][]string{
		"o11y.rum.span.shape":  {"view", "action", "app_load"},
		"o11y.rum.view.kind":   {"initial"},
		"o11y.rum.action.type": {"click"},
	}
	d := newShapeDetector(required, enums)
	if d.marker != "o11y.rum.span.shape" {
		t.Fatalf("marker %q", d.marker)
	}
	for name, tc := range map[string]struct {
		set     func(pcommon.Map)
		shape   string
		claimed bool
	}{
		"app_load by marker":  {func(m pcommon.Map) { m.PutStr("o11y.rum.span.shape", "app_load") }, "app_load", true},
		"view by marker":      {func(m pcommon.Map) { m.PutStr("o11y.rum.span.shape", "view") }, "view", true},
		"kind without marker": {func(m pcommon.Map) { m.PutStr("o11y.rum.view.kind", "initial") }, "", false},
		"unknown marker":      {func(m pcommon.Map) { m.PutStr("o11y.rum.span.shape", "bogus") }, "", true},
		"non-string marker":   {func(m pcommon.Map) { m.PutInt("o11y.rum.span.shape", 1) }, "", true},
	} {
		t.Run(name, func(t *testing.T) {
			m := pcommon.NewMap()
			tc.set(m)
			shape, claimed := d.shape(m)
			if shape != tc.shape || claimed != tc.claimed {
				t.Errorf("shape %q claimed %v, want %q %v", shape, claimed, tc.shape, tc.claimed)
			}
		})
	}
}

func TestShapeDetectorIgnoresSharedEnums(t *testing.T) {
	// An enum every shape requires is a marker only when its members name
	// every shape; o11y.rum.platform is shared but names platforms.
	d := newShapeDetector(
		map[string][]string{"view": {"o11y.rum.platform", "o11y.rum.view.kind"}, "app_load": {"o11y.rum.platform"}},
		map[string][]string{"o11y.rum.platform": {"web"}, "o11y.rum.view.kind": {"initial"}},
	)
	if d.marker != "" {
		t.Fatalf("marker %q, want none", d.marker)
	}
	if got := d.claims["o11y.rum.view.kind"]; got != "view" || len(d.claims) != 1 {
		t.Fatalf("claims %v, want only view.kind for view", d.claims)
	}
}
