package fixture

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"gopkg.in/yaml.v3"
)

var now = time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)

// decoded is every record of a set of requests, with its resource.
type decoded struct {
	spans []spanAt
	logs  []logAt
}

type spanAt struct {
	span ptrace.Span
	res  pcommon.Map
}

type logAt struct {
	rec plog.LogRecord
	res pcommon.Map
}

func decode(t *testing.T, reqs []Request) decoded {
	t.Helper()
	var d decoded
	for _, r := range reqs {
		switch r.Path {
		case PathTraces:
			req := ptraceotlp.NewExportRequest()
			if err := req.UnmarshalJSON(r.Body); err != nil {
				t.Fatalf("%s: %v", r.Path, err)
			}
			rss := req.Traces().ResourceSpans()
			for i := range rss.Len() {
				rs := rss.At(i)
				for j := range rs.ScopeSpans().Len() {
					spans := rs.ScopeSpans().At(j).Spans()
					for k := range spans.Len() {
						d.spans = append(d.spans, spanAt{spans.At(k), rs.Resource().Attributes()})
					}
				}
			}
		case PathLogs:
			req := plogotlp.NewExportRequest()
			if err := req.UnmarshalJSON(r.Body); err != nil {
				t.Fatalf("%s: %v", r.Path, err)
			}
			rls := req.Logs().ResourceLogs()
			for i := range rls.Len() {
				rl := rls.At(i)
				for j := range rl.ScopeLogs().Len() {
					recs := rl.ScopeLogs().At(j).LogRecords()
					for k := range recs.Len() {
						d.logs = append(d.logs, logAt{recs.At(k), rl.Resource().Attributes()})
					}
				}
			}
		default:
			t.Fatalf("unexpected path %q", r.Path)
		}
	}
	return d
}

func str(m pcommon.Map, k string) string {
	v, ok := m.Get(k)
	if !ok {
		return ""
	}
	return v.AsString()
}

func eventName(lr plog.LogRecord) string {
	if n := lr.EventName(); n != "" {
		return n
	}
	return str(lr.Attributes(), "event.name")
}

// specEnum reads an enum's member values from the spec registry, so the
// fixture fails when the spec gains a value it does not send.
func specEnum(t *testing.T, id string) []string {
	t.Helper()
	raw, err := os.ReadFile("../../../spec/registry/attributes/rum.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var reg struct {
		Groups []struct {
			Attributes []struct {
				ID   string    `yaml:"id"`
				Type yaml.Node `yaml:"type"`
			} `yaml:"attributes"`
		} `yaml:"groups"`
	}
	if err := yaml.Unmarshal(raw, &reg); err != nil {
		t.Fatal(err)
	}
	for _, g := range reg.Groups {
		for _, a := range g.Attributes {
			if a.ID != id {
				continue
			}
			var typ struct {
				Members []struct {
					Value string `yaml:"value"`
				} `yaml:"members"`
			}
			if err := a.Type.Decode(&typ); err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, m := range typ.Members {
				out = append(out, m.Value)
			}
			return out
		}
	}
	t.Fatalf("no enum %s in the registry", id)
	return nil
}

