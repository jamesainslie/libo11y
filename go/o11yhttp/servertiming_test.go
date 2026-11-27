package o11yhttp_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/textproto"
	"regexp"
	"slices"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// webTraceparent is the traceparent shape @libo11y/web's document-load
// instrumentation accepts (server-timing.ts): version 00, lowercase hex.
var webTraceparent = regexp.MustCompile(`^traceparent;desc="00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}"$`)

func wantEntry(sc trace.SpanContext) string {
	return `traceparent;desc="00-` + sc.TraceID().String() + "-" + sc.SpanID().String() + "-" + sc.TraceFlags().String() + `"`
}

// TestServerTiming drives each case through a real server and checks the
// Server-Timing values the client receives. The expected entry is built
// from the span context the handler saw, so it names the server span.
func TestServerTiming(t *testing.T) {
	t.Parallel()
	const unsampledParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"

	tests := []struct {
		name        string
		opts        []o11yhttp.Option
		traceparent string
		path        string
		handler     func(w http.ResponseWriter, r *http.Request)
		// prior is the handler's own Server-Timing values, which come
		// before the traceparent entry.
		prior     []string
		wantEntry bool
		wantFlags string
	}{
		{
			name: "html with explicit WriteHeader",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "html with implicit 200",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "Text/HTML; charset=utf-8")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "html error page",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, "<p>not found</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "json",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"ok":true}`)
			},
		},
		{
			name: "missing content type and no body",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			},
		},
		{
			name:    "handler that never writes",
			handler: func(http.ResponseWriter, *http.Request) {},
		},
		{
			name: "missing content type sniffed as html",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, "<!DOCTYPE html><p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "missing content type sniffed as text",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, "hello")
			},
		},
		{
			name: "handler sets its own Server-Timing",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Server-Timing", "db;dur=1")
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			prior:     []string{"db;dur=1"},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "content type set after the first write is too late",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, "hello")
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
		},
		{
			name: "flush commits the headers",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				w.(http.Flusher).Flush()
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "ResponseController flush",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				if err := http.NewResponseController(w).Flush(); err != nil {
					t.Errorf("Flush: %v", err)
				}
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "ReadFrom",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = w.(io.ReaderFrom).ReadFrom(strings.NewReader("<p>hi</p>"))
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "ReadFrom without content type sniffed as html",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.(io.ReaderFrom).ReadFrom(strings.NewReader("<!DOCTYPE html>" + strings.Repeat("<p>hi</p>", 200)))
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "ReadFrom without content type sniffed as text",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.(io.ReaderFrom).ReadFrom(strings.NewReader(strings.Repeat("hello ", 200)))
			},
		},
		{
			name: "empty ReadFrom commits nothing",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.(io.ReaderFrom).ReadFrom(strings.NewReader(""))
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "content encoding suppresses sniffing",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Encoding", "br")
				_, _ = io.WriteString(w, "<!DOCTYPE html><p>hi</p>")
			},
		},
		{
			name: "hijacked connection",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				conn, buf, err := http.NewResponseController(w).Hijack()
				if err != nil {
					t.Errorf("Hijack: %v", err)
					return
				}
				defer func() { _ = conn.Close() }()
				_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi")
				_ = buf.Flush()
			},
		},
		{
			name: "with the canonical line",
			opts: []o11yhttp.Option{o11yhttp.WithCanonicalLine()},
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name: "no valid span context",
			opts: []o11yhttp.Option{o11yhttp.WithSDK(nil)}, // the global no-op tracer provider
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
		},
		{
			name: "filtered request",
			opts: []o11yhttp.Option{o11yhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/page" })},
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
		},
		{
			name: "early hints before the final html status",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Link", "</app.css>; rel=preload; as=style")
				w.WriteHeader(http.StatusEarlyHints)
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "01",
		},
		{
			name:        "unsampled span",
			traceparent: unsampledParent,
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>hi</p>")
			},
			wantEntry: true,
			wantFlags: "00",
		},
		{
			name: "ignored path",
			opts: []o11yhttp.Option{o11yhttp.WithIgnorePaths("/healthz")},
			path: "/healthz",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = io.WriteString(w, "<p>ok</p>")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			// ParentBased, the o11y.New default, so an unsampled inbound
			// parent yields an unsampled server span.
			rec := o11ytest.Start(t, o11y.WithTraceSampler(sdktrace.ParentBased(sdktrace.AlwaysSample())))
			seen := make(chan trace.SpanContext, 1)
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen <- trace.SpanContextFromContext(r.Context())
				tt.handler(w, r)
			})
			opts := append([]o11yhttp.Option{o11yhttp.WithSDK(rec.SDK), o11yhttp.WithServerTiming()}, tt.opts...)

			for _, form := range []string{"handler", "middleware"} {
				var h http.Handler
				if form == "handler" {
					h = o11yhttp.NewHandler(handler, "server", opts...)
				} else {
					h = o11yhttp.NewMiddleware("server", opts...)(handler)
				}
				server := httptest.NewServer(h)
				path := tt.path
				if path == "" {
					path = "/page"
				}
				req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
				if err != nil {
					t.Fatal(err)
				}
				if tt.traceparent != "" {
					req.Header.Set("Traceparent", tt.traceparent)
				}
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				server.Close()
				sc := <-seen

				got := resp.Header.Values("Server-Timing")
				want := slices.Clone(tt.prior)
				if tt.wantEntry {
					if !sc.IsValid() {
						t.Fatalf("%s: handler saw no valid span context", form)
					}
					if flags := sc.TraceFlags().String(); flags != tt.wantFlags {
						t.Fatalf("%s: span flags = %s, want %s", form, flags, tt.wantFlags)
					}
					want = append(want, wantEntry(sc))
				}
				if !slices.Equal(got, want) {
					t.Errorf("%s: Server-Timing = %q, want %q", form, got, want)
				}
				if tt.wantEntry && len(got) > 0 && !webTraceparent.MatchString(got[len(got)-1]) {
					t.Errorf("%s: %q does not match the @libo11y/web traceparent shape", form, got[len(got)-1])
				}
			}
		})
	}
}

