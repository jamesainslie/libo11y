package o11yhttp_test

import (
	"bytes"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11yhttp"
)

// modes are the middleware configurations whose request handling must agree.
func modes(env canonicalEnv) map[string][]o11yhttp.Option {
	return map[string][]o11yhttp.Option{
		"plain":         {o11yhttp.WithSDK(env.sdk)},
		"canonical":     {o11yhttp.WithSDK(env.sdk), o11yhttp.WithCanonicalLine()},
		"server timing": {o11yhttp.WithSDK(env.sdk), o11yhttp.WithServerTiming()},
		"both":          {o11yhttp.WithSDK(env.sdk), o11yhttp.WithCanonicalLine(), o11yhttp.WithServerTiming()},
	}
}

// net/http removes the temporary files of a multipart form through the
// request it gave the outermost handler. A form the application parsed on
// the request the middleware handed it must therefore reach that request,
// or an upload's temporary file is never removed.
func TestMultipartFormReachesTheOriginalRequest(t *testing.T) {
	t.Parallel()
	for name := range modes(canonicalEnv{}) {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := newCanonicalEnv(t)
			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			part, err := form.CreateFormFile("upload", "report.txt")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fmt.Fprint(part, "file contents"); err != nil {
				t.Fatal(err)
			}
			if err := form.Close(); err != nil {
				t.Fatal(err)
			}
			var tempFile string
			mux := http.NewServeMux()
			mux.HandleFunc("POST /upload", func(_ http.ResponseWriter, r *http.Request) {
				// A zero memory budget puts the file on disk.
				if err := r.ParseMultipartForm(0); err != nil {
					t.Errorf("ParseMultipartForm: %v", err)
					return
				}
				f, err := r.MultipartForm.File["upload"][0].Open()
				if err != nil {
					t.Errorf("open upload: %v", err)
					return
				}
				defer func() { _ = f.Close() }()
				if onDisk, ok := f.(*os.File); ok {
					tempFile = onDisk.Name()
				}
			})
			req := httptest.NewRequest(http.MethodPost, "/upload", &body)
			req.Header.Set("Content-Type", form.FormDataContentType())
			o11yhttp.NewHandler(mux, "upload", modes(env)[name]...).ServeHTTP(httptest.NewRecorder(), req)

			if tempFile == "" {
				t.Fatal("the upload was not written to a temporary file")
			}
			if req.MultipartForm == nil {
				_ = os.Remove(tempFile)
				t.Fatal("the original request has no MultipartForm, so net/http cannot remove the upload's temporary file")
			}
			// What net/http does when the request finishes.
			if err := req.MultipartForm.RemoveAll(); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(tempFile); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("temporary file %s survived the cleanup: %v", tempFile, err)
			}
		})
	}
}

// A server span carries http.route when a route pattern matched (the
// specification's HTTP server span requires it then), in the form the
// duration metric and the request summary use: the path template, without
// the method or host of the ServeMux pattern.
func TestServerSpanCarriesMatchedRoute(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		pattern, target string
		want            string
		panics          bool
	}{
		"method and path":  {"GET /users/{id}", "http://example.com/users/42", "/users/{id}", false},
		"path only":        {"/items/{id}", "http://example.com/items/7", "/items/{id}", false},
		"host and path":    {"example.com/hosted/{id}", "http://example.com/hosted/7", "/hosted/{id}", false},
		"method host path": {"GET example.com/both/{id}", "http://example.com/both/7", "/both/{id}", false},
		"handler panics":   {"GET /boom/{id}", "http://example.com/boom/1", "/boom/{id}", true},
		"no route matched": {"GET /users/{id}", "http://example.com/missing", "", false},
	}
	for name, tc := range cases {
		for mode := range modes(canonicalEnv{}) {
			t.Run(name+"/"+mode, func(t *testing.T) {
				t.Parallel()
				env := newCanonicalEnv(t)
				mux := http.NewServeMux()
				mux.HandleFunc(tc.pattern, func(http.ResponseWriter, *http.Request) {
					if tc.panics {
						panic("boom")
					}
				})
				h := o11yhttp.NewHandler(mux, "route", modes(env)[mode]...)
				var recovered any
				func() {
					defer func() { recovered = recover() }()
					h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, tc.target, nil))
				}()
				if (recovered != nil) != tc.panics {
					t.Fatalf("recovered = %v, want panic = %v", recovered, tc.panics)
				}
				spans := env.spans.Ended()
				if len(spans) != 1 {
					t.Fatalf("got %d spans, want 1", len(spans))
				}
				got, ok := attrValue(spans[0].Attributes(), "http.route")
				if got != tc.want || ok != (tc.want != "") {
					t.Errorf("span http.route = %q (present %v), want %q", got, ok, tc.want)
				}
				if tc.want == "" {
					return
				}
				if mode == "canonical" || mode == "both" {
					s := env.summaries()
					if len(s) != 1 {
						t.Fatalf("got %d summaries, want 1", len(s))
					}
					if s[0]["http.route"] != tc.want {
						t.Errorf("summary http.route = %v, want %s", s[0]["http.route"], tc.want)
					}
				}
				if tc.panics {
					return // otelhttp records no duration for a request that panics
				}
				if routes := env.durationRoutes(t); len(routes) != 1 || routes[0] != tc.want {
					t.Errorf("duration metric routes = %v, want [%s]", routes, tc.want)
				}
			})
		}
	}
}