func TestTrafficShape(t *testing.T) {
	d := decode(t, Traffic(now))

	for _, s := range d.spans {
		if got := str(s.span.Attributes(), "session.id"); got != SessionID {
			t.Errorf("span %q: session.id %q", s.span.Name(), got)
		}
		if got := str(s.span.Attributes(), "o11y.rum.view.id"); got != View0 && got != View1 {
			t.Errorf("span %q: o11y.rum.view.id %q", s.span.Name(), got)
		}
		if str(s.res, "service.name") != Service || str(s.res, "o11y.rum.platform") != "web" {
			t.Errorf("span %q: resource %v", s.span.Name(), s.res.AsRaw())
		}
	}
	shapes := map[string]int{}
	fetches := 0
	for _, s := range d.spans {
		if shape := str(s.span.Attributes(), "o11y.rum.span.shape"); shape != "" {
			shapes[shape]++
		} else if s.span.Kind() == ptrace.SpanKindClient {
			fetches++
		}
	}
	if shapes["view"] != 2 || shapes["action"] != 1 || shapes["app_load"] != 1 || fetches != 1 {
		t.Errorf("span shapes %v, fetches %d; want 2 views, 1 action, 1 app_load and 1 fetch", shapes, fetches)
	}

	events := map[string][]plog.LogRecord{}
	for _, l := range d.logs {
		events[eventName(l.rec)] = append(events[eventName(l.rec)], l.rec)
		if got := str(l.rec.Attributes(), "session.id"); got != SessionID {
			t.Errorf("%s: session.id %q", eventName(l.rec), got)
		}
	}
	for name, want := range map[string]int{
		"o11y.rum.view.summary":  2,
		"o11y.rum.error":         2,
		"o11y.rum.frustration":   1,
		"o11y.rum.session.start": 1,
	} {
		if got := len(events[name]); got != want {
			t.Errorf("%d %s events, want %d", got, name, want)
		}
	}
	for _, name := range []string{"o11y.rum.view.summary", "o11y.rum.error", "o11y.rum.frustration"} {
		for _, lr := range events[name] {
			if v := str(lr.Attributes(), "o11y.rum.view.id"); v != View0 && v != View1 {
				t.Errorf("%s: o11y.rum.view.id %q", name, v)
			}
		}
	}

	var views []string
	sources := specEnum(t, "o11y.rum.error.source")
	types := specEnum(t, "o11y.rum.frustration.type")
	for _, lr := range events["o11y.rum.view.summary"] {
		a := lr.Attributes()
		views = append(views, str(a, "o11y.rum.view.id"))
		for _, k := range []string{
			"o11y.rum.view.name", "o11y.rum.view.kind", "o11y.rum.device.class", "o11y.rum.connection.effective",
			"o11y.rum.summary.seq", "o11y.rum.summary.time_on_view", "o11y.rum.summary.requests",
			"o11y.rum.summary.long_animation_frames",
			"o11y.rum.summary.lcp.value", "o11y.rum.summary.inp.value", "o11y.rum.summary.cls.value",
			"o11y.rum.summary.fcp.value", "o11y.rum.summary.ttfb.value",
		} {
			if _, ok := a.Get(k); !ok {
				t.Errorf("summary %s lacks %s", str(a, "o11y.rum.view.id"), k)
			}
		}
		for _, src := range sources {
			if v, ok := a.Get("o11y.rum.summary.errors." + src); !ok || v.Int() <= 0 {
				t.Errorf("summary lacks a positive o11y.rum.summary.errors.%s", src)
			}
		}
		for _, typ := range types {
			if v, ok := a.Get("o11y.rum.summary.frustrations." + typ); !ok || v.Int() <= 0 {
				t.Errorf("summary lacks a positive o11y.rum.summary.frustrations.%s", typ)
			}
		}
		if seq, _ := a.Get("o11y.rum.summary.seq"); seq.Int() != 0 {
			t.Errorf("summary seq %d, want 0", seq.Int())
		}
	}
	slices.Sort(views)
	if !slices.Equal(views, []string{View0, View1}) {
		t.Errorf("summary views %v, want %s and %s", views, View0, View1)
	}
	for _, lr := range events["o11y.rum.error"] {
		if str(lr.Attributes(), "o11y.rum.error.source") == "" || str(lr.Attributes(), "exception.type") == "" {
			t.Errorf("error event %v lacks its source or type", lr.Attributes().AsRaw())
		}
	}
}

// Policy traffic carries one record validation drops and one attribute
// the policy removes, next to a record the gateway keeps.
func TestPolicyShape(t *testing.T) {
	d := decode(t, []Request{Policy(now)})
	var missingType, removable int
	for _, l := range d.logs {
		a := l.rec.Attributes()
		if eventName(l.rec) == "o11y.rum.error" {
			if _, ok := a.Get("exception.type"); !ok {
				missingType++
			}
		}
		if _, ok := a.Get(Unminted); ok {
			removable++
		}
	}
	if len(d.logs) != 2 || missingType != 1 || removable != 1 {
		t.Errorf("%d records, %d without exception.type, %d with %s", len(d.logs), missingType, removable, Unminted)
	}
}

func TestBadOrigin(t *testing.T) {
	r, h := Bad(now)
	if r.Path != PathLogs && r.Path != PathTraces {
		t.Fatalf("path %q", r.Path)
	}
	if o := h.Get("Origin"); o == "" || o == Origin {
		t.Fatalf("Origin %q must be set and differ from %s", o, Origin)
	}
}

func TestDeterministic(t *testing.T) {
	a, b := Traffic(now), Traffic(now)
	if len(a) != len(b) {
		t.Fatal("request count differs")
	}
	for i := range a {
		if a[i].Path != b[i].Path || string(a[i].Body) != string(b[i].Body) {
			t.Fatalf("request %d differs between calls", i)
		}
	}
}

// Symbolicated traffic names the release the source map is uploaded for,
// and its one error's stack has a frame in the mapped script, so the
// gateway looks the map up and counts the frame.
func TestSymbolicatedShape(t *testing.T) {
	d := decode(t, []Request{Symbolicated(now)})
	if len(d.logs) != 1 {
		t.Fatalf("%d records, want one error", len(d.logs))
	}
	l := d.logs[0]
	if eventName(l.rec) != "o11y.rum.error" || str(l.rec.Attributes(), "exception.type") == "" {
		t.Errorf("record %s %v is not a complete error", eventName(l.rec), l.rec.Attributes().AsRaw())
	}
	if got := str(l.res, "service.version"); got != Version {
		t.Errorf("service.version %q, want %s", got, Version)
	}
	if stack := str(l.rec.Attributes(), "exception.stacktrace"); !strings.Contains(stack, "("+ScriptURL+":1:") {
		t.Errorf("stack %q has no frame in %s", stack, ScriptURL)
	}
	var m struct {
		Version  int      `json:"version"`
		Sources  []string `json:"sources"`
		Mappings string   `json:"mappings"`
	}
	if err := json.Unmarshal(SourceMap(), &m); err != nil {
		t.Fatal(err)
	}
	if m.Version != 3 || len(m.Sources) == 0 || m.Mappings == "" {
		t.Errorf("source map %+v is not a version 3 map with mappings", m)
	}
}
