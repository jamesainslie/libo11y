//! Classifies a failed call's error into a gRPC status code, as
//! `tonic::Status::from_error` does, without taking ownership of the error.

use std::any::Any;
use std::error::Error;
use std::fmt;
use std::io;

use crate::semconv::{
    CODE_CANCELLED, CODE_DEADLINE_EXCEEDED, CODE_INTERNAL, CODE_PERMISSION_DENIED,
    CODE_RESOURCE_EXHAUSTED, CODE_UNAVAILABLE, CODE_UNKNOWN, GrpcStatus,
};

/// Returns the gRPC status a transport or body error `err` stands for.
///
/// The error is matched against the types tonic's own client maps, walking
/// its source chain: a [`tonic::Status`] keeps its code, a connect failure
/// reads `UNAVAILABLE`, an expired tonic timeout or a canceled stream reads
/// `CANCELLED`, a timed-out I/O operation reads `DEADLINE_EXCEEDED`, and an
/// HTTP/2 reset maps by its reason as gRPC's HTTP/2 transport specifies. A boxed error, an I/O error and
/// [`tonic::transport::Error`] are looked through. Anything else reads
/// `UNKNOWN` with the error's text as the message.
pub(crate) fn status_from_error<E: fmt::Display + 'static>(err: &E) -> GrpcStatus {
    erase(err)
        .and_then(status_in_chain)
        .unwrap_or_else(|| GrpcStatus::with_message(CODE_UNKNOWN, err.to_string()))
}

/// Views `err` as a `dyn Error` when its type is one a call can fail with.
/// The layers bound their error types by `Display` only, so a boxed error
/// cannot be reached through an `Error` bound.
fn erase<E: 'static>(err: &E) -> Option<&(dyn Error + 'static)> {
    let any: &dyn Any = err;
    if let Some(boxed) = any.downcast_ref::<Box<dyn Error + Send + Sync>>() {
        return Some(&**boxed);
    }
    if let Some(boxed) = any.downcast_ref::<Box<dyn Error + Send>>() {
        return Some(&**boxed);
    }
    if let Some(boxed) = any.downcast_ref::<Box<dyn Error>>() {
        return Some(&**boxed);
    }
    macro_rules! concrete {
        ($($ty:ty),* $(,)?) => {
            $(if let Some(e) = any.downcast_ref::<$ty>() {
                return Some(e);
            })*
        };
    }
    concrete!(
        tonic::Status,
        tonic::transport::Error,
        tonic::ConnectError,
        tonic::TimeoutExpired,
        hyper::Error,
        h2::Error,
        io::Error,
    );
    None
}

