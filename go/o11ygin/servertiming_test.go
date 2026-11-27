package o11ygin_test

import (
	"cmp"
	"html/template"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11ygin"
)

func wantEntry(sc trace.SpanContext) string {
	return `traceparent;desc="00-` + sc.TraceID().String() + "-" + sc.SpanID().String() + "-" + sc.TraceFlags().String() + `"`
}

// TestServerTiming checks which Gin responses get the server span's
// Server-Timing entry. The expected entry is built from the span context
// the handler saw.
func TestServerTiming(t *testing.T) {
	tests := []struct {
		name        string
		opts        []o11ygin.Option
		path        string
		traceparent string
		handler     gin.HandlerFunc
		prior       []string
		wantEntry   bool
		wantFlags   string
	}{
		{
			name:      "html via Data",
			handler:   func(c *gin.Context) { c.Data(http.StatusOK, "text/html; charset=utf-8", []byte("<p>hi</p>")) },
			wantEntry: true,
		},
		{
			name:      "html template",
			handler:   func(c *gin.Context) { c.HTML(http.StatusOK, "page", gin.H{"Name": "hi"}) },
			wantEntry: true,
		},
		{
			name:    "json",
			handler: func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) },
		},
		{
			name:    "status only, no body",
			handler: func(c *gin.Context) { c.Status(http.StatusNoContent) },
		},
		{
			name: "html header written without a body",
			handler: func(c *gin.Context) {
				c.Header("Content-Type", "text/html")
				c.Status(http.StatusOK)
				c.Writer.WriteHeaderNow()
			},
			wantEntry: true,
		},
		{
			name: "missing content type sniffed as html",
			handler: func(c *gin.Context) {
				_, _ = c.Writer.WriteString("<!DOCTYPE html><p>hi</p>")
			},
			wantEntry: true,
		},
		{
			name: "missing content type sniffed as text",
			handler: func(c *gin.Context) {
				_, _ = c.Writer.Write([]byte("hello"))
			},
		},
		{
			name: "handler sets its own Server-Timing",
			handler: func(c *gin.Context) {
				c.Header("Server-Timing", "db;dur=1")
				c.Data(http.StatusOK, "text/html", []byte("<p>hi</p>"))
			},
			prior:     []string{"db;dur=1"},
			wantEntry: true,
		},
		{
			name: "flush commits the headers",
			handler: func(c *gin.Context) {
				c.Header("Content-Type", "text/html")
				c.Writer.Flush()
				_, _ = c.Writer.WriteString("<p>hi</p>")
			},
			wantEntry: true,
		},
		{
			name: "ResponseController flush",
			handler: func(c *gin.Context) {
				c.Header("Content-Type", "text/html")
				if err := http.NewResponseController(c.Writer).Flush(); err != nil {
					_ = c.Error(err)
				}
				_, _ = c.Writer.WriteString("<p>hi</p>")
			},
			wantEntry: true,
		},
		{
			name:        "unsampled span",
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
			handler:     func(c *gin.Context) { c.Data(http.StatusOK, "text/html", []byte("<p>hi</p>")) },
			wantEntry:   true,
			wantFlags:   "00",
		},
		{
			name:    "filtered request",
			opts:    []o11ygin.Option{o11ygin.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/page" })},
			handler: func(c *gin.Context) { c.Data(http.StatusOK, "text/html", []byte("<p>hi</p>")) },
		},
		{
			name:    "no valid span context",
			opts:    []o11ygin.Option{o11ygin.WithSDK(nil)}, // the global no-op tracer provider
			handler: func(c *gin.Context) { c.Data(http.StatusOK, "text/html", []byte("<p>hi</p>")) },
		},
		{
			name:    "ignored path",
			opts:    []o11ygin.Option{o11ygin.WithIgnorePaths("/healthz")},
			path:    "/healthz",
			handler: func(c *gin.Context) { c.Data(http.StatusOK, "text/html", []byte("<p>ok</p>")) },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sdk, _ := newSDK(t)
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.SetHTMLTemplate(template.Must(template.New("page").Parse("<p>{{.Name}}</p>")))
			opts := append([]o11ygin.Option{o11ygin.WithSDK(sdk), o11ygin.WithServerTiming()}, tt.opts...)
			router.Use(o11ygin.Middleware("api", opts...))
			var sc trace.SpanContext
			path := tt.path
			if path == "" {
				path = "/page"
			}
			router.GET(path, func(c *gin.Context) {
				sc = trace.SpanContextFromContext(c.Request.Context())
				tt.handler(c)
			})

			server := httptest.NewServer(router)
			t.Cleanup(server.Close)
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

			want := slices.Clone(tt.prior)
			if tt.wantEntry {
				if !sc.IsValid() {
					t.Fatal("handler saw no valid span context")
				}
				if flags := sc.TraceFlags().String(); flags != cmp.Or(tt.wantFlags, "01") {
					t.Fatalf("span flags = %s, want %s", flags, cmp.Or(tt.wantFlags, "01"))
				}
				want = append(want, wantEntry(sc))
			}
			if got := resp.Header.Values("Server-Timing"); !slices.Equal(got, want) {
				t.Errorf("Server-Timing = %q, want %q", got, want)
			}
		})
	}
}

