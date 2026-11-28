package o11yrum

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

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
