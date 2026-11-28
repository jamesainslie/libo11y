package o11yrum

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
)

// events decodes a JSON array of rrweb events as the endpoint does.
func events(t testing.TB, js string) []any {
	t.Helper()
	var out []any
	dec := json.NewDecoder(strings.NewReader(js))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func marshal(t testing.TB, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// snapshot wraps a node tree in a full snapshot event.
func snapshot(node string) string {
	return `{"type":2,"timestamp":1,"data":{"node":` + node + `,"initialOffset":{"top":0,"left":0}}}`
}

const publicPage = `{"type":0,"id":1,"childNodes":[
  {"type":2,"id":2,"tagName":"h1","attributes":{"class":"public","title":"Public title"},"childNodes":[
    {"type":3,"id":3,"textContent":"Public heading"}]},
  {"type":2,"id":4,"tagName":"style","attributes":{},"childNodes":[
    {"type":3,"id":5,"textContent":"a{background:url(/x.png?token=SECRET)}","isStyle":true}]},
  {"type":2,"id":6,"tagName":"p","attributes":{},"childNodes":[
    {"type":3,"id":7,"textContent":"Jane Doe","isStyle":true}]}]}`

func TestScrubSegmentStrictMasksWhatTheClientKept(t *testing.T) {
	out, _ := scrubSegment(events(t, "["+snapshot(publicPage)+"]"), scrubStrict, nil)
	got := marshal(t, out)
	for _, want := range []string{
		`"textContent":"****** *******"`,
		`"title":"****** *****"`,
		`"textContent":"a{background:url(\"/x.png\")}"`, // style text is kept, URLs stripped
		`"isStyle":true`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	for _, leak := range []string{"Public heading", "Public title", "SECRET", "Jane"} {
		if strings.Contains(got, leak) {
			t.Errorf("strict mode kept %q: %s", leak, got)
		}
	}
	// The isStyle claim under a p is dropped along with the text.
	if strings.Count(got, `"isStyle"`) != 1 {
		t.Errorf("isStyle smuggled: %s", got)
	}
	if err := checkStrictOutput(out); err != nil {
		t.Fatal(err)
	}
}

func TestScrubSegmentTrustKeepsWhatTheClientKept(t *testing.T) {
	out, _ := scrubSegment(events(t, "["+snapshot(publicPage)+"]"), scrubTrust, nil)
	got := marshal(t, out)
	for _, want := range []string{`"textContent":"Public heading"`, `"title":"Public title"`, `"textContent":"Jane Doe"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	if strings.Contains(got, "SECRET") {
		t.Errorf("trust mode kept a URL query: %s", got)
	}
}

func TestScrubSegmentTrustStillEnforcesTheFixedRules(t *testing.T) {
	in := events(t, `[`+snapshot(`{"type":2,"id":1,"tagName":"form","attributes":{},"childNodes":[
	  {"type":2,"id":2,"tagName":"input","attributes":{"value":"hunter2","placeholder":"Your name","type":"text"},"childNodes":[]},
	  {"type":2,"id":3,"tagName":"div","attributes":{"data-o11y-mask":""},"childNodes":[{"type":3,"id":4,"textContent":"Jane Doe"}]},
	  {"type":2,"id":5,"tagName":"script","attributes":{},"childNodes":[{"type":3,"id":6,"textContent":"steal()"}]}]}`)+`,
	  {"type":3,"timestamp":2,"data":{"source":5,"id":2,"text":"hunter2","isChecked":false}},
	  {"type":3,"timestamp":3,"data":{"source":0,"texts":[{"id":4,"value":"Jane Roe"},{"id":6,"value":"steal(2)"}],"attributes":[{"id":2,"attributes":{"value":"hunter3"}}],"removes":[],"adds":[]}}]`)
	out, stats := scrubSegment(in, scrubTrust, nil)
	got := marshal(t, out)
	for _, leak := range []string{"hunter", "Your name", "Jane", "steal"} {
		if strings.Contains(got, leak) {
			t.Errorf("trust mode kept %q: %s", leak, got)
		}
	}
	if len(out) != 2 || stats[dropInput] != 1 {
		t.Fatalf("%d events, stats %v", len(out), stats)
	}
}

func TestScrubSegmentTextMutations(t *testing.T) {
	in := events(t, `[`+snapshot(publicPage)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[
	    {"id":3,"value":"New public heading"},
	    {"id":5,"value":"b{background:url(/y.png?token=SECRET)}"},
	    {"id":99,"value":"Unknown node text"}],"attributes":[],"removes":[],"adds":[]}}]`)
	strict, _ := scrubSegment(deepCopyJSON(t, in), scrubStrict, nil)
	texts := marshal(t, strict[1])
	for _, want := range []string{`"value":"*** ****** *******"`, `"value":"b{background:url(\"/y.png\")}"`, `"value":"******* **** ****"`} {
		if !strings.Contains(texts, want) {
			t.Errorf("strict: missing %s in %s", want, texts)
		}
	}
	trust, _ := scrubSegment(in, scrubTrust, nil)
	texts = marshal(t, trust[1])
	// Trust mode keeps what the client sent, for a node the segment does
	// not hold too: the client, which has the DOM, decided.
	for _, want := range []string{`"value":"New public heading"`, `"value":"Unknown node text"`} {
		if !strings.Contains(texts, want) {
			t.Errorf("trust: missing %s in %s", want, texts)
		}
	}
}

func TestScrubSegmentAddedNodesFollowTheirParent(t *testing.T) {
	in := events(t, `[`+snapshot(publicPage)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[],"attributes":[],"removes":[],"adds":[
	    {"parentId":4,"nextId":null,"node":{"type":3,"id":20,"textContent":"c{background:url(/z.png?token=SECRET)}"}},
	    {"parentId":6,"nextId":null,"node":{"type":3,"id":21,"textContent":"Jane Doe"}},
	    {"parentId":2,"nextId":null,"node":{"type":2,"id":22,"tagName":"textarea","attributes":{},"childNodes":[{"type":3,"id":23,"textContent":"Dear Jane"}]}}]}},
	  {"type":3,"timestamp":3,"data":{"source":0,"texts":[{"id":20,"value":"d{color:red}"},{"id":23,"value":"Dear Jane again"}],"attributes":[],"removes":[],"adds":[]}}]`)
	out, _ := scrubSegment(in, scrubStrict, nil)
	got := marshal(t, out)
	for _, want := range []string{`"textContent":"c{background:url(\"/z.png\")}"`, `"textContent":"**** ***"`, `"value":"d{color:red}"`, `"textContent":""`, `"value":""`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	if strings.Contains(got, "Jane") || strings.Contains(got, "SECRET") {
		t.Errorf("leak: %s", got)
	}
}

func TestScrubSegmentDuplicateIDsCannotUnmask(t *testing.T) {
	// Node 5 claims a style parent and, again, a p parent. Whichever comes
	// last, its text is masked in strict mode.
	for name, tree := range map[string]string{
		"style first": `{"type":0,"id":1,"childNodes":[
		  {"type":2,"id":2,"tagName":"style","attributes":{},"childNodes":[{"type":3,"id":5,"textContent":"Jane Doe"}]},
		  {"type":2,"id":3,"tagName":"p","attributes":{},"childNodes":[{"type":3,"id":5,"textContent":"Jane Doe"}]}]}`,
		"style last": `{"type":0,"id":1,"childNodes":[
		  {"type":2,"id":3,"tagName":"p","attributes":{},"childNodes":[{"type":3,"id":5,"textContent":"Jane Doe"}]},
		  {"type":2,"id":2,"tagName":"style","attributes":{},"childNodes":[{"type":3,"id":5,"textContent":"Jane Doe"}]}]}`,
		"element and text": `{"type":0,"id":1,"childNodes":[
		  {"type":2,"id":5,"tagName":"link","attributes":{"_cssText":"a{}"},"childNodes":[]},
		  {"type":2,"id":3,"tagName":"p","attributes":{},"childNodes":[{"type":3,"id":5,"textContent":"Jane Doe"}]}]}`,
	} {
		in := events(t, `[`+snapshot(tree)+`,{"type":3,"timestamp":2,"data":{"source":0,"texts":[{"id":5,"value":"Jane Doe"}],"attributes":[],"removes":[],"adds":[]}}]`)
		out, _ := scrubSegment(in, scrubStrict, nil)
		if got := marshal(t, out); strings.Contains(got, "Jane") {
			t.Errorf("%s: %s", name, got)
		}
	}
}

func TestScrubSegmentMovedNodeKeepsItsMask(t *testing.T) {
	// Text 4 starts under an input-like mask and is moved under a p: it
	// stays masked in trust mode, since the segment cannot tell which
	// parent is current.
	in := events(t, `[`+snapshot(`{"type":0,"id":1,"childNodes":[
	  {"type":2,"id":2,"tagName":"div","attributes":{"data-o11y-mask":""},"childNodes":[{"type":3,"id":4,"textContent":"x"}]},
	  {"type":2,"id":3,"tagName":"p","attributes":{},"childNodes":[]}]}`)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[],"attributes":[],"removes":[{"parentId":2,"id":4}],"adds":[{"parentId":3,"nextId":null,"node":{"type":3,"id":4,"textContent":"Jane"}}]}},
	  {"type":3,"timestamp":3,"data":{"source":0,"texts":[{"id":4,"value":"Jane Doe"}],"attributes":[],"removes":[],"adds":[]}}]`)
	out, _ := scrubSegment(in, scrubTrust, nil)
	if got := marshal(t, out[2]); strings.Contains(got, "Jane") {
		t.Errorf("moved text unmasked: %s", got)
	}
}

func TestScrubSegmentBlockedContentStaysOut(t *testing.T) {
	in := events(t, `[`+snapshot(`{"type":0,"id":1,"childNodes":[
	  {"type":2,"id":2,"tagName":"div","attributes":{"data-o11y-block":"","class":"card","rr_width":"10px","title":"Jane"},"childNodes":[
	    {"type":3,"id":3,"textContent":"Jane Doe"}]}]}`)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[{"id":3,"value":"Jane Roe"}],"attributes":[{"id":2,"attributes":{"title":"Jane"}}],"removes":[],
	    "adds":[{"parentId":2,"nextId":null,"node":{"type":3,"id":9,"textContent":"Jane"}}]}}]`)
	for _, mode := range []scrubMode{scrubTrust, scrubStrict} {
		out, _ := scrubSegment(deepCopyJSON(t, in), mode, nil)
		got := marshal(t, out)
		if strings.Contains(got, "Jane") || strings.Contains(got, `"id":3`) || strings.Contains(got, `"id":9`) {
			t.Errorf("mode %d: %s", mode, got)
		}
		if !strings.Contains(got, `"attributes":{"class":"card","rr_width":"10px"}`) {
			t.Errorf("mode %d: placeholder missing: %s", mode, got)
		}
	}
}

func TestScrubSegmentCountsDroppedEvents(t *testing.T) {
	in := events(t, `[
	  {"type":3,"timestamp":1,"data":{"source":5,"id":1,"text":"x"}},
	  {"type":3,"timestamp":1,"data":{"source":9,"id":1}},
	  {"type":3,"timestamp":1,"data":{"source":10,"family":"x"}},
	  {"type":3,"timestamp":1,"data":{"source":11,"payload":["x"]}},
	  {"type":3,"timestamp":1,"data":{"source":99}},
	  {"type":5,"timestamp":1,"data":{"tag":"x"}},
	  {"type":6,"timestamp":1,"data":{}},
	  {"type":2,"timestamp":1,"data":{"node":{"id":"x"}}},
	  {"type":2,"timestamp":1e400,"data":{}},
	  "not an event",
	  {"type":4,"timestamp":1.0,"data":{"href":"https://a.example/x?token=1","width":-0,"height":1e2}}]`)
	out, stats := scrubSegment(in, scrubStrict, nil)
	want := scrubStats{dropInput: 1, dropCanvas: 1, dropFont: 1, dropLog: 1, dropSource: 1, dropType: 2, dropInvalid: 3}
	if fmt.Sprint(stats) != fmt.Sprint(want) {
		t.Errorf("stats %v, want %v", stats, want)
	}
	if got := marshal(t, out); got != `[{"data":{"height":100,"href":"https://a.example/x","width":0},"timestamp":1,"type":4}]` {
		t.Errorf("kept %s", got)
	}
}

func TestScrubEventDoesNotLeakThroughNumbers(t *testing.T) {
	// Numbers are re-encoded, so digits beyond float64 precision, which
	// could carry data, do not reach the store.
	out, _ := scrubSegment(events(t, `[{"type":4,"timestamp":1.00000000000000000000123456789,"data":{"width":10.000000000000000000000987654321}}]`), scrubStrict, nil)
	if got := marshal(t, out); strings.Contains(got, "123456789") || strings.Contains(got, "987654321") {
		t.Fatalf("number digits kept: %s", got)
	}
}

func TestCheckStrictOutputCatchesLeaks(t *testing.T) {
	for name, js := range map[string]string{
		"text":          `[` + snapshot(`{"type":2,"id":1,"tagName":"p","attributes":{},"childNodes":[{"type":3,"id":2,"textContent":"Jane"}]}`) + `]`,
		"masked attr":   `[` + snapshot(`{"type":2,"id":1,"tagName":"p","attributes":{"title":"Jane"},"childNodes":[]}`) + `]`,
		"unknown attr":  `[` + snapshot(`{"type":2,"id":1,"tagName":"p","attributes":{"value":"x"},"childNodes":[]}`) + `]`,
		"text mutation": `[{"type":3,"timestamp":1,"data":{"source":0,"texts":[{"id":2,"value":"Jane"}],"attributes":[],"removes":[],"adds":[]}}]`,
		"input event":   `[{"type":3,"timestamp":1,"data":{"source":5,"id":1}}]`,
		"custom event":  `[{"type":5,"timestamp":1,"data":{}}]`,
		"added text":    `[{"type":3,"timestamp":1,"data":{"source":0,"texts":[],"attributes":[],"removes":[],"adds":[{"parentId":1,"nextId":null,"node":{"type":3,"id":2,"textContent":"Jane"}}]}}]`,
		"attr mutation": `[{"type":3,"timestamp":1,"data":{"source":0,"texts":[],"attributes":[{"id":1,"attributes":{"alt":"Jane"}}],"removes":[],"adds":[]}}]`,
	} {
		if err := checkStrictOutput(events(t, js)); err == nil {
			t.Errorf("%s: not caught", name)
		}
	}
	ok := `[` + snapshot(`{"type":2,"id":1,"tagName":"style","attributes":{},"childNodes":[{"type":3,"id":2,"textContent":"a{}"}]}`) + `,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[{"id":2,"value":"b{}"},{"id":3,"value":null}],"attributes":[],"removes":[],"adds":[]}}]`
	if err := checkStrictOutput(events(t, ok)); err != nil {
		t.Errorf("style text refused: %v", err)
	}
}

// checkStrictOutput reports the first thing in strict-mode output that
// could carry recorded content: a kept event type or source outside the
// allow-lists, an attribute outside the lists, a masked attribute that is
// not masked, or text that is not masked outside a style element. It
// follows the tree the output itself describes, so it judges the
// scrubber without sharing its code.
func checkStrictOutput(evs []any) error {
	type info struct {
		parentTag string
		text      bool
		conflict  bool
	}
	nodes := map[float64]*info{}
	register := func(id float64, n info) {
		if old, ok := nodes[id]; ok {
			if *old != n {
				old.conflict = true
			}
			return
		}
		nodes[id] = &n
	}
	var walk func(n any, parentTag string) error
	walk = func(n any, parentTag string) error {
		m, ok := n.(map[string]any)
		if !ok {
			return fmt.Errorf("node %v is not an object", n)
		}
		id, _ := toNum(m["id"])
		typ, _ := toNum(m["type"])
		switch typ {
		case 2:
			tag := asciiLower(fmt.Sprint(m["tagName"]))
			if err := checkStrictAttrs(m["attributes"]); err != nil {
				return err
			}
			register(id, info{parentTag: parentTag})
			for _, c := range anyList(m["childNodes"]) {
				if err := walk(c, tag); err != nil {
					return err
				}
			}
		case 3:
			register(id, info{parentTag: parentTag, text: true})
			if s, _ := m["textContent"].(string); parentTag != "style" && !maskOnly(s) {
				return fmt.Errorf("text %q under %q", s, parentTag)
			}
		default:
			register(id, info{parentTag: parentTag})
			for _, c := range anyList(m["childNodes"]) {
				if err := walk(c, ""); err != nil {
					return err
				}
			}
		}
		return nil
	}
	tagOf := map[float64]string{}
	var tags func(n any)
	tags = func(n any) {
		if m, ok := n.(map[string]any); ok {
			if id, ok := toNum(m["id"]); ok {
				if s, ok := m["tagName"].(string); ok {
					tagOf[id] = asciiLower(s)
				}
			}
			for _, c := range anyList(m["childNodes"]) {
				tags(c)
			}
		}
	}
	for _, e := range evs {
		ev, ok := e.(map[string]any)
		if !ok {
			return fmt.Errorf("event %v is not an object", e)
		}
		for k := range ev {
			if k != "type" && k != "timestamp" && k != "data" {
				return fmt.Errorf("event field %s", k)
			}
		}
		data, _ := ev["data"].(map[string]any)
		switch typ, _ := toNum(ev["type"]); typ {
		case 0, 1, 4:
		case 2:
			nodes, tagOf = map[float64]*info{}, map[float64]string{}
			tags(data["node"])
			if err := walk(data["node"], ""); err != nil {
				return err
			}
		case 3:
			src, _ := toNum(data["source"])
			switch src {
			case 0:
				for _, a := range anyList(data["adds"]) {
					am := a.(map[string]any)
					pid, _ := toNum(am["parentId"])
					tags(am["node"])
					if err := walk(am["node"], tagOf[pid]); err != nil {
						return err
					}
				}
				for _, tx := range anyList(data["texts"]) {
					tm := tx.(map[string]any)
					id, _ := toNum(tm["id"])
					s, _ := tm["value"].(string)
					n := nodes[id]
					style := n != nil && !n.conflict && n.text && n.parentTag == "style"
					if !style && !maskOnly(s) {
						return fmt.Errorf("text mutation %q on node %v", s, id)
					}
				}
				for _, at := range anyList(data["attributes"]) {
					if err := checkStrictAttrs(at.(map[string]any)["attributes"]); err != nil {
						return err
					}
				}
			case 1, 2, 3, 4, 6, 7, 8, 12, 13, 14, 15, 16:
			default:
				return fmt.Errorf("incremental source %v", src)
			}
		default:
			return fmt.Errorf("event type %v", typ)
		}
	}
	return nil
}

func checkStrictAttrs(v any) error {
	m, _ := v.(map[string]any)
	for k, val := range m {
		key := asciiLower(k)
		if !keptAttributes[key] && !maskedAttributes[key] && !urlAttributes[key] && !cssAttributes[key] && key != "_csstext" {
			return fmt.Errorf("attribute %s", k)
		}
		if s, ok := val.(string); ok && maskedAttributes[key] && !maskOnly(s) {
			return fmt.Errorf("attribute %s=%q", k, s)
		}
	}
	return nil
}

func anyList(v any) []any {
	l, _ := v.([]any)
	return l
}

// maskOnly reports whether s holds nothing but "*" and the white space
// maskText keeps.
func maskOnly(s string) bool {
	return strings.Trim(s, "* \t\n\r\f\v") == ""
}

func TestScrubSegmentOutputMarshals(t *testing.T) {
	out, _ := scrubSegment(events(t, "["+snapshot(publicPage)+"]"), scrubStrict, nil)
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(out); err != nil {
		t.Fatal(err)
	}
}

func TestScrubSegmentStylesheetElementsAllowOnlyCSS(t *testing.T) {
	// A style or link element keeps its inlined stylesheet in strict mode,
	// but that is all: text aimed at the element's own ID, and its text
	// attributes, are masked.
	in := events(t, `[`+snapshot(`{"type":0,"id":1,"childNodes":[
	  {"type":2,"id":2,"tagName":"link","attributes":{"rel":"stylesheet","title":"Jane","_cssText":"a{background:url(/a.png?token=SECRET)}"},"childNodes":[]},
	  {"type":2,"id":3,"tagName":"style","attributes":{},"childNodes":[]}]}`)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[{"id":3,"value":"Jane Doe"},{"id":2,"value":"Jane Roe"}],
	    "attributes":[{"id":2,"attributes":{"title":"Jane","_cssText":"b{color:red}"}}],"removes":[],"adds":[]}}]`)
	out, _ := scrubSegment(in, scrubStrict, nil)
	got := marshal(t, out)
	if strings.Contains(got, "Jane") || strings.Contains(got, "SECRET") {
		t.Errorf("leak: %s", got)
	}
	for _, want := range []string{`"_cssText":"a{background:url(\"/a.png\")}"`, `"_cssText":"b{color:red}"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	if err := checkStrictOutput(out); err != nil {
		t.Error(err)
	}
}

func TestJSFalseMatchesJSString(t *testing.T) {
	cases := []any{
		"false", "FALSE", "fAlSe", false, true, "", nil,
		[]any{"false"},
		[]any{[]any{"False"}},
		[]any{false},
		[]any{"false", ""},
		[]any{nil},
		[]any{},
		map[string]any{},
		json.Number("0"), "true",
		[]any{[]any{}},
	}
	for _, v := range cases {
		want := v != nil && asciiLower(jsString(v)) == "false"
		if got := jsFalse(v); got != want {
			t.Errorf("jsFalse(%#v) = %v, want %v", v, got, want)
		}
	}
}

func TestScrubSegmentDeepContentEditableIsCheap(t *testing.T) {
	// A contenteditable value nested in arrays once cost depth times size
	// to stringify. It must cost no more than its depth.
	var b strings.Builder
	const depth = 5000
	b.WriteString(`[` + `{"type":2,"timestamp":1,"data":{"node":{"type":2,"id":1,"tagName":"div","childNodes":[],"attributes":{"contenteditable":`)
	b.WriteString(strings.Repeat("[", depth))
	b.WriteString(`"` + strings.Repeat("A", 2<<20) + `",0`)
	b.WriteString(strings.Repeat("],0", depth-1) + "]")
	b.WriteString(`}}}}]`)
	in := events(t, b.String())
	start := time.Now()
	scrubSegment(in, scrubStrict, nil)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("scrubbing took %v", d)
	}
}

func TestScrubSegmentFollowsAttributeMutations(t *testing.T) {
	base := snapshot(`{"type":0,"id":1,"childNodes":[{"type":2,"id":30,"tagName":"div","attributes":{},"childNodes":[{"type":3,"id":31,"textContent":"x"}]}]}`)
	for _, marker := range []string{`"data-o11y-block":""`, `"data-o11y-mask":""`, `"contenteditable":"true"`} {
		in := events(t, `[`+base+`,
		  {"type":3,"timestamp":2,"data":{"source":0,"texts":[],"attributes":[{"id":30,"attributes":{`+marker+`}}],"removes":[],"adds":[]}},
		  {"type":3,"timestamp":3,"data":{"source":0,"texts":[{"id":31,"value":"Jane Doe"}],"attributes":[],"removes":[],
		    "adds":[{"parentId":30,"nextId":null,"node":{"type":2,"id":32,"tagName":"img","attributes":{"class":"card","src":"/photo.png?u=jane"},"childNodes":[]}}]}}]`)
		out, _ := scrubSegment(in, scrubTrust, nil)
		got := marshal(t, out[2])
		if strings.Contains(got, "Jane") || strings.Contains(got, "jane") {
			t.Errorf("%s set later: %s", marker, got)
		}
	}
}

func TestScrubSegmentStrictNeverKeepsTextAttributes(t *testing.T) {
	in := events(t, `[`+snapshot(publicPage)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[],"attributes":[{"id":5,"attributes":{"title":"Jane","aria-label":"Jane"}}],"removes":[],"adds":[]}}]`)
	out, _ := scrubSegment(in, scrubStrict, nil)
	if got := marshal(t, out); strings.Contains(got, "Jane") {
		t.Fatalf("leak: %s", got)
	}
}