// TestServerTimingOffByDefault checks that without WithServerTiming an
// HTML response carries no Server-Timing entry.
func TestServerTimingOffByDefault(t *testing.T) {
	sdk, _ := newSDK(t)
	router := newRouter(sdk)
	router.GET("/page", func(c *gin.Context) { c.Data(http.StatusOK, "text/html", []byte("<p>hi</p>")) })

	recorded := httptest.NewRecorder()
	router.ServeHTTP(recorded, httptest.NewRequest(http.MethodGet, "/page", nil))
	if got := recorded.Result().Header.Values("Server-Timing"); len(got) != 0 {
		t.Errorf("Server-Timing = %q, want none", got)
	}
}

// TestServerTimingNamesTheServerSpan checks the entry against the recorded
// server span and that the middleware restores the Gin writer.
func TestServerTimingNamesTheServerSpan(t *testing.T) {
	sdk, recorder := newSDK(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	var outer gin.ResponseWriter
	router.Use(func(c *gin.Context) {
		outer = c.Writer
		c.Next()
		if c.Writer != outer {
			t.Error("middleware did not restore c.Writer")
		}
	})
	router.Use(o11ygin.Middleware("api", o11ygin.WithSDK(sdk), o11ygin.WithServerTiming()))
	router.GET("/page", func(c *gin.Context) {
		c.Data(http.StatusOK, "text/html", []byte("<p>hi</p>"))
		if c.Writer.Status() != http.StatusOK || c.Writer.Size() != len("<p>hi</p>") {
			t.Errorf("writer reports status %d size %d", c.Writer.Status(), c.Writer.Size())
		}
	})

	recorded := httptest.NewRecorder()
	router.ServeHTTP(recorded, httptest.NewRequest(http.MethodGet, "/page", nil))
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	want := wantEntry(spans[0].SpanContext())
	if got := recorded.Result().Header.Get("Server-Timing"); got != want {
		t.Errorf("Server-Timing = %q, want %q", got, want)
	}
}

// TestServerTimingNamesTheServerSpanNotAChild checks that a handler which
// puts a child span in c.Request before rendering still sends the server
// span, the parent the browser's documentLoad span should adopt.
func TestServerTimingNamesTheServerSpanNotAChild(t *testing.T) {
	sdk, recorder := newSDK(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(o11ygin.Middleware("api", o11ygin.WithSDK(sdk), o11ygin.WithServerTiming()))
	router.GET("/page", func(c *gin.Context) {
		ctx, span := sdk.TracerProvider().Tracer("test").Start(c.Request.Context(), "render")
		defer span.End()
		c.Request = c.Request.WithContext(ctx)
		c.Data(http.StatusOK, "text/html", []byte("<p>hi</p>"))
	})

	recorded := httptest.NewRecorder()
	router.ServeHTTP(recorded, httptest.NewRequest(http.MethodGet, "/page", nil))
	var server trace.SpanContext
	for _, s := range recorder.Ended() {
		if s.SpanKind() == trace.SpanKindServer {
			server = s.SpanContext()
		}
	}
	if !server.IsValid() {
		t.Fatal("no server span recorded")
	}
	if got, want := recorded.Result().Header.Get("Server-Timing"), wantEntry(server); got != want {
		t.Errorf("Server-Timing = %q, want %q (the server span)", got, want)
	}
}
