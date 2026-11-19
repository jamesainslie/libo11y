package o11yconnect

import (
	"testing"

	"connectrpc.com/connect"
)

func TestHTTPStatusMatchesTheConnectProtocol(t *testing.T) {
	for code, want := range map[connect.Code]int{
		connect.CodeCanceled: 499, connect.CodeUnknown: 500, connect.CodeInvalidArgument: 400,
		connect.CodeDeadlineExceeded: 504, connect.CodeNotFound: 404, connect.CodeAlreadyExists: 409,
		connect.CodePermissionDenied: 403, connect.CodeResourceExhausted: 429,
		connect.CodeFailedPrecondition: 400, connect.CodeAborted: 409, connect.CodeOutOfRange: 400,
		connect.CodeUnimplemented: 501, connect.CodeInternal: 500, connect.CodeUnavailable: 503,
		connect.CodeDataLoss: 500, connect.CodeUnauthenticated: 401, connect.Code(99): 500,
	} {
		if got := httpStatus(code); got != want {
			t.Errorf("httpStatus(%v) = %d, want %d", code, got, want)
		}
	}
}

func TestRPCSystem(t *testing.T) {
	for protocol, want := range map[string]string{
		connect.ProtocolConnect: "connectrpc", connect.ProtocolGRPC: "grpc", connect.ProtocolGRPCWeb: "grpc",
	} {
		if got := rpcSystem(protocol); got != want {
			t.Errorf("rpcSystem(%q) = %q, want %q", protocol, got, want)
		}
	}
}

func TestServerFault(t *testing.T) {
	faults := map[connect.Code]bool{
		connect.CodeUnknown: true, connect.CodeDeadlineExceeded: true, connect.CodeUnimplemented: true,
		connect.CodeInternal: true, connect.CodeUnavailable: true, connect.CodeDataLoss: true,
	}
	for code := connect.CodeCanceled; code <= connect.CodeUnauthenticated; code++ {
		if got := serverFault(code); got != faults[code] {
			t.Errorf("serverFault(%v) = %v, want %v", code, got, faults[code])
		}
	}
}
