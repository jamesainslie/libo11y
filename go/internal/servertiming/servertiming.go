// Package servertiming builds the Server-Timing entry that carries a server
// span's trace context to the browser, and decides which responses get it.
//
// The entry is `traceparent;desc="00-<trace-id>-<span-id>-<flags>"`, the
// format the TypeScript, Zig and Python servers emit and @libo11y/web's
// document-load instrumentation reads, so the page's documentLoad span can
// adopt the server span as its parent. Only HTML responses carry it: a
// document load is the one navigation whose server span the page cannot
// otherwise learn.
package servertiming

import (
	"net/http"
	"strings"

	"go.opentelemetry.io/otel/trace"
)

// Header is the response header the entry is added to.
const Header = "Server-Timing"

// Entry returns the Server-Timing entry naming sc, and false when sc is not
// a valid span context (no trace or span id), in which case nothing should
// be sent. Unsampled contexts are valid and keep their flags.
func Entry(sc trace.SpanContext) (string, bool) {
	if !sc.IsValid() {
		return "", false
	}
	return `traceparent;desc="00-` + sc.TraceID().String() + "-" + sc.SpanID().String() +
		"-" + sc.TraceFlags().String() + `"`, true
}

// IsHTML reports whether a Content-Type value names text/html: the media
// type before any parameters, trimmed and compared case-insensitively.
func IsHTML(contentType string) bool {
	media, _, _ := strings.Cut(contentType, ";")
	return strings.EqualFold(strings.TrimSpace(media), "text/html")
}

// SniffLen is the number of body bytes net/http's content sniffing reads.
const SniffLen = 512

// HTMLResponse reports whether a response with header h will be sent as
// HTML. A declared Content-Type decides. Without one, and only when sniff is
// set (the headers are being committed by a body write), it uses the type
// http.DetectContentType finds in body. net/http sniffs only when there is
// no Content-Type key at all (a nil value suppresses sniffing), no
// Content-Encoding and no Transfer-Encoding, so those suppress it here too.
// net/http sniffs its first buffered chunk, which can span several writes;
// body is the first write alone.
func HTMLResponse(h http.Header, body []byte, sniff bool) bool {
	if values, declared := h["Content-Type"]; declared {
		return len(values) > 0 && IsHTML(values[0])
	}
	if !sniff || h.Get("Content-Encoding") != "" || h.Get("Transfer-Encoding") != "" {
		return false
	}
	return IsHTML(http.DetectContentType(body))
}
