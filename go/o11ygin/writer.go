package o11ygin

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/trace"
)

// timingWriter adds the server span's Server-Timing entry to an HTML
// response when a handler commits its headers through c.Writer. Gin's own
// WriteHeader only records the status, so the commit points are Write,
// WriteString, WriteHeaderNow and Flush. The decision is made once, at the
// first of them, because net/http ignores header changes after that.
//
// span is the server span otelgin started, captured by captureTracer when
// otelgin starts it, so a handler that later puts a child span in
// c.Request cannot change which span the entry names.
type timingWriter struct {
	gin.ResponseWriter
	span    trace.SpanContext
	started bool // otelgin has started the server span; span is set
	decided bool
}

var _ gin.ResponseWriter = (*timingWriter)(nil)

func (w *timingWriter) decide(body []byte, sniff bool) {
	if w.decided {
		return
	}
	w.decided = true
	if w.Written() {
		return // committed before this writer saw it; too late to add a header
	}
	entry, ok := serverTimingEntry(w.span)
	if !ok {
		return
	}
	if h := w.Header(); htmlResponse(h, body, sniff) {
		h.Add("Server-Timing", entry)
	}
}

func (w *timingWriter) Write(b []byte) (int, error) {
	w.decide(b, true)
	return w.ResponseWriter.Write(b)
}

func (w *timingWriter) WriteString(s string) (int, error) {
	if !w.decided {
		w.decide([]byte(s[:min(len(s), sniffLen)]), true)
	}
	return w.ResponseWriter.WriteString(s)
}

func (w *timingWriter) WriteHeaderNow() {
	w.decide(nil, false)
	w.ResponseWriter.WriteHeaderNow()
}

func (w *timingWriter) Flush() {
	w.decide(nil, false)
	w.ResponseWriter.Flush()
}

// Unwrap exposes Gin's writer to http.ResponseController.
func (w *timingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// timingKey is the request context key under which the middleware leaves
// the request's timingWriter for captureTracer to find.
type timingKey struct{}

// captureProvider wraps the tracer provider otelgin uses, so the tracer it
// hands out records the server span on the request's timingWriter.
type captureProvider struct{ trace.TracerProvider }

func (p captureProvider) Tracer(name string, opts ...trace.TracerOption) trace.Tracer {
	return captureTracer{p.TracerProvider.Tracer(name, opts...)}
}

// captureTracer records the first span started with a context carrying a
// timingWriter. otelgin starts the server span first; later spans from the
// same tracer (otelgin's renderer helpers) are children and are ignored.
type captureTracer struct{ trace.Tracer }

func (t captureTracer) Start(ctx context.Context, name string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	ctx, span := t.Tracer.Start(ctx, name, opts...)
	if w, ok := ctx.Value(timingKey{}).(*timingWriter); ok && !w.started {
		w.span, w.started = span.SpanContext(), true
	}
	return ctx, span
}

// sniffLen is the number of body bytes net/http's content sniffing reads.
const sniffLen = 512

// serverTimingEntry, isHTML and htmlResponse mirror the core module's
// internal servertiming package (TestHelpersMatchCore checks they agree).
// They are copied rather than imported so this module never depends on the
// core module's internals, which a newer core release may change.

// serverTimingEntry returns `traceparent;desc="00-<trace-id>-<span-id>-<flags>"`
// for sc, and false when sc is not valid.
func serverTimingEntry(sc trace.SpanContext) (string, bool) {
	if !sc.IsValid() {
		return "", false
	}
	return `traceparent;desc="00-` + sc.TraceID().String() + "-" + sc.SpanID().String() +
		"-" + sc.TraceFlags().String() + `"`, true
}

// isHTML reports whether a Content-Type value names text/html.
func isHTML(contentType string) bool {
	media, _, _ := strings.Cut(contentType, ";")
	return strings.EqualFold(strings.TrimSpace(media), "text/html")
}

// htmlResponse reports whether a response with header h will be sent as
// HTML: a declared Content-Type decides; without one, and only when sniff
// is set, the type net/http sniffs from body, which it does only with no
// Content-Type key, no Content-Encoding and no Transfer-Encoding.
func htmlResponse(h http.Header, body []byte, sniff bool) bool {
	if values, declared := h["Content-Type"]; declared {
		return len(values) > 0 && isHTML(values[0])
	}
	if !sniff || h.Get("Content-Encoding") != "" || h.Get("Transfer-Encoding") != "" {
		return false
	}
	return isHTML(http.DetectContentType(body))
}
