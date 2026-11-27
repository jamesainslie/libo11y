package sourcemap

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"
)

// TestLookupResolvesThrow resolves a position in a bundle Bun minified
// from testdata/app.ts back to the throw statement in the source.
func TestLookupResolvesThrow(t *testing.T) {
	js := readFile(t, "testdata/simple.js")
	raw := readFile(t, "testdata/simple.js.map")
	src := readFile(t, "testdata/app.ts")
	m, err := Parse(raw, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	col := bytes.Index(js, []byte("throw")) + 1 // the bundle is one line
	pos, ok := m.Lookup(1, col)
	if !ok {
		t.Fatal("no mapping at the throw")
	}
	throwAt := bytes.Index(src, []byte("throw"))
	wantLine := bytes.Count(src[:throwAt], []byte("\n")) + 1
	wantCol := throwAt - bytes.LastIndexByte(src[:throwAt], '\n')
	if !strings.HasSuffix(pos.Source, "app.ts") || pos.Line != wantLine || pos.Column != wantCol {
		t.Fatalf("%+v, want app.ts:%d:%d", pos, wantLine, wantCol)
	}
	if m.Size() <= 0 {
		t.Fatalf("size %d", m.Size())
	}
}

func TestParseRefuses(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  string
		want error
	}{
		"index map":    {`{"version":3,"sections":[]}`, ErrIndexMap},
		"version 2":    {`{"version":2,"sources":[],"names":[],"mappings":""}`, ErrInvalid},
		"no version":   {`{"sources":[],"names":[],"mappings":""}`, ErrInvalid},
		"bad base64":   {`{"version":3,"sources":["a"],"names":[],"mappings":"!"}`, ErrInvalid},
		"truncated":    {`{"version":3,"sources":["a"],"names":[],"mappings":"AAA"}`, ErrInvalid},
		"open vlq":     {`{"version":3,"sources":["a"],"names":[],"mappings":"g"}`, ErrInvalid},
		"long vlq":     {`{"version":3,"sources":["a"],"names":[],"mappings":"gggggggggA"}`, ErrInvalid},
		"source oob":   {`{"version":3,"sources":["a"],"names":[],"mappings":"ACAA"}`, ErrInvalid},
		"negative src": {`{"version":3,"sources":["a"],"names":[],"mappings":"ADAA"}`, ErrInvalid},
		"neg column":   {`{"version":3,"sources":["a"],"names":[],"mappings":"D"}`, ErrInvalid},
		"name oob":     {`{"version":3,"sources":["a"],"names":[],"mappings":"AAAAC"}`, ErrInvalid},
		"two fields":   {`{"version":3,"sources":["a"],"names":[],"mappings":"AA"}`, ErrInvalid},
		"six fields":   {`{"version":3,"sources":["a"],"names":["n"],"mappings":"AAAAAA"}`, ErrInvalid},
		"not json":     {`nope`, ErrInvalid},
		"json array":   {`[]`, ErrInvalid},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(tc.raw), Limits{}); !errors.Is(err, tc.want) {
				t.Fatalf("err %v, want %v", err, tc.want)
			}
		})
	}
}

func TestParseLimits(t *testing.T) {
	if _, err := Parse([]byte(`{"version":3,"sources":["a"],"names":[],"mappings":"AAAA,CAAC,CAAC"}`), Limits{MaxSegments: 2}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("segment cap: %v", err)
	}
	// Line breaks count against the cap too, so a map of nothing but
	// semicolons cannot allocate without bound.
	raw := `{"version":3,"sources":[],"names":[],"mappings":"` + strings.Repeat(";", 100) + `"}`
	if _, err := Parse([]byte(raw), Limits{MaxSegments: 50}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("line cap: %v", err)
	}
	if _, err := Parse([]byte(raw), Limits{}); err != nil {
		t.Fatalf("empty lines under the default cap: %v", err)
	}
}

func TestHandWrittenMapping(t *testing.T) {
	// "AAAAA,IAAI;AACA":
	//   AAAAA  generated column 0 -> source 0, line 0, column 0, name 0
	//   IAAI   generated column +4 -> source column +4, no name
	//   ;      generated line 2, generated column back to 0
	//   AACA   source line +1, source column still 4
	// So line 1 columns 1 to 4 map to a.ts:1:1 (f), line 1 column 5 on to
	// a.ts:1:5, and line 2 to a.ts:2:5.
	m, err := Parse([]byte(`{"version":3,"sourceRoot":"src","sources":["a.ts"],"names":["f"],"mappings":"AAAAA,IAAI;AACA"}`), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		line, col int
		want      Position
		ok        bool
	}{
		{1, 1, Position{Source: "src/a.ts", Line: 1, Column: 1, Name: "f"}, true},
		{1, 3, Position{Source: "src/a.ts", Line: 1, Column: 1, Name: "f"}, true},
		{1, 5, Position{Source: "src/a.ts", Line: 1, Column: 5}, true},
		{1, 500, Position{Source: "src/a.ts", Line: 1, Column: 5}, true},
		{2, 9, Position{Source: "src/a.ts", Line: 2, Column: 5}, true},
		{3, 1, Position{}, false},
		{0, 1, Position{}, false},
		{1, 0, Position{}, false},
		{-1, -1, Position{}, false},
	} {
		got, ok := m.Lookup(tc.line, tc.col)
		if ok != tc.ok || got != tc.want {
			t.Errorf("Lookup(%d,%d) = %+v %v, want %+v %v", tc.line, tc.col, got, ok, tc.want, tc.ok)
		}
	}
}

func TestUnmappedSegmentsAndOrdering(t *testing.T) {
	// "IAAI,FAAF,K": column 4 maps to a.js:1:5, then F (-2) moves back to
	// column 2 and source column 2, then K (+5) is a one-field segment at
	// column 7 that maps to nothing. The out-of-order pair must be sorted.
	m, err := Parse([]byte(`{"version":3,"sources":["a.js"],"names":[],"mappings":"IAAI,FAAF,K"}`), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		col  int
		want Position
		ok   bool
	}{
		{1, Position{}, false},
		{3, Position{Source: "a.js", Line: 1, Column: 3}, true},
		{5, Position{Source: "a.js", Line: 1, Column: 5}, true},
		{8, Position{}, false},
	} {
		got, ok := m.Lookup(1, tc.col)
		if ok != tc.ok || got != tc.want {
			t.Errorf("Lookup(1,%d) = %+v %v, want %+v %v", tc.col, got, ok, tc.want, tc.ok)
		}
	}
}

func TestSourceRootAndXSSIPrefix(t *testing.T) {
	m, err := Parse([]byte(")]}'\n"+`{"version":3,"sourceRoot":"webpack:///","sources":["./src/a.ts","/abs/b.ts","https://cdn.example/c.ts"],"names":[],"mappings":"AAAA,CCAA,CCAA"}`), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for col := 1; col <= 3; col++ {
		p, _ := m.Lookup(1, col)
		got = append(got, p.Source)
	}
	want := []string{"webpack:///./src/a.ts", "/abs/b.ts", "https://cdn.example/c.ts"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("source %d: %q, want %q", i, got[i], want[i])
		}
	}
}

func readFile(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
