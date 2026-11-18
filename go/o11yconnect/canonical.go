package o11yconnect

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/spec"
)

// WithCanonicalLine makes [ServerInterceptor] emit one wide event (a
// canonical log line) per RPC: the o11y.request.summary event. It carries
// the HTTP method and response status the registered event requires, the
// outcome and duration, rpc.system.name, rpc.method and
// rpc.response.status_code, and anything the handler accumulates on the
// RPC's o11y.Record (see o11y.RecordFromContext). The event fires when the
// handler panics, too. RPCs excluded by [WithIgnoreHealthChecks] emit no
// summary. It requires an SDK bound with [WithSDK] and affects
// ServerInterceptor only.
//
// http.response.status_code is the status the server sends: for a unary
// RPC in the Connect protocol, the status the protocol maps the error code
// to (404 for not_found, and so on); for streaming RPCs and for the gRPC
// and gRPC-Web protocols, which carry errors in the body or trailers, 200.
// A panic reports 500. The outcome is failure for a panic and for the
// codes that mean the server failed (unknown, deadline_exceeded,
// unimplemented, internal, unavailable, data_loss), which are the codes
// that mark the server span as an error.
//
// A not-modified error (connect.NewNotModifiedError) reports 304 and OK on
// a GET, the one request connect-go answers with 304. On any other request
// connect-go sends it as an unknown error, and the line reports it as one,
// although otelconnect still records the span as OK.
//
// Behind HTTP instrumentation that has its own canonical line, such as
// o11yhttp.WithCanonicalLine, turn the line on in one layer only: each
// layer emits its own summary for the request, and attributes the handler
// sets reach only the innermost one.
func WithCanonicalLine() Option {
	return func(c *config) { c.canonicalLine = true }
}

// summary is what the canonical line reports about one finished RPC.
type summary struct {
	spec     connect.Spec
	protocol string
	method   string
	unary    bool
	start    time.Time
	err      error
	panicked bool
}

// emit flushes record as the o11y.request.summary event through sdk.
func emit(ctx context.Context, sdk *o11y.SDK, record *o11y.Record, s summary) {
	status, rpcStatus, outcome := http.StatusOK, "OK", spec.OutcomeSuccess
	switch {
	case s.panicked:
		status, rpcStatus, outcome = http.StatusInternalServerError, "INTERNAL", spec.OutcomeFailure
	case s.err == nil:
	case connect.IsNotModifiedError(s.err) && s.method == http.MethodGet:
		status = http.StatusNotModified // only a Connect unary RPC can be a GET
	default:
		code := connect.CodeOf(s.err)
		rpcStatus = strings.ToUpper(code.String()) // gRPC's canonical spelling, as otelconnect reports it
		if s.unary && s.protocol == connect.ProtocolConnect {
			status = httpStatus(code)
		}
		if serverFault(code) {
			outcome = spec.OutcomeFailure
		}
	}
	record.EmitEvent(ctx, sdk, spec.EventRequestSummary,
		slog.String("http.request.method", s.method),
		slog.Int("http.response.status_code", status),
		slog.String(string(spec.OutcomeKey), string(outcome)),
		slog.Float64(string(spec.DurationKey), time.Since(s.start).Seconds()),
		slog.String("rpc.system.name", rpcSystem(s.protocol)),
		slog.String("rpc.method", strings.TrimPrefix(s.spec.Procedure, "/")),
		slog.String("rpc.response.status_code", rpcStatus),
	)
}

// rpcSystem names the rpc.system.name value for a wire protocol, as
// otelconnect does.
func rpcSystem(protocol string) string {
	switch protocol {
	case connect.ProtocolGRPC, connect.ProtocolGRPCWeb:
		return "grpc"
	case connect.ProtocolConnect:
		return "connectrpc"
	default:
		return protocol
	}
}

// serverFault reports whether code means the server failed, the codes for
// which otelconnect marks a server span as an error.
func serverFault(code connect.Code) bool {
	switch code {
	case connect.CodeUnknown, connect.CodeDeadlineExceeded, connect.CodeUnimplemented,
		connect.CodeInternal, connect.CodeUnavailable, connect.CodeDataLoss:
		return true
	default:
		return false
	}
}

// httpStatus is the HTTP status the Connect protocol sends for a unary RPC
// that failed with code (connectCodeToHTTP in connect-go v1.21.1, from the
// Connect protocol specification's error code table).
func httpStatus(code connect.Code) int {
	switch code {
	case connect.CodeCanceled:
		return 499
	case connect.CodeInvalidArgument, connect.CodeFailedPrecondition, connect.CodeOutOfRange:
		return http.StatusBadRequest
	case connect.CodeDeadlineExceeded:
		return http.StatusGatewayTimeout
	case connect.CodeNotFound:
		return http.StatusNotFound
	case connect.CodeAlreadyExists, connect.CodeAborted:
		return http.StatusConflict
	case connect.CodePermissionDenied:
		return http.StatusForbidden
	case connect.CodeResourceExhausted:
		return http.StatusTooManyRequests
	case connect.CodeUnimplemented:
		return http.StatusNotImplemented
	case connect.CodeUnavailable:
		return http.StatusServiceUnavailable
	case connect.CodeUnauthenticated:
		return http.StatusUnauthorized
	default: // unknown, internal, data_loss, and any code added later
		return http.StatusInternalServerError
	}
}
