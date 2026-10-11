package o11yhttp_test

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/spec"
)

type canonicalEnv struct {
	sdk     *o11y.SDK
	spans   *tracetest.SpanRecorder
	reader  *sdkmetric.ManualReader
	records func() []map[string]any
}

func newCanonicalEnv(t *testing.T) canonicalEnv {
	t.Helper()
	capture, snapshot := newCapture()
	spans := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("canonical-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(spans),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithExtraLogHandler(capture),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = sdk.Shutdown(context.Background()) })
	return canonicalEnv{sdk: sdk, spans: spans, reader: reader, records: snapshot}
}

func (e canonicalEnv) summaries() []map[string]any {
	var out []map[string]any
	for _, r := range e.records() {
		if r[spec.EventNameKey] == spec.EventRequestSummary {
			out = append(out, r)
		}
	}
	return out
}

// durationRoutes returns the http.route values on the server duration histogram.
func (e canonicalEnv) durationRoutes(t *testing.T) []string {
	t.Helper()
	var data metricdata.ResourceMetrics
	if err := e.reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	var routes []string
	for _, sm := range data.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "http.server.request.duration" {
				continue
			}
			hist, ok := m.Data.(metricdata.Histogram[float64])
			if !ok {
				t.Fatalf("duration metric is %T", m.Data)
			}
			for _, dp := range hist.DataPoints {
				if v, ok := dp.Attributes.Value(attribute.Key("http.route")); ok {
					routes = append(routes, v.AsString())
				}
			}
		}
	}
	return routes
}

func TestCanonicalLinePreservesRouteNaming(t *testing.T) {
	builders := map[string]func(http.Handler, ...o11yhttp.Option) http.Handler{
		"NewHandler": func(h http.Handler, opts ...o11yhttp.Option) http.Handler {
			return o11yhttp.NewHandler(h, "users", opts...)
		},
		"NewMiddleware": func(h http.Handler, opts ...o11yhttp.Option) http.Handler {
			return o11yhttp.NewMiddleware("users", opts...)(h)
		},
	}
	formatters := map[string]struct {
		opts []o11yhttp.Option
		want string
	}{
		"default": {nil, "GET /users/{id}"},
		"custom": {[]o11yhttp.Option{o11yhttp.WithSpanNameFormatter(func(op string, r *http.Request) string {
			return op + " " + r.Pattern
		})}, "users GET /users/{id}"},
	}
	const parentTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
	for bname, build := range builders {
		for fname, f := range formatters {
			t.Run(bname+"/"+fname, func(t *testing.T) {
				t.Parallel()
				run := func(canonical bool) canonicalEnv {
					env := newCanonicalEnv(t)
					mux := http.NewServeMux()
					mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, _ *http.Request) {
						w.WriteHeader(http.StatusOK)
					})
					opts := append([]o11yhttp.Option{o11yhttp.WithSDK(env.sdk)}, f.opts...)
					if canonical {
						opts = append(opts, o11yhttp.WithCanonicalLine())
					}
					req := httptest.NewRequest(http.MethodGet, "/users/42", nil)
					req.Header.Set("traceparent", "00-"+parentTrace+"-00f067aa0ba902b7-01")
					build(mux, opts...).ServeHTTP(httptest.NewRecorder(), req)
					return env
				}
				control, got := run(false), run(true)

				gotSpans, controlSpans := got.spans.Ended(), control.spans.Ended()
				if len(gotSpans) != 1 || len(controlSpans) != 1 {
					t.Fatalf("spans: canonical %d, control %d; want 1 each", len(gotSpans), len(controlSpans))
				}
				if name := gotSpans[0].Name(); name != f.want || name != controlSpans[0].Name() {
					t.Errorf("span name = %q, control %q, want %q", name, controlSpans[0].Name(), f.want)
				}
				if tid := gotSpans[0].Parent().TraceID().String(); tid != parentTrace {
					t.Errorf("parent trace = %s, want %s (propagation broken)", tid, parentTrace)
				}
				if _, ok := attrValue(controlSpans[0].Attributes(), "http.route"); ok {
					if v, _ := attrValue(gotSpans[0].Attributes(), "http.route"); v != "/users/{id}" {
						t.Errorf("span http.route = %q, want /users/{id}", v)
					}
				}
				if routes := got.durationRoutes(t); len(routes) != 1 || routes[0] != "/users/{id}" {
					t.Errorf("duration metric routes = %v, want [/users/{id}]", routes)
				}
				s := got.summaries()
				if len(s) != 1 || s[0]["http.route"] != "/users/{id}" {
					t.Errorf("summary = %v, want http.route /users/{id}", s)
				}
			})
		}
	}
}

