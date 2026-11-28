package o11yrum

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// refStripCSS is stripCSS as the collector writes it, without the
// gateway's shortcuts: every bare run is read whole before it is checked,
// and every ":" outside a value checks the statement so far. It shares the
// run reader, the run-end rules and the scheme test with the scanner, so
// it checks the shortcuts, not those helpers; the vectors and the
// differential runs against the collector check them.
func refStripCSS(css string, allow map[string]bool, value bool) string {
	var out strings.Builder
	i, statement := 0, 0
	inValue, boundary := value, value
	for i < len(css) {
		c := css[i]
		if c == '/' && cssAt(css, i+1) == '*' {
			end := strings.Index(css[i+2:], "*/")
			if end < 0 {
				i = len(css)
			} else {
				i += end + 4
			}
			boundary = inValue
			continue
		}
		if inValue && boundary && (c == '/' || isCSSNameChar(c) || isCSSEscape(css, i)) {
			if run, next := readCSSBareRun(css, i); isBareURL(run) {
				if stripped := stripURL(run, allow); stripped == run {
					out.WriteString(css[i:next])
				} else {
					out.WriteString(cssQuote(stripped))
				}
				i, boundary = next, false
				continue
			}
		}
		switch {
		case c == '"' || c == '\'':
			s, next := readCSSString(css, i)
			if followsImport(out.String()) || readsAsURL(s) {
				out.WriteString(cssQuote(stripURL(s, allow)))
			} else {
				out.WriteString(css[i:next])
			}
			i, boundary = next, false
		case isCSSNameChar(c) || isCSSEscape(css, i):
			j := i
			var name strings.Builder
			for j < len(css) && (isCSSEscape(css, j) || isCSSNameChar(css[j])) {
				if isCSSEscape(css, j) {
					text, n := readCSSEscape(css, j)
					name.WriteString(text)
					j = n
				} else {
					name.WriteByte(css[j])
					j++
				}
			}
			if cssAt(css, j) == '(' && asciiLower(name.String()) == "url" {
				arg, next := readCSSURLArgument(css, j+1)
				out.WriteString("url(" + cssQuote(stripURL(arg, allow)) + ")")
				i, boundary = next, false
				continue
			}
			out.WriteString(css[i:j])
			i, boundary = j, false
		case c == ';' || c == '{' || c == '}':
			out.WriteByte(c)
			i++
			statement, inValue, boundary = out.Len(), false, false
		case c == ':' && !inValue && isCSSProperty(out.String()[statement:]):
			out.WriteByte(c)
			i++
			inValue, boundary = true, true
		default:
			out.WriteByte(c)
			i++
			boundary = inValue && (isCSSSpace(c) || c == ',' || c == '(')
		}
	}
	return out.String()
}

// FuzzStripCSSURLs checks that the gateway's shortcuts in stripCSS (the
// bounded prefix that decides whether a run is a URL, and the one
// property check per statement) never change its output, against
// refStripCSS. Plain go test runs it over the seeds only.
func FuzzStripCSSURLs(f *testing.F) {
	var v struct {
		Allow []string `json:"allow"`
		Cases []struct {
			Kind string `json:"kind"`
			In   string `json:"in"`
			Out  string `json:"out"`
		} `json:"cases"`
	}
	readVector(f, "urls.json", &v)
	for _, c := range v.Cases {
		if c.Kind == "css" || c.Kind == "css-value" {
			f.Add(c.In)
		}
	}
	for _, s := range []string{`--u:javascrip\74:x`, `--u:\6a avascript:x`, "a(b:c:d", "--u:a(a(/x?t=1", "--u:\u00e9/x?t=1", "x:y;z:/a?t=1"} {
		f.Add(s)
	}
	allow := map[string]bool{"page": true}
	f.Fuzz(func(t *testing.T, css string) {
		for _, value := range []bool{false, true} {
			if got, want := stripCSS(css, allow, value), refStripCSS(css, allow, value); got != want {
				t.Fatalf("stripCSS(%q, value %v) = %q, reference %q", css, value, got, want)
			}
		}
	})
}

// FuzzScrubSegment checks that scrubbing never panics, that its output
// always marshals, and that strict mode's output never holds unmasked
// text, an attribute off the lists or an event that is never stored,
// whatever the input. Plain go test runs it over the seeds only; longer
// runs (-fuzz) need the owner's approval on the shared host.
func FuzzScrubSegment(f *testing.F) {
	for _, file := range scrubVectorFiles(f) {
		raw, err := os.ReadFile(filepath.Join(replayVectorDir, file))
		if err != nil {
			f.Fatal(err)
		}
		var v struct {
			Events   json.RawMessage `json:"events"`
			Expected json.RawMessage `json:"expected"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			f.Fatal(err)
		}
		f.Add([]byte(v.Events))
		f.Add([]byte(v.Expected))
	}
	f.Add([]byte(`[` + snapshot(publicPage) + `]`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		var events []any
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if err := dec.Decode(&events); err != nil {
			return
		}
		for _, mode := range []scrubMode{scrubStrict, scrubTrust} {
			out, stats := scrubSegment(events, mode, map[string]bool{"page": true})
			var dropped int64
			for _, n := range stats {
				dropped += n
			}
			if int64(len(out))+dropped != int64(len(events)) {
				t.Fatalf("mode %d: %d kept and %d dropped of %d", mode, len(out), dropped, len(events))
			}
			if _, err := json.Marshal(out); err != nil {
				t.Fatalf("mode %d: output does not marshal: %v", mode, err)
			}
			if mode == scrubStrict {
				if err := checkStrictOutput(out); err != nil {
					t.Fatalf("strict output: %v", err)
				}
			}
		}
	})
}
