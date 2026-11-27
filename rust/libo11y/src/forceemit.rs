//! Context marker for records that must bypass every log level gate.
//!
//! Marking a context with [`force_emit_context`] (or running inside
//! [`with_force_emit`]) bypasses level filtering on the log pipeline and on
//! every sink leg. Attribute replacement, sensitivity classification, and trace
//! correlation still apply unchanged, so a forced record is still protected.

use opentelemetry::Context;

/// Private marker stored on an [`opentelemetry::Context`] to request
/// force-emission. Unexported so only libo11y's helpers can attach it.
#[derive(Debug, Clone, Copy)]
struct ForceEmitMark;

/// Returns a copy of `cx` marked so log records emitted under it bypass every
/// level gate.
///
/// Use this for records that must always be emitted, such as audit events or
/// security notifications. Attribute replacement, sensitivity classification,
/// and trace correlation still apply.
#[must_use]
pub fn force_emit_context(cx: &Context) -> Context {
    cx.with_value(ForceEmitMark)
}

/// Reports whether `cx` carries the force-emit marker from
/// [`force_emit_context`].
#[must_use]
pub fn is_force_emit(cx: &Context) -> bool {
    cx.get::<ForceEmitMark>().is_some()
}

/// Runs `f` with the current [`opentelemetry::Context`] marked for force-emit,
/// bypassing level gating for any log record emitted synchronously inside `f`.
pub fn with_force_emit<R>(f: impl FnOnce() -> R) -> R {
    let _guard = force_emit_context(&Context::current()).attach();
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_marker_sets_and_detects_force_emit() {
        let base = Context::new();
        assert!(!is_force_emit(&base));
        let forced = force_emit_context(&base);
        assert!(is_force_emit(&forced));
        assert!(!is_force_emit(&base), "original context is unchanged");
    }

    #[test]
    fn with_force_emit_marks_only_its_scope() {
        assert!(!is_force_emit(&Context::current()));
        let seen = with_force_emit(|| is_force_emit(&Context::current()));
        assert!(seen);
        assert!(!is_force_emit(&Context::current()));
    }
}
