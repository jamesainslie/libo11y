//! Classifies a failed call's transport or body error into a Connect
//! [`ErrorCode`] without taking ownership of the error.

use std::any::Any;
use std::error::Error;
use std::fmt;
use std::io;

use connectrpc::{ConnectError, ErrorCode};

/// Returns the code a transport or body error `err` stands for.
///
/// A [`ConnectError`] keeps its own code wherever it sits in the source
/// chain. An I/O failure to reach or keep the peer reads `Unavailable`, a
/// timed-out operation `DeadlineExceeded` and an interrupted one
/// `Canceled`. A boxed error is looked through. Any other error reads
/// `Unavailable`, the code a transport failure carries when nothing names
/// a better one.
pub(crate) fn code_from_error<E: fmt::Display + 'static>(err: &E) -> ErrorCode {
    erase(err)
        .and_then(code_in_chain)
        .unwrap_or(ErrorCode::Unavailable)
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
    if let Some(e) = any.downcast_ref::<ConnectError>() {
        return Some(e);
    }
    if let Some(e) = any.downcast_ref::<io::Error>() {
        return Some(e);
    }
    None
}

fn code_in_chain(err: &(dyn Error + 'static)) -> Option<ErrorCode> {
    let mut link = Some(err);
    while let Some(e) = link {
        if let Some(connect) = e.downcast_ref::<ConnectError>() {
            return Some(connect.code);
        }
        if let Some(code) = e
            .downcast_ref::<io::Error>()
            .and_then(|io| code_from_io(io.kind()))
        {
            return Some(code);
        }
        link = e.source();
    }
    None
}

const fn code_from_io(kind: io::ErrorKind) -> Option<ErrorCode> {
    match kind {
        io::ErrorKind::ConnectionRefused
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected
        | io::ErrorKind::AddrNotAvailable
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::HostUnreachable
        | io::ErrorKind::NetworkUnreachable
        | io::ErrorKind::UnexpectedEof => Some(ErrorCode::Unavailable),
        io::ErrorKind::TimedOut => Some(ErrorCode::DeadlineExceeded),
        io::ErrorKind::Interrupted => Some(ErrorCode::Canceled),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn connect_errors_keep_their_code() {
        let err = ConnectError::new(ErrorCode::PermissionDenied, "no");
        assert_eq!(code_from_error(&err), ErrorCode::PermissionDenied);
        let boxed: BoxError = Box::new(ConnectError::new(ErrorCode::ResourceExhausted, "full"));
        assert_eq!(code_from_error(&boxed), ErrorCode::ResourceExhausted);
        let nested: BoxError = Box::new(Wrapper(Box::new(ConnectError::new(
            ErrorCode::DeadlineExceeded,
            "late",
        ))));
        assert_eq!(code_from_error(&nested), ErrorCode::DeadlineExceeded);
    }

    #[test]
    fn io_errors_map_by_kind() {
        for (kind, want) in [
            (io::ErrorKind::ConnectionRefused, ErrorCode::Unavailable),
            (io::ErrorKind::ConnectionReset, ErrorCode::Unavailable),
            (io::ErrorKind::TimedOut, ErrorCode::DeadlineExceeded),
            (io::ErrorKind::Interrupted, ErrorCode::Canceled),
            (io::ErrorKind::Other, ErrorCode::Unavailable),
        ] {
            assert_eq!(
                code_from_error(&io::Error::new(kind, "x")),
                want,
                "{kind:?}"
            );
        }
        let boxed: BoxError = Box::new(Wrapper(Box::new(io::Error::new(
            io::ErrorKind::TimedOut,
            "slow",
        ))));
        assert_eq!(code_from_error(&boxed), ErrorCode::DeadlineExceeded);
    }

    #[test]
    fn unrecognized_errors_read_unavailable() {
        assert_eq!(code_from_error(&"text".to_owned()), ErrorCode::Unavailable);
        let boxed: BoxError = "opaque".into();
        assert_eq!(code_from_error(&boxed), ErrorCode::Unavailable);
    }
}
