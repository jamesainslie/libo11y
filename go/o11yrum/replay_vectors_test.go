package o11yrum

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// replayVectorDir holds the replay scrubbing vectors the collector runs
// too. Its README describes the format.
var replayVectorDir = filepath.Join("..", "..", "conformance", "rum-replay")

// scrubVector is one scrub-*.json case.
type scrubVector struct {
	Description    string            `json:"description"`
	QueryAllowList []string          `json:"query_allow_list"`
	TextAllowedIDs []float64         `json:"text_allowed_ids"`
	EditableIDs    []float64         `json:"editable_ids"`
	BlockedIDs     []float64         `json:"blocked_ids"`
	ParentTags     map[string]string `json:"parent_tags"`
	Secrets        []string          `json:"secrets"`
	AllowedTexts   []string          `json:"allowed_texts"`
	Events         []any             `json:"events"`
	Expected       []any             `json:"expected"`
}

// decodeStrict decodes raw into v with numbers as json.Number, as the
// endpoint decodes a segment, refusing unknown fields so a format change
// to the vectors fails here instead of being skipped.
func decodeStrict(t testing.TB, raw []byte, v any) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatal(err)
	}
}

func readVector(t testing.TB, name string, v any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(replayVectorDir, name))
	if err != nil {
		t.Fatal(err)
	}
	decodeStrict(t, raw, v)
}

func scrubVectorFiles(t testing.TB) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(replayVectorDir, "scrub-*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) < 8 {
		t.Fatalf("only %d scrub vectors in %s", len(matches), replayVectorDir)
	}
	slices.Sort(matches)
	for i, m := range matches {
		matches[i] = filepath.Base(m)
	}
	return matches
}

// vectorContext answers the scrubber's questions from a vector's fields,
// as the collector's conformance suite does.
type vectorContext struct {
	allowed, editableIDs, blockedIDs map[float64]bool
	parents                          map[string]string
}

func newVectorContext(v scrubVector, allowed []float64) vectorContext {
	ids := func(xs []float64) map[float64]bool {
		m := map[float64]bool{}
		for _, x := range xs {
			m[x] = true
		}
		return m
	}
	return vectorContext{allowed: ids(allowed), editableIDs: ids(v.EditableIDs), blockedIDs: ids(v.BlockedIDs), parents: v.ParentTags}
}

func (c vectorContext) textAllowed(id float64) bool { return c.allowed[id] }

// stylesheetAllowed and attrsAllowed are textAllowed, as the collector
// has it.
func (c vectorContext) stylesheetAllowed(id float64) bool { return c.allowed[id] }
func (c vectorContext) attrsAllowed(id float64) bool      { return c.allowed[id] }
func (c vectorContext) parentTag(id float64) string       { return c.parents[jsNumberString(id)] }
func (c vectorContext) editable(id float64) bool          { return c.editableIDs[id] }
func (c vectorContext) blocked(id float64) bool           { return c.blockedIDs[id] }

func allowSet(names []string) map[string]bool {
	m := map[string]bool{}
	for _, n := range names {
		m[n] = true
	}
	return m
}

// runVector scrubs every event of v with ctx, as the collector does.
func runVector(v scrubVector, ctx scrubContext) []any {
	out := []any{}
	for _, e := range v.Events {
		if s, ok := scrubEvent(e, allowSet(v.QueryAllowList), ctx); ok {
			out = append(out, s)
		}
	}
	return out
}

