package servertiming_test

import (
	"net/http"
	"testing"

	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/internal/servertiming"
)

func spanContext(t *testing.T, flags trace.TraceFlags) trace.SpanContext {
	t.Helper()
	tid, err := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	if err != nil {
		t.Fatal(err)
	}
	sid, err := trace.SpanIDFromHex("00f067aa0ba902b7")
	if err != nil {
		t.Fatal(err)
	}
	return trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid, TraceFlags: flags})
}

func TestEntry(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		sc     trace.SpanContext
		want   string
		wantOK bool
	}{
		{
			name:   "sampled",
			sc:     spanContext(t, trace.FlagsSampled),
			want:   `traceparent;desc="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"`,
			wantOK: true,
		},
		{
			name:   "unsampled",
			sc:     spanContext(t, 0),
			want:   `traceparent;desc="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"`,
			wantOK: true,
		},
		{
			name:   "other flag bits are kept",
			sc:     spanContext(t, 0x03),
			want:   `traceparent;desc="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03"`,
			wantOK: true,
		},
		{name: "invalid", sc: trace.SpanContext{}, want: "", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := servertiming.Entry(tt.sc)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("Entry() = %q, %v; want %q, %v", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestIsHTML(t *testing.T) {
	t.Parallel()
	tests := []struct {
		contentType string
		want        bool
	}{
		{"text/html", true},
		{"text/html; charset=utf-8", true},
		{"Text/HTML; charset=utf-8", true},
		{"  text/html  ;q=1", true},
		{"application/xhtml+xml", false},
		{"text/htmlx", false},
		{"application/json", false},
		{"text/plain; charset=utf-8", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := servertiming.IsHTML(tt.contentType); got != tt.want {
			t.Errorf("IsHTML(%q) = %v, want %v", tt.contentType, got, tt.want)
		}
	}
}

func TestHTMLResponse(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		header http.Header
		body   []byte
		sniff  bool
		want   bool
	}{
		{name: "declared html", header: http.Header{"Content-Type": {"text/html"}}, want: true},
		{name: "declared json", header: http.Header{"Content-Type": {"application/json"}}, body: []byte("<html>"), sniff: true, want: false},
		{name: "no type, no body", header: http.Header{}, want: false},
		{name: "no type, sniffed html", header: http.Header{}, body: []byte("<!DOCTYPE html><p>hi"), sniff: true, want: true},
		{name: "no type, html body but no sniff", header: http.Header{}, body: []byte("<!DOCTYPE html>"), sniff: false, want: false},
		{name: "no type, sniffed text", header: http.Header{}, body: []byte("hello"), sniff: true, want: false},
		{name: "sniffing suppressed by nil type", header: http.Header{"Content-Type": nil}, body: []byte("<html>"), sniff: true, want: false},
		{name: "no sniff with content-encoding", header: http.Header{"Content-Encoding": {"br"}}, body: []byte("<html>"), sniff: true, want: false},
		{name: "no sniff with transfer-encoding", header: http.Header{"Transfer-Encoding": {"chunked"}}, body: []byte("<html>"), sniff: true, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := servertiming.HTMLResponse(tt.header, tt.body, tt.sniff); got != tt.want {
				t.Errorf("HTMLResponse() = %v, want %v", got, tt.want)
			}
		})
	}
}
