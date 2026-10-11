package o11yhttp

import (
	"bufio"
	"io"
	"net"
	"net/http"

	"github.com/felixge/httpsnoop"
)

// statusTracker records the response status the client actually receives.
// It is written only from the goroutine serving the request.
type statusTracker struct {
	status   int // first committed final status; 0 until committed
	hijacked bool
}

func (s *statusTracker) observeHeader(code int) {
	if s.status == 0 && !s.hijacked {
		s.status = code
	}
}

func (s *statusTracker) observeWrite() {
	if s.status == 0 && !s.hijacked {
		s.status = http.StatusOK
	}
}

func (s *statusTracker) observeHijack() { s.hijacked = true }

// final returns the committed status, defaulting to 200 when the handler
// never wrote (net/http sends 200 in that case).
func (s *statusTracker) final() int {
	if s.status == 0 {
		return http.StatusOK
	}
	return s.status
}

// trackResponse wraps w so the status is observed while every optional
// interface the underlying writer supports (Flusher, Hijacker, ReaderFrom,
// Pusher) stays visible to type assertions, and nothing unsupported is
// advertised. httpsnoop also exposes Unwrap for http.ResponseController.
func trackResponse(w http.ResponseWriter) (http.ResponseWriter, *statusTracker) {
	st := &statusTracker{}
	wrapped := httpsnoop.Wrap(w, httpsnoop.Hooks{
		WriteHeader: func(next httpsnoop.WriteHeaderFunc) httpsnoop.WriteHeaderFunc {
			return func(code int) { st.observeHeader(code); next(code) }
		},
		Write: func(next httpsnoop.WriteFunc) httpsnoop.WriteFunc {
			return func(b []byte) (int, error) { st.observeWrite(); return next(b) }
		},
		ReadFrom: func(next httpsnoop.ReadFromFunc) httpsnoop.ReadFromFunc {
			return func(src io.Reader) (int64, error) { st.observeWrite(); return next(src) }
		},
		Flush: func(next httpsnoop.FlushFunc) httpsnoop.FlushFunc {
			return func() { st.observeWrite(); next() }
		},
		Hijack: func(next httpsnoop.HijackFunc) httpsnoop.HijackFunc {
			return func() (net.Conn, *bufio.ReadWriter, error) { st.observeHijack(); return next() }
		},
	})
	return wrapped, st
}
