package o11yhttp_test

import (
	"bufio"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/spec"
)

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
			srv := quietServer(o11yhttp.NewHandler(tc.handler, "status",
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
