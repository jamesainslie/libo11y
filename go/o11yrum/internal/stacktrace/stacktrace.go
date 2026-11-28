// Package stacktrace parses the JavaScript stack traces V8, Gecko and
// WebKit produce, and formats them back in V8's shape.
package stacktrace

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Frame is one stack frame. A frame the parser did not recognise keeps
// only Raw.
type Frame struct {
	Function string
	URL      string
	Line     int // 1-based; 0 when absent
	Column   int // 1-based; 0 when absent
	Raw      string
}

// Trace is a parsed stack trace.
type Trace struct {
	// Header is the text before the first frame, such as
	// "TypeError: x is undefined". V8 puts the message there; Gecko and
	// WebKit stacks have none.
	Header string
	Frames []Frame
}

var (
	// v8Frame matches "at fn (url:line:col)" and "at url:line:col", with
	// the column optional.
	v8Frame = regexp.MustCompile(`^at (?:(?:async )?(?:new )?(.*?) \()?(.+?):(\d+)(?::(\d+))?\)?$`)
	// geckoFrame matches "fn@url:line:col", with fn and col optional.
	geckoFrame = regexp.MustCompile(`^(.*?)@(.+?):(\d+)(?::(\d+))?$`)
	// v8Other matches any other V8 frame, such as "at Array.map (<anonymous>)".
	v8Other = regexp.MustCompile(`^at `)
)

// Parse reads a stack trace, keeping at most maxFrames frames (no limit
// when maxFrames is zero or less). It never fails: a line it does not
// recognise becomes part of the header when no frame came before it, and
// a frame holding only Raw otherwise.
func Parse(s string, maxFrames int) Trace {
	var t Trace
	var header []string
	for line := range strings.SplitSeq(s, "\n") {
		line = strings.TrimRightFunc(line, unicode.IsSpace)
		body := strings.TrimLeftFunc(line, unicode.IsSpace)
		if body == "" {
			continue
		}
		if maxFrames > 0 && len(t.Frames) == maxFrames {
			break
		}
		if m := v8Frame.FindStringSubmatch(body); m != nil {
			t.Frames = append(t.Frames, Frame{Function: m[1], URL: m[2], Line: atoi(m[3]), Column: atoi(m[4]), Raw: line})
			continue
		}
		if m := geckoFrame.FindStringSubmatch(body); m != nil {
			t.Frames = append(t.Frames, Frame{Function: m[1], URL: m[2], Line: atoi(m[3]), Column: atoi(m[4]), Raw: line})
			continue
		}
		if v8Other.MatchString(body) || len(t.Frames) > 0 {
			t.Frames = append(t.Frames, Frame{Raw: line})
			continue
		}
		header = append(header, line)
	}
	t.Header = strings.Join(header, "\n")
	return t
}

// atoi reads a line or column number: 0 when it does not parse or does
// not fit in 31 bits.
func atoi(s string) int {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n > math.MaxInt32 {
		return 0
	}
	return int(n)
}

// String formats the trace in V8's shape: the header, then one
// "    at fn (url:line:col)" line per frame. A frame without a URL, or
// parsed without a usable line number, is written as its raw line.
func (t Trace) String() string {
	var b strings.Builder
	b.WriteString(t.Header)
	for _, f := range t.Frames {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString("    ")
		switch {
		case f.URL == "", f.Line == 0 && f.Raw != "":
			b.WriteString(strings.TrimSpace(f.Raw))
		case f.Function == "":
			b.WriteString("at ")
			writeLocation(&b, f)
		default:
			b.WriteString("at ")
			b.WriteString(f.Function)
			b.WriteString(" (")
			writeLocation(&b, f)
			b.WriteByte(')')
		}
	}
	return b.String()
}

// writeLocation writes url[:line[:col]].
func writeLocation(b *strings.Builder, f Frame) {
	b.WriteString(f.URL)
	if f.Line > 0 {
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(f.Line))
		if f.Column > 0 {
			b.WriteByte(':')
			b.WriteString(strconv.Itoa(f.Column))
		}
	}
}