// canonical turns decoded JSON (json.Number or float64 numbers) into one
// comparable form: what encoding/json decodes the marshalled value to.
func canonical(t testing.TB, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func assertJSONEqual(t testing.TB, got, want any) {
	t.Helper()
	g, w := canonical(t, got), canonical(t, want)
	if !reflect.DeepEqual(g, w) {
		gj, _ := json.MarshalIndent(g, "", " ")
		wj, _ := json.MarshalIndent(w, "", " ")
		t.Fatalf("got\n%s\nwant\n%s", gj, wj)
	}
}

func assertNoneOf(t testing.TB, out any, strs []string, what string) {
	t.Helper()
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range strs {
		if bytes.Contains(raw, []byte(s)) {
			t.Errorf("%s %q in %s", what, s, raw)
		}
	}
}

func TestReplayMaskVectors(t *testing.T) {
	var v struct {
		Cases []struct {
			In  string `json:"in"`
			Out string `json:"out"`
		} `json:"cases"`
	}
	readVector(t, "mask-text.json", &v)
	if len(v.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range v.Cases {
		if got := maskText(c.In); got != c.Out {
			t.Errorf("maskText(%q) = %q, want %q", c.In, got, c.Out)
		}
	}
}

func TestReplayURLVectors(t *testing.T) {
	var v struct {
		Allow []string `json:"allow"`
		Cases []struct {
			Kind string `json:"kind"`
			In   string `json:"in"`
			Out  string `json:"out"`
		} `json:"cases"`
	}
	readVector(t, "urls.json", &v)
	allow := allowSet(v.Allow)
	strip := map[string]func(string, map[string]bool) string{"url": stripURL, "srcset": stripSrcset, "css": stripCSSURLs}
	seen := map[string]bool{}
	for _, c := range v.Cases {
		f, ok := strip[c.Kind]
		if !ok {
			t.Fatalf("unknown kind %q", c.Kind)
		}
		seen[c.Kind] = true
		if got := f(c.In, allow); got != c.Out {
			t.Errorf("%s %q: %q, want %q", c.Kind, c.In, got, c.Out)
		}
	}
	if len(seen) != 3 {
		t.Fatalf("kinds %v", seen)
	}
}

// TestReplayScrubVectors runs each case as the collector's conformance
// suite does, with the vector's context: trust mode must give expected,
// and strict mode (no text allowed) must leak no secret and no allowed
// text.
func TestReplayScrubVectors(t *testing.T) {
	for _, file := range scrubVectorFiles(t) {
		var v scrubVector
		readVector(t, file, &v)
		t.Run(file+"/trust", func(t *testing.T) {
			if v.Description == "" || len(v.Secrets) == 0 {
				t.Fatal("a vector needs a description and secrets")
			}
			raw, _ := json.Marshal(v.Events)
			for _, s := range v.Secrets {
				if !strings.Contains(string(raw), s) {
					t.Fatalf("secret %q is not in the input", s)
				}
			}
			got := runVector(v, newVectorContext(v, v.TextAllowedIDs))
			assertJSONEqual(t, got, v.Expected)
			assertNoneOf(t, got, v.Secrets, "secret")
		})
		t.Run(file+"/strict", func(t *testing.T) {
			got := runVector(v, newVectorContext(v, nil))
			assertNoneOf(t, got, append(slices.Clone(v.Secrets), v.AllowedTexts...), "strict mode leaks")
		})
	}
}

// TestReplayScrubSegmentVectors runs the gateway's own modes, which have
// no DOM and answer from the segment, over what a conforming client sends
// (each vector's expected output) and over the raw events.
func TestReplayScrubSegmentVectors(t *testing.T) {
	for _, file := range scrubVectorFiles(t) {
		var v scrubVector
		readVector(t, file, &v)
		allow := allowSet(v.QueryAllowList)
		t.Run(file+"/trust", func(t *testing.T) {
			// The gateway keeps what a conforming client sent.
			got, _ := scrubSegment(deepCopyJSON(t, v.Expected), scrubTrust, allow)
			assertJSONEqual(t, got, v.Expected)
		})
		t.Run(file+"/strict", func(t *testing.T) {
			for name, in := range map[string][]any{"client output": v.Expected, "raw events": v.Events} {
				got, _ := scrubSegment(deepCopyJSON(t, in), scrubStrict, allow)
				if err := checkStrictOutput(got); err != nil {
					t.Errorf("%s: %v", name, err)
				}
				assertNoneOf(t, got, v.AllowedTexts, name+": allowed text")
				if name == "client output" {
					assertNoneOf(t, got, v.Secrets, name+": secret")
				}
			}
		})
	}
}

// deepCopyJSON copies decoded JSON, keeping json.Number, so a test can
// hand the same events to more than one run.
func deepCopyJSON(t testing.TB, events []any) []any {
	t.Helper()
	raw, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	var out []any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}
