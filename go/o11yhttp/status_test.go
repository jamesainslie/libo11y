package o11yhttp_test

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/spec"
)

// trackedServer starts a quiet server for h and returns a wait function that
// blocks until one request has finished in the handler. The client can see
// the response (headers, a flush, a closed connection) before the handler
// returns and emits its summary, so tests wait before reading summaries.
func trackedServer(t *testing.T, h http.Handler) (*httptest.Server, func()) {
	t.Helper()
	done := make(chan struct{}, 8)
	srv := quietServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() { done <- struct{}{} }() // runs after the summary, even while panicking
		h.ServeHTTP(w, r)
	}))
	wait := func() {
		t.Helper()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("handler did not finish")
		}
	}
	return srv, wait
}

func TestCanonicalSummaryReportsCommittedStatus(t *testing.T) {
	cases := []struct {
		name        string
		handler     http.HandlerFunc
		panics      bool
		wantStatus  int64
		wantOutcome spec.Outcome
	}{
		{"implicit 200", func(http.ResponseWriter, *http.Request) {}, false, 200, spec.OutcomeSuccess},
		{"201 then 500", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201); w.WriteHeader(500) }, false, 201, spec.OutcomeSuccess},
		{"write then 500", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("x")); w.WriteHeader(500) }, false, 200, spec.OutcomeSuccess},
		{"103 then 204", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(103); w.WriteHeader(204) }, false, 204, spec.OutcomeSuccess},
		{"flush then 500", func(w http.ResponseWriter, _ *http.Request) {
			_ = http.NewResponseController(w).Flush()
			w.WriteHeader(500)
		}, false, 200, spec.OutcomeSuccess},
		{"500", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }, false, 500, spec.OutcomeFailure},
		// net/http commits a status from ReadFrom only once bytes are written.
		// The struct hides strings.Reader's WriteTo, so io.Copy reaches the
		// writer's ReadFrom instead of returning early on the empty source.
		{"empty readfrom then 500", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.Copy(w, struct{ io.Reader }{strings.NewReader("")})
			w.WriteHeader(500)
		}, false, 500, spec.OutcomeFailure},
		{"readfrom then 500", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.Copy(w, struct{ io.Reader }{strings.NewReader("x")})
			w.WriteHeader(500)
		}, false, 200, spec.OutcomeSuccess},
		{"panic before write", func(http.ResponseWriter, *http.Request) { panic("boom") }, true, 500, spec.OutcomeFailure},
		{"panic after 201", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201); panic("boom") }, true, 201, spec.OutcomeFailure},
		// net/http panics inside WriteHeader on an invalid code, so the code
		// never reaches the client and must not be recorded as committed.
		{"invalid code panics", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(50) }, true, 500, spec.OutcomeFailure},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := newCanonicalEnv(t)
			srv, wait := trackedServer(t, o11yhttp.NewHandler(tc.handler, "status",
				o11yhttp.WithSDK(env.sdk), o11yhttp.WithCanonicalLine()))
			defer srv.Close()

			resp, err := srv.Client().Get(srv.URL)
			if !tc.panics {
				if err != nil {
					t.Fatalf("GET: %v", err)
				}
				_ = resp.Body.Close()
				if int64(resp.StatusCode) != tc.wantStatus {
					t.Fatalf("client received %d, test expects %d", resp.StatusCode, tc.wantStatus)
				}
			} else if err == nil {
				_ = resp.Body.Close()
			}
			wait()

			s := env.summaries()
			if len(s) != 1 {
				t.Fatalf("got %d summaries, want 1", len(s))
			}
			if got := s[0]["http.response.status_code"]; got != tc.wantStatus {
				t.Errorf("summary status = %v, want %d", got, tc.wantStatus)
			}
			if got := s[0][string(spec.OutcomeKey)]; got != string(tc.wantOutcome) {
				t.Errorf("summary outcome = %v, want %s", got, tc.wantOutcome)
			}
		})
	}
}

func TestCanonicalSummaryAfterHijack(t *testing.T) {
	for _, panics := range []bool{false, true} {
		t.Run(fmt.Sprintf("panics=%v", panics), func(t *testing.T) {
			t.Parallel()
			env := newCanonicalEnv(t)
			h := o11yhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				conn, buf, err := http.NewResponseController(w).Hijack()
				if err != nil {
					t.Errorf("Hijack: %v", err)
					return
				}
				_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
				_ = buf.Flush()
				_ = conn.Close()
				if panics {
					panic("boom")
				}
			}), "hijack", o11yhttp.WithSDK(env.sdk), o11yhttp.WithCanonicalLine())
			srv, wait := trackedServer(t, h)
			defer srv.Close()

			conn, err := net.Dial("tcp", srv.Listener.Addr().String())
			if err != nil {
				t.Fatalf("Dial: %v", err)
			}
			defer func() { _ = conn.Close() }()
			if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: test\r\n\r\n"); err != nil {
				t.Fatalf("write request: %v", err)
			}
			line, err := bufio.NewReader(conn).ReadString('\n')
			if err != nil || !strings.HasPrefix(line, "HTTP/1.1 101 ") {
				t.Fatalf("status line = %q, %v; want HTTP/1.1 101", line, err)
			}
			wait()

			s := env.summaries()
			if len(s) != 1 {
				t.Fatalf("got %d summaries, want 1", len(s))
			}
			if got := s[0]["http.response.status_code"]; got != int64(http.StatusSwitchingProtocols) {
				t.Errorf("summary status = %v, want 101", got)
			}
			want := spec.OutcomeSuccess
			if panics {
				want = spec.OutcomeFailure
			}
			if got := s[0][string(spec.OutcomeKey)]; got != string(want) {
				t.Errorf("summary outcome = %v, want %s", got, want)
			}
		})
	}
}

// refusingHijacker advertises http.Hijacker but always fails to hijack.
type refusingHijacker struct{ plainWriter }

func (*refusingHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, errors.New("hijack refused")
}

func TestFailedHijackDoesNotMarkHijacked(t *testing.T) {
	t.Parallel()
	env := newCanonicalEnv(t)
	h := o11yhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, _, err := http.NewResponseController(w).Hijack(); err == nil {
			t.Error("Hijack succeeded, want an error")
		}
	}), "hijack", o11yhttp.WithSDK(env.sdk), o11yhttp.WithCanonicalLine())
	h.ServeHTTP(&refusingHijacker{}, httptest.NewRequest(http.MethodGet, "/", nil))

	s := env.summaries()
	if len(s) != 1 {
		t.Fatalf("got %d summaries, want 1", len(s))
	}
	if got := s[0]["http.response.status_code"]; got != int64(http.StatusOK) {
		t.Errorf("summary status = %v, want 200 (a failed Hijack takes nothing over)", got)
	}
}