// TestServerTimingOffByDefault checks that without WithServerTiming an
// HTML response carries no Server-Timing entry.
func TestServerTimingOffByDefault(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t)
	h := o11yhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<p>hi</p>")
	}), "server", o11yhttp.WithSDK(rec.SDK))

	recorded := httptest.NewRecorder()
	h.ServeHTTP(recorded, httptest.NewRequest(http.MethodGet, "/page", nil))
	if got := recorded.Result().Header.Values("Server-Timing"); len(got) != 0 {
		t.Errorf("Server-Timing = %q, want none", got)
	}
}

// TestServerTimingNamesTheServerSpan checks the entry against the recorded
// server span, the one the browser's document-load span adopts as parent.
func TestServerTimingNamesTheServerSpan(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t)
	h := o11yhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<p>hi</p>")
	}), "server", o11yhttp.WithSDK(rec.SDK), o11yhttp.WithServerTiming())

	recorded := httptest.NewRecorder()
	h.ServeHTTP(recorded, httptest.NewRequest(http.MethodGet, "/page", nil))
	spans := rec.Spans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	want := wantEntry(spans[0].SpanContext())
	if got := recorded.Result().Header.Get("Server-Timing"); got != want {
		t.Errorf("Server-Timing = %q, want %q", got, want)
	}
}

// TestServerTimingNotOnEarlyHints checks that a 103 Early Hints response
// does not carry the entry and the final HTML response does.
func TestServerTimingNotOnEarlyHints(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t)
	server := httptest.NewServer(o11yhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Link", "</app.css>; rel=preload; as=style")
		w.WriteHeader(http.StatusEarlyHints)
		_, _ = io.WriteString(w, "<p>hi</p>")
	}), "server", o11yhttp.WithSDK(rec.SDK), o11yhttp.WithServerTiming()))
	t.Cleanup(server.Close)

	var hints []http.Header
	ctx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
		Got1xxResponse: func(code int, header textproto.MIMEHeader) error {
			hints = append(hints, http.Header(header))
			return nil
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	if len(hints) != 1 {
		t.Fatalf("got %d informational responses, want 1", len(hints))
	}
	if got := hints[0].Values("Server-Timing"); len(got) != 0 {
		t.Errorf("103 Server-Timing = %q, want none", got)
	}
	if got := resp.Header.Values("Server-Timing"); len(got) != 1 || !webTraceparent.MatchString(got[0]) {
		t.Errorf("final Server-Timing = %q, want one traceparent entry", got)
	}
}
