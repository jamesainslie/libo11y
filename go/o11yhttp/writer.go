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

// observeHeader records the first final status. net/http sends 1xx
// informational headers immediately and still accepts a final status
// afterwards, except 101 Switching Protocols, which is final.
func (s *statusTracker) observeHeader(code int) {
	if s.status != 0 || s.hijacked {
		return // already committed: net/http ignores superfluous WriteHeader
	}
	if code >= 100 && code < 200 && code != http.StatusSwitchingProtocols {
		return
	}
	s.status = code
}

// committed reports whether a final status reached the client.
func (s *statusTracker) committed() bool { return s.status != 0 }

func (s *statusTracker) observeWrite() {
	if s.status == 0 && !s.hijacked {
		s.status = http.StatusOK
	}
}

func (s *statusTracker) observeHijack() { s.hijacked = true }

// final returns the committed status, defaulting to 200 when the handler
// never wrote (net/http sends 200 in that case).
func (s *statusTracker) final() int {
	if s.hijacked && s.status == 0 {
		// A hijacking handler has taken over the protocol; net/http never
		// sends a status of its own on a hijacked connection.
		return http.StatusSwitchingProtocols
	}
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
		// WriteHeader and Hijack call through first and observe only what
		// took effect: net/http panics inside WriteHeader on an invalid
		// code, and a failed Hijack leaves the connection with net/http.
		WriteHeader: func(next httpsnoop.WriteHeaderFunc) httpsnoop.WriteHeaderFunc {
			return func(code int) { next(code); st.observeHeader(code) }
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
			return func() (net.Conn, *bufio.ReadWriter, error) {
				conn, rw, err := next()
				if err == nil {
					st.observeHijack()
				}
				return conn, rw, err
			}
		},
	})
	return wrapped, st
}
