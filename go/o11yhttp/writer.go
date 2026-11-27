package o11yhttp

import (
	"bufio"
	"io"
	"net"
	"net/http"

	"github.com/felixge/httpsnoop"

	"github.com/jamesainslie/libo11y/go/internal/servertiming"
)

// statusTracker records the final response status the handler committed.
// That is the status net/http sends, though a failed connection can still
// keep it from reaching the client. It inherits the ResponseWriter
// contract: no concurrent use, no use after ServeHTTP returns.
type statusTracker struct {
	status   int // first final status the handler committed; 0 until then
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

// committed reports whether the handler has committed a final status or
// taken over the connection with a successful Hijack. Either way net/http
// can no longer send a status of its own, so a later panic must not be
// reported as 500.
func (s *statusTracker) committed() bool { return s.status != 0 || s.hijacked }

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
			// net/http commits a status from ReadFrom only once bytes are
			// written, so an empty source must not be observed as a write.
			return func(src io.Reader) (int64, error) {
				n, err := next(src)
				if n > 0 {
					st.observeWrite()
				}
				return n, err
			}
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

// timingResponse wraps w so that entry is added to the Server-Timing header
// when the handler commits the headers of an HTML response. The decision is
// made once, at the first WriteHeader with a final status, Write, Flush or
// ReadFrom that copies bytes, because net/http ignores header changes after
// that. A 1xx informational WriteHeader (other than 101) does not decide:
// net/http still accepts a final status and its headers afterwards. As with
// trackResponse, httpsnoop keeps the optional interfaces and Unwrap visible,
// so a Flush through http.ResponseController passes through the hook. It
// inherits the ResponseWriter contract: no concurrent use.
func timingResponse(w http.ResponseWriter, entry string) http.ResponseWriter {
	decided := false
	decide := func(body []byte, sniff bool) {
		if decided {
			return
		}
		decided = true
		if h := w.Header(); servertiming.HTMLResponse(h, body, sniff) {
			h.Add(servertiming.Header, entry)
		}
	}
	// sniffWriter writes through w after deciding on the bytes, as the
	// first Write of a body does.
	sniffWriter := writerFunc(func(b []byte) (int, error) { decide(b, true); return w.Write(b) })
	return httpsnoop.Wrap(w, httpsnoop.Hooks{
		WriteHeader: func(next httpsnoop.WriteHeaderFunc) httpsnoop.WriteHeaderFunc {
			return func(code int) {
				if code >= 200 || code == http.StatusSwitchingProtocols {
					decide(nil, false)
				}
				next(code)
			}
		},
		Write: func(next httpsnoop.WriteFunc) httpsnoop.WriteFunc {
			return func(b []byte) (int, error) { decide(b, true); return next(b) }
		},
		ReadFrom: func(next httpsnoop.ReadFromFunc) httpsnoop.ReadFromFunc {
			// net/http's ReadFrom copies the first sniff-length bytes with
			// Write before handing the rest to the connection, so an empty
			// source commits nothing and the copied bytes are sniffed. Do the
			// same, so the decision sees what net/http sees.
			return func(src io.Reader) (int64, error) {
				if decided {
					return next(src)
				}
				buf := make([]byte, servertiming.SniffLen)
				n, err := io.CopyBuffer(sniffWriter, io.LimitReader(src, servertiming.SniffLen), buf)
				if err != nil || n < servertiming.SniffLen {
					return n, err
				}
				rest, err := next(src)
				return n + rest, err
			}
		},
		Flush: func(next httpsnoop.FlushFunc) httpsnoop.FlushFunc {
			return func() { decide(nil, false); next() }
		},
	})
}

// writerFunc adapts a function to io.Writer. It deliberately has no
// ReadFrom, so io.CopyBuffer writes through it.
type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(b []byte) (int, error) { return f(b) }
