package sourcemap

import (
	"os"
	"testing"
)

// FuzzParse checks that no input makes Parse or Lookup panic. CI runs the
// seed corpus only; run it longer locally with -fuzz FuzzParse.
func FuzzParse(f *testing.F) {
	if raw, err := os.ReadFile("testdata/simple.js.map"); err == nil {
		f.Add(raw)
	}
	for _, s := range []string{
		`{"version":3,"sources":["a"],"names":["f"],"mappings":"AAAAA,IAAI;AACA"}`,
		`{"version":3,"sources":["a.js"],"names":[],"mappings":"IAAI,FAAF,K"}`,
		`{"version":3,"sections":[]}`,
		`{"version":3,"sources":["a"],"names":[],"mappings":"gggggggggA"}`,
		`{"version":3,"sources":[],"names":[],"mappings":";;;;"}`,
		")]}'\n" + `{"version":3,"sourceRoot":"r","sources":["a"],"names":[],"mappings":"AAAA"}`,
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		m, err := Parse(raw, Limits{MaxSegments: 100_000})
		if err != nil {
			return
		}
		for line := -1; line <= 50; line++ {
			for col := -1; col <= 200; col++ {
				if p, ok := m.Lookup(line, col); ok && (p.Line < 1 || p.Column < 1) {
					t.Fatalf("Lookup(%d,%d) returned %+v", line, col, p)
				}
			}
		}
	})
}
