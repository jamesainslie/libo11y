package stacktrace

import (
	"strings"
	"testing"
)

func checkFrames(t *testing.T, got, want []Frame) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%d frames, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		f := got[i]
		if f.Function != w.Function || f.URL != w.URL || f.Line != w.Line || f.Column != w.Column {
			t.Errorf("frame %d: %+v, want %+v", i, f, w)
		}
	}
}

func TestParseV8(t *testing.T) {
	tr := Parse("TypeError: boom\n"+
		"    at computeTotal (https://shop.example/assets/app.js:1:120)\n"+
		"    at async checkout (https://shop.example/assets/app.js:1:300)\n"+
		"    at https://shop.example/assets/app.js:2:15\n"+
		"    at new Cart (https://shop.example:8443/a.js:3:4)\n"+
		"    at Object.<anonymous> (chrome-extension://abc/js/content.js:7:9)\n"+
		"    at Array.map (<anonymous>)", 50)
	if tr.Header != "TypeError: boom" {
		t.Fatalf("header %q", tr.Header)
	}
	checkFrames(t, tr.Frames, []Frame{
		{Function: "computeTotal", URL: "https://shop.example/assets/app.js", Line: 1, Column: 120},
		{Function: "checkout", URL: "https://shop.example/assets/app.js", Line: 1, Column: 300},
		{URL: "https://shop.example/assets/app.js", Line: 2, Column: 15},
		{Function: "Cart", URL: "https://shop.example:8443/a.js", Line: 3, Column: 4},
		{Function: "Object.<anonymous>", URL: "chrome-extension://abc/js/content.js", Line: 7, Column: 9},
		{},
	})
	if tr.Frames[5].Raw != "    at Array.map (<anonymous>)" {
		t.Fatalf("raw %q", tr.Frames[5].Raw)
	}
}

func TestParseGeckoAndWebKit(t *testing.T) {
	tr := Parse("computeTotal@https://shop.example/assets/app.js:1:120\n"+
		"checkout@https://shop.example/assets/app.js:1:300\n"+
		"@https://shop.example/assets/app.js:2:15\n"+
		"global code@https://shop.example/assets/app.js:3:1\n"+
		"f@https://shop.example/assets/app.js:9\n"+
		"[native code]", 50)
	if tr.Header != "" {
		t.Fatalf("header %q", tr.Header)
	}
	checkFrames(t, tr.Frames, []Frame{
		{Function: "computeTotal", URL: "https://shop.example/assets/app.js", Line: 1, Column: 120},
		{Function: "checkout", URL: "https://shop.example/assets/app.js", Line: 1, Column: 300},
		{URL: "https://shop.example/assets/app.js", Line: 2, Column: 15},
		{Function: "global code", URL: "https://shop.example/assets/app.js", Line: 3, Column: 1},
		{Function: "f", URL: "https://shop.example/assets/app.js", Line: 9},
		{},
	})
}

func TestParseMultiLineMessage(t *testing.T) {
	tr := Parse("Error: first line\nsecond line\r\n    at f (https://a/b.js:1:2)", 50)
	if tr.Header != "Error: first line\nsecond line" {
		t.Fatalf("header %q", tr.Header)
	}
	checkFrames(t, tr.Frames, []Frame{{Function: "f", URL: "https://a/b.js", Line: 1, Column: 2}})
}

func TestParseHugeNumbers(t *testing.T) {
	tr := Parse("    at f (https://a/b.js:99999999999999999999:3)", 50)
	if len(tr.Frames) != 1 || tr.Frames[0].Line != 0 {
		t.Fatalf("%+v", tr.Frames)
	}
}

func TestMaxFrames(t *testing.T) {
	s := "Error: x" + strings.Repeat("\n    at f (https://a/b.js:1:1)", 100)
	if got := len(Parse(s, 50).Frames); got != 50 {
		t.Fatalf("%d frames", got)
	}
	if got := len(Parse(s, 0).Frames); got != 100 {
		t.Fatalf("unlimited: %d frames", got)
	}
}

func TestString(t *testing.T) {
	tr := Trace{Header: "Error: x", Frames: []Frame{
		{Function: "computeTotal", URL: "src/app.ts", Line: 2, Column: 10},
		{URL: "src/app.ts", Line: 9, Column: 3},
		{Raw: "    at Array.map (<anonymous>)"},
		{Function: "f", URL: "src/app.ts", Line: 4},
	}}
	want := "Error: x\n    at computeTotal (src/app.ts:2:10)\n    at src/app.ts:9:3\n    at Array.map (<anonymous>)\n    at f (src/app.ts:4)"
	if got := tr.String(); got != want {
		t.Fatalf("%q", got)
	}
	if got := (Trace{Frames: []Frame{{URL: "a.js", Line: 1, Column: 1}}}).String(); got != "    at a.js:1:1" {
		t.Fatalf("no header: %q", got)
	}
}

func TestParseV8WithoutColumn(t *testing.T) {
	tr := Parse("    at f (https://a/b.js:9)\n    at https://a/c.js:2", 50)
	checkFrames(t, tr.Frames, []Frame{
		{Function: "f", URL: "https://a/b.js", Line: 9},
		{URL: "https://a/c.js", Line: 2},
	})
}
