package stacktrace

import "testing"

// FuzzParse checks that Parse never panics, honours maxFrames, and that
// formatting a trace and parsing it again keeps its frames with URLs.
// CI runs the seed corpus only.
func FuzzParse(f *testing.F) {
	for _, s := range []string{
		"TypeError: boom\n    at computeTotal (https://shop.example/assets/app.js:1:120)\n    at https://a/b.js:2:15\n    at Array.map (<anonymous>)",
		"computeTotal@https://shop.example/assets/app.js:1:120\n@https://a/b.js:2:15\n[native code]",
		"Error: a\nb\n    at new C (https://a:1/b.js:3:4)",
		"f@https://a/b.js:9",
		"",
	} {
		f.Add(s, 50)
	}
	f.Fuzz(func(t *testing.T, s string, maxFrames int) {
		maxFrames %= 200
		tr := Parse(s, maxFrames)
		if maxFrames > 0 && len(tr.Frames) > maxFrames {
			t.Fatalf("%d frames, max %d", len(tr.Frames), maxFrames)
		}
		again := Parse(tr.String(), 0)
		if a, b := urlFrames(tr), urlFrames(again); a != b {
			t.Fatalf("%d URL frames, %d after a round trip of %q", a, b, tr.String())
		}
	})
}

func urlFrames(tr Trace) int {
	n := 0
	for _, f := range tr.Frames {
		if f.URL != "" {
			n++
		}
	}
	return n
}
