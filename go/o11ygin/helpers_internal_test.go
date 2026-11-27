package o11ygin

import (
	"net/http"
	"testing"

	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/internal/servertiming"
)

// TestHelpersMatchCore checks that the Server-Timing helpers copied into
// this module agree with the core module's servertiming package, so the Gin
// and net/http middleware send the same entry for the same responses.
func TestHelpersMatchCore(t *testing.T) {
	tid, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	sid, _ := trace.SpanIDFromHex("00f067aa0ba902b7")
	for _, sc := range []trace.SpanContext{
		{},
		trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid}),
		trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid, TraceFlags: trace.FlagsSampled}),
	} {
		got, gotOK := serverTimingEntry(sc)
		want, wantOK := servertiming.Entry(sc)
		if got != want || gotOK != wantOK {
			t.Errorf("serverTimingEntry(%v) = %q, %v; core gives %q, %v", sc, got, gotOK, want, wantOK)
		}
	}
	if sniffLen != servertiming.SniffLen {
		t.Errorf("sniffLen = %d, core SniffLen = %d", sniffLen, servertiming.SniffLen)
	}

	headers := []http.Header{
		{},
		{"Content-Type": {"text/html"}},
		{"Content-Type": {"Text/HTML; charset=utf-8"}},
		{"Content-Type": {"application/json"}},
		{"Content-Type": nil},
		{"Content-Encoding": {"br"}},
		{"Transfer-Encoding": {"chunked"}},
	}
	bodies := [][]byte{nil, []byte("hello"), []byte("<!DOCTYPE html><p>hi</p>")}
	for _, h := range headers {
		for _, body := range bodies {
			for _, sniff := range []bool{false, true} {
				if got, want := htmlResponse(h, body, sniff), servertiming.HTMLResponse(h, body, sniff); got != want {
					t.Errorf("htmlResponse(%v, %q, %v) = %v; core gives %v", h, body, sniff, got, want)
				}
			}
		}
	}
}