// The middleware decides once per request whether to instrument it. A
// filter that reads the request context gives a different answer once the
// server span is in it, so asking again inside the span would trace the
// request and then skip the panic status, the summary and the
// Server-Timing entry.
func TestFilterIsAskedOncePerRequest(t *testing.T) {
	t.Parallel()
	for _, panics := range []bool{false, true} {
		t.Run(fmt.Sprintf("panics=%v", panics), func(t *testing.T) {
			t.Parallel()
			env := newCanonicalEnv(t)
			var asked atomic.Int32
			outsideAnySpan := func(r *http.Request) bool {
				asked.Add(1)
				return !trace.SpanContextFromContext(r.Context()).IsValid()
			}
			mux := http.NewServeMux()
			mux.HandleFunc("GET /page", func(w http.ResponseWriter, _ *http.Request) {
				if panics {
					panic("boom")
				}
				w.Header().Set("Content-Type", "text/html")
				if _, err := fmt.Fprint(w, "<html></html>"); err != nil {
					t.Errorf("write body: %v", err)
				}
			})
			h := o11yhttp.NewHandler(mux, "once", o11yhttp.WithSDK(env.sdk),
				o11yhttp.WithCanonicalLine(), o11yhttp.WithServerTiming(), o11yhttp.WithFilter(outsideAnySpan))
			rec := httptest.NewRecorder()
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/page", nil))
			}()
			if (recovered != nil) != panics {
				t.Fatalf("recovered = %v, want panic = %v", recovered, panics)
			}

			if n := asked.Load(); n != 1 {
				t.Errorf("filter asked %d times, want once", n)
			}
			span, summary := env.single(t)
			if panics {
				if span.Status().Code != codes.Error {
					t.Errorf("span status = %v, want Error for a panic", span.Status())
				}
				if summary["http.response.status_code"] != int64(http.StatusInternalServerError) {
					t.Errorf("summary status = %v, want 500", summary["http.response.status_code"])
				}
				return
			}
			if got := rec.Header().Get("Server-Timing"); got != wantEntry(span.SpanContext()) {
				t.Errorf("Server-Timing = %q, want %q", got, wantEntry(span.SpanContext()))
			}
		})
	}
}

// A server span is named "{method} {route}" (docs/SPEC.md section 3). When
// no ServeMux pattern matched there is no low-cardinality target, so the
// name is the method alone, never the operation string and never the raw
// path. This covers a 404 and every router that does not set
// Request.Pattern.
func TestUnroutedServerSpanIsNamedByMethod(t *testing.T) {
	t.Parallel()
	cases := map[string]struct{ method, want string }{
		"known method":      {http.MethodGet, "GET"},
		"lower case method": {"post", "POST"},
		"unknown method":    {"XQZ123", "HTTP"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := newCanonicalEnv(t)
			h := o11yhttp.NewHandler(http.NotFoundHandler(), "api", o11yhttp.WithSDK(env.sdk))
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, "/x/123", nil))
			spans := env.spans.Ended()
			if len(spans) != 1 {
				t.Fatalf("got %d spans, want 1", len(spans))
			}
			if got := spans[0].Name(); got != tc.want {
				t.Errorf("span name = %q, want %q", got, tc.want)
			}
		})
	}
}

// A custom formatter still receives the operation name, so an application
// that wants it in its span names can put it there.
func TestSpanNameFormatterReceivesOperation(t *testing.T) {
	t.Parallel()
	env := newCanonicalEnv(t)
	h := o11yhttp.NewHandler(http.NotFoundHandler(), "api", o11yhttp.WithSDK(env.sdk),
		o11yhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
			return operation + " " + r.Method
		}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x/123", nil))
	if spans := env.spans.Ended(); len(spans) != 1 || spans[0].Name() != "api GET" {
		t.Fatalf("spans = %v, want one named %q", spans, "api GET")
	}
}
