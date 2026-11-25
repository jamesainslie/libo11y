package o11yhttp_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yhttp"
)

// nilArgOptions are option sets built from nil or zero arguments, each of
// which must leave the instrumentation working.
func nilArgOptions() map[string][]o11yhttp.Option {
	return map[string][]o11yhttp.Option{
		"nil option":         {nil},
		"WithSDK nil":        {o11yhttp.WithSDK(nil), o11yhttp.WithCanonicalLine()},
		"WithSDK zero":       {o11yhttp.WithSDK(&o11y.SDK{}), o11yhttp.WithCanonicalLine()},
		"WithFilter nil":     {o11yhttp.WithFilter(nil)},
		"WithIgnorePaths":    {o11yhttp.WithIgnorePaths()},
		"WithSpanNameFormat": {o11yhttp.WithSpanNameFormatter(nil)},
	}
}

func serveOnce(t *testing.T, h http.Handler) {
	t.Helper()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("request panicked: %v", r)
		}
	}()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	if w.Code != http.StatusTeapot {
		t.Errorf("status = %d, want %d", w.Code, http.StatusTeapot)
	}
}

var teapot = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })

func TestNilArgumentsDoNotPanic(t *testing.T) {
	for name, opts := range nilArgOptions() {
		t.Run(name, func(t *testing.T) {
			serveOnce(t, o11yhttp.NewHandler(teapot, "op", opts...))
			serveOnce(t, o11yhttp.NewMiddleware("op", opts...)(teapot))

			srv := httptest.NewServer(teapot)
			defer srv.Close()
			client := &http.Client{Transport: o11yhttp.NewTransport(nil, opts...)}
			resp, err := client.Get(srv.URL)
			if err != nil {
				t.Fatalf("Get through NewTransport(nil): %v", err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusTeapot {
				t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusTeapot)
			}
		})
	}
}