func TestScrubSegmentInvalidSnapshotKeepsTheModel(t *testing.T) {
	in := events(t, `[`+snapshot(`{"type":2,"id":20,"tagName":"textarea","attributes":{},"childNodes":[{"type":3,"id":21,"textContent":"x"}]}`)+`,
	  {"type":2,"timestamp":2,"data":{"node":null}},
	  {"type":3,"timestamp":3,"data":{"source":0,"texts":[{"id":21,"value":"Jane Doe"}],"attributes":[],"removes":[],"adds":[]}}]`)
	out, _ := scrubSegment(in, scrubTrust, nil)
	if got := marshal(t, out); strings.Contains(got, "Jane") {
		t.Fatalf("leak: %s", got)
	}
}

func TestScrubSegmentAddsBeforeTheirParent(t *testing.T) {
	in := events(t, `[`+snapshot(`{"type":0,"id":1,"childNodes":[{"type":2,"id":30,"tagName":"div","attributes":{},"childNodes":[]}]}`)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[],"attributes":[],"removes":[],"adds":[
	    {"parentId":61,"nextId":null,"node":{"type":3,"id":62,"textContent":"Jane Doe"}},
	    {"parentId":30,"nextId":null,"node":{"type":2,"id":61,"tagName":"select","attributes":{},"childNodes":[]}}]}}]`)
	out, _ := scrubSegment(in, scrubTrust, nil)
	if got := marshal(t, out); strings.Contains(got, "Jane") {
		t.Fatalf("leak: %s", got)
	}
}

func TestScrubSegmentReserializedStyleAllowsNoText(t *testing.T) {
	in := events(t, `[`+snapshot(`{"type":0,"id":1,"childNodes":[{"type":2,"id":80,"tagName":"style","attributes":{},"childNodes":[{"type":3,"id":81,"textContent":"a{}"}]}]}`)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[],"attributes":[],"removes":[],"adds":[{"parentId":1,"nextId":null,"node":{"type":2,"id":80,"tagName":"div","attributes":{},"childNodes":[]}}]}},
	  {"type":3,"timestamp":3,"data":{"source":0,"texts":[{"id":81,"value":"Jane Doe"}],"attributes":[],"removes":[],"adds":[]}}]`)
	out, _ := scrubSegment(in, scrubStrict, nil)
	if got := marshal(t, out[2]); strings.Contains(got, "Jane") {
		t.Fatalf("leak: %s", got)
	}
}

func TestScrubSegmentParentCyclesFailClosed(t *testing.T) {
	in := events(t, `[`+snapshot(`{"type":0,"id":1,"childNodes":[]}`)+`,
	  {"type":3,"timestamp":2,"data":{"source":0,"texts":[{"id":72,"value":"Jane Doe"}],"attributes":[],"removes":[],"adds":[
	    {"parentId":71,"nextId":null,"node":{"type":2,"id":70,"tagName":"div","attributes":{},"childNodes":[{"type":3,"id":72,"textContent":"Jane"}]}},
	    {"parentId":70,"nextId":null,"node":{"type":2,"id":71,"tagName":"div","attributes":{},"childNodes":[]}}]}}]`)
	out, _ := scrubSegment(in, scrubTrust, nil)
	if got := marshal(t, out); strings.Contains(got, "Jane") {
		t.Fatalf("a parent cycle allowed text: %s", got)
	}
}

// jsString is JavaScript's String(v) for a decoded JSON value.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case json.Number, float64:
		if f, ok := toNum(x); ok {
			return jsNumberString(f)
		}
		return "Infinity"
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}