func attrValue(attrs []attribute.KeyValue, key string) (string, bool) {
	for _, a := range attrs {
		if string(a.Key) == key {
			return a.Value.String(), true
		}
	}
	return "", false
}

func quietServer(h http.Handler) *httptest.Server {
	srv := httptest.NewUnstartedServer(h)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.Start()
	return srv
}

// plainWriter implements only http.ResponseWriter.
type plainWriter struct{ h http.Header }

func (p *plainWriter) Header() http.Header {
	if p.h == nil {
		p.h = http.Header{}
	}
	return p.h
}
func (p *plainWriter) Write(b []byte) (int, error) { return len(b), nil }
func (p *plainWriter) WriteHeader(int)             {}

type writerCaps struct {
	flusher, hijacker, readerFrom bool
	controllerFlushErr            bool
}

func capsHandler(out chan<- writerCaps) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		var c writerCaps
		_, c.flusher = w.(http.Flusher)
		_, c.hijacker = w.(http.Hijacker)
		_, c.readerFrom = w.(io.ReaderFrom)
		c.controllerFlushErr = http.NewResponseController(w).Flush() != nil
		out <- c
	})
}

func TestCanonicalLinePreservesWriterInterfaces(t *testing.T) {
	cases := map[string]func(t *testing.T, h http.Handler){
		"recorder": func(_ *testing.T, h http.Handler) {
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
		},
		"plain": func(_ *testing.T, h http.Handler) {
			h.ServeHTTP(&plainWriter{}, httptest.NewRequest(http.MethodGet, "/", nil))
		},
		"server": func(t *testing.T, h http.Handler) {
			srv := quietServer(h)
			defer srv.Close()
			resp, err := srv.Client().Get(srv.URL)
			if err != nil {
				t.Fatalf("GET: %v", err)
			}
			_ = resp.Body.Close()
		},
	}
	for name, drive := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := newCanonicalEnv(t)
			measure := func(opts ...o11yhttp.Option) writerCaps {
				out := make(chan writerCaps, 1)
				drive(t, o11yhttp.NewHandler(capsHandler(out), "caps", append([]o11yhttp.Option{o11yhttp.WithSDK(env.sdk)}, opts...)...))
				return <-out
			}
			control := measure()
			got := measure(o11yhttp.WithCanonicalLine())
			if got != control {
				t.Errorf("canonical line changed writer capabilities: got %+v, control %+v", got, control)
			}
		})
	}
}

func TestCanonicalLineHonorsFilters(t *testing.T) {
	t.Parallel()
	env := newCanonicalEnv(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(http.ResponseWriter, *http.Request) {})
	mux.HandleFunc("GET /users/{id}", func(http.ResponseWriter, *http.Request) {})
	h := o11yhttp.NewHandler(mux, "f", o11yhttp.WithSDK(env.sdk), o11yhttp.WithCanonicalLine(),
		o11yhttp.WithIgnorePaths("/healthz"),
		o11yhttp.WithFilter(func(r *http.Request) bool { return r.Header.Get("X-Skip") == "" }))
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/healthz", nil),
		func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/users/1", nil)
			r.Header.Set("X-Skip", "1")
			return r
		}(),
		httptest.NewRequest(http.MethodGet, "/users/2", nil),
	} {
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	if s := env.summaries(); len(s) != 1 {
		t.Fatalf("got %d summaries, want 1 (filtered requests must not emit)", len(s))
	}
	if n := len(env.spans.Ended()); n != 1 {
		t.Fatalf("got %d spans, want 1", n)
	}
}