/// Walks `err` and its sources, returning the status of the first link
/// that names one.
fn status_in_chain(err: &(dyn Error + 'static)) -> Option<GrpcStatus> {
    let mut link = Some(err);
    while let Some(e) = link {
        if let Some(status) = status_of(e) {
            return Some(status);
        }
        link = e.source();
    }
    None
}

fn status_of(err: &(dyn Error + 'static)) -> Option<GrpcStatus> {
    if let Some(status) = err.downcast_ref::<tonic::Status>() {
        let message = (!status.message().is_empty()).then(|| status.message().to_owned());
        return Some(GrpcStatus {
            code: status.code().into(),
            message,
        });
    }
    let code = if err.is::<tonic::TimeoutExpired>() {
        CODE_CANCELLED
    } else if err.is::<tonic::ConnectError>() {
        CODE_UNAVAILABLE
    } else if let Some(h) = err.downcast_ref::<hyper::Error>() {
        // As tonic: an expired keep-alive ping closes calls `UNAVAILABLE`.
        if h.is_timeout() {
            CODE_UNAVAILABLE
        } else if h.is_canceled() {
            CODE_CANCELLED
        } else {
            return None;
        }
    } else if let Some(h2) = err.downcast_ref::<h2::Error>() {
        code_from_h2(h2.reason()?)
    } else if let Some(io) = err.downcast_ref::<io::Error>() {
        code_from_io(io.kind())?
    } else {
        return None;
    };
    Some(GrpcStatus::with_message(code, err.to_string()))
}

/// Maps an HTTP/2 reset reason per gRPC's `PROTOCOL-HTTP2.md`.
fn code_from_h2(reason: h2::Reason) -> i32 {
    match reason {
        h2::Reason::NO_ERROR
        | h2::Reason::PROTOCOL_ERROR
        | h2::Reason::INTERNAL_ERROR
        | h2::Reason::FLOW_CONTROL_ERROR
        | h2::Reason::SETTINGS_TIMEOUT
        | h2::Reason::FRAME_SIZE_ERROR
        | h2::Reason::COMPRESSION_ERROR
        | h2::Reason::CONNECT_ERROR => CODE_INTERNAL,
        h2::Reason::REFUSED_STREAM => CODE_UNAVAILABLE,
        h2::Reason::CANCEL => CODE_CANCELLED,
        h2::Reason::ENHANCE_YOUR_CALM => CODE_RESOURCE_EXHAUSTED,
        h2::Reason::INADEQUATE_SECURITY => CODE_PERMISSION_DENIED,
        _ => CODE_UNKNOWN,
    }
}

/// Maps an I/O failure to reach or keep the peer to `UNAVAILABLE`, a
/// timed-out operation to `DEADLINE_EXCEEDED` and an interrupted one to
/// `CANCELLED`.
const fn code_from_io(kind: io::ErrorKind) -> Option<i32> {
    match kind {
        io::ErrorKind::ConnectionRefused
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected
        | io::ErrorKind::AddrNotAvailable
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::HostUnreachable
        | io::ErrorKind::NetworkUnreachable
        | io::ErrorKind::UnexpectedEof => Some(CODE_UNAVAILABLE),
        io::ErrorKind::TimedOut => Some(CODE_DEADLINE_EXCEEDED),
        io::ErrorKind::Interrupted => Some(CODE_CANCELLED),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use tonic::Code;

    use super::*;
    use crate::semconv::{CODE_NOT_FOUND, CODE_OK};

    type BoxError = Box<dyn Error + Send + Sync>;

    #[derive(Debug)]
    struct Wrapper(BoxError);

    impl fmt::Display for Wrapper {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("wrapped")
        }
    }

    impl Error for Wrapper {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&*self.0)
        }
    }

    fn code<E: fmt::Display + 'static>(err: &E) -> i32 {
        status_from_error(err).code
    }

    #[test]
    fn statuses_keep_their_code_and_message() {
        let status = tonic::Status::not_found("no such cart");
        let got = status_from_error(&status);
        assert_eq!(got.code, CODE_NOT_FOUND);
        assert_eq!(got.message.as_deref(), Some("no such cart"));
        let boxed: BoxError = Box::new(tonic::Status::new(Code::Ok, ""));
        assert_eq!(code(&boxed), CODE_OK);
        let nested: BoxError = Box::new(Wrapper(Box::new(tonic::Status::unavailable("x"))));
        assert_eq!(code(&nested), CODE_UNAVAILABLE);
    }

    #[test]
    fn refused_connections_read_unavailable() {
        let refused = io::Error::new(io::ErrorKind::ConnectionRefused, "refused");
        assert_eq!(code(&refused), CODE_UNAVAILABLE);
        let connect = tonic::ConnectError(Box::new(io::Error::other("dns")));
        assert_eq!(code(&connect), CODE_UNAVAILABLE);
        let boxed: BoxError = Box::new(Wrapper(Box::new(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "reset",
        ))));
        assert_eq!(code(&boxed), CODE_UNAVAILABLE);
    }

    #[test]
    fn timeouts_and_cancels_read_cancelled() {
        assert_eq!(code(&tonic::TimeoutExpired(())), CODE_CANCELLED);
        let interrupted = io::Error::new(io::ErrorKind::Interrupted, "stop");
        assert_eq!(code(&interrupted), CODE_CANCELLED);
        let timed_out = io::Error::new(io::ErrorKind::TimedOut, "slow");
        assert_eq!(code(&timed_out), CODE_DEADLINE_EXCEEDED);
        let reset = h2::Error::from(h2::Reason::CANCEL);
        assert_eq!(code(&reset), CODE_CANCELLED);
        let boxed: BoxError = Box::new(tonic::TimeoutExpired(()));
        assert_eq!(code(&boxed), CODE_CANCELLED);
    }

    #[test]
    fn h2_resets_map_by_reason() {
        for (reason, want) in [
            (h2::Reason::REFUSED_STREAM, CODE_UNAVAILABLE),
            (h2::Reason::PROTOCOL_ERROR, CODE_INTERNAL),
            (h2::Reason::ENHANCE_YOUR_CALM, CODE_RESOURCE_EXHAUSTED),
            (h2::Reason::INADEQUATE_SECURITY, CODE_PERMISSION_DENIED),
            (h2::Reason::HTTP_1_1_REQUIRED, CODE_UNKNOWN),
        ] {
            assert_eq!(code(&h2::Error::from(reason)), want, "{reason:?}");
        }
    }

    #[test]
    fn unrecognized_errors_read_unknown_with_their_text() {
        let got = status_from_error(&"plain text error".to_owned());
        assert_eq!(got.code, CODE_UNKNOWN);
        assert_eq!(got.message.as_deref(), Some("plain text error"));
        let other = io::Error::other("disk");
        assert_eq!(code(&other), CODE_UNKNOWN);
        let boxed: BoxError = "opaque".into();
        assert_eq!(code(&boxed), CODE_UNKNOWN);
    }
}
