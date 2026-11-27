//! Trace context propagation across process boundaries and framed protocols.
//!
//! # Child process environment
//!
//! A parent passes its active trace context to a child process via
//! [`inject_command`] (or [`env()`]):
//!
//! ```no_run
//! use std::process::Command;
//! use opentelemetry::Context;
//!
//! let mut cmd = Command::new("worker");
//! libo11y::proc::inject_command(&Context::current(), &mut cmd);
//! ```
//!
//! and the child adopts it once its telemetry is set up:
//!
//! ```
//! use opentelemetry::Context;
//!
//! let cx = libo11y::proc::from_env(&Context::new());
//! ```
//!
//! The variables are [`ENV_TRACEPARENT`] (`TRACEPARENT`) and
//! [`ENV_TRACESTATE`] (`TRACESTATE`), the names the OpenTelemetry
//! specification defines for environment carriers. Baggage does not travel
//! through the environment: other tools on the host can read a process's
//! environment, and baggage is not classified by the sensitivity policy.
//!
//! # Framed socket protocols
//!
//! A protocol that sends framed messages carries trace context and
//! egress-filtered baggage in each frame as string fields (`traceparent`,
//! `tracestate`, `baggage`). Pass an explicit [`Sdk`] or [`TextMapPropagator`]
//! via [`inject_with_sdk`] / [`extract_with_sdk`] (or [`inject_with`] /
//! [`extract_with`]), or use [`inject`] / [`extract`] with the process-global
//! propagator installed by [`Builder::setup`](crate::Builder::setup).

use std::collections::HashMap;
use std::process::Command;

use opentelemetry::Context;
use opentelemetry::propagation::{Extractor, Injector, TextMapPropagator};
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry_sdk::propagation::TraceContextPropagator;

use crate::{EnvLookup, Sdk};

/// Environment variable name for W3C `traceparent`.
pub const ENV_TRACEPARENT: &str = "TRACEPARENT";

/// Environment variable name for W3C `tracestate`.
pub const ENV_TRACESTATE: &str = "TRACESTATE";

/// Returns the trace context active in `cx` as `[(TRACEPARENT, ...),
/// (TRACESTATE, ...)]` pairs ready for a child process's environment.
///
/// `TRACESTATE` is empty when `cx` has no tracestate, so applying both entries
/// overrides any stale `TRACESTATE` this process inherited. Returns an empty
/// `Vec` when `cx` holds no valid span context.
///
/// Baggage is intentionally never included in process environment variables.
#[must_use]
pub fn env(cx: &Context) -> Vec<(String, String)> {
    if !cx.span().span_context().is_valid() {
        return Vec::new();
    }
    let mut map = HashMap::with_capacity(2);
    TraceContextPropagator::new().inject_context(cx, &mut map);
    let traceparent = map.remove("traceparent").unwrap_or_default();
    let tracestate = map.remove("tracestate").unwrap_or_default();
    vec![
        (ENV_TRACEPARENT.to_owned(), traceparent),
        (ENV_TRACESTATE.to_owned(), tracestate),
    ]
}

/// Writes `TRACEPARENT` and `TRACESTATE` for the active span context in `cx`
/// into `cmd`'s environment.
///
/// Does nothing when `cx` holds no valid span context. When `cx` holds a valid
/// span with no tracestate, sets `TRACESTATE=""` so any inherited `TRACESTATE`
/// never leaks alongside the new `TRACEPARENT`.
pub fn inject_command(cx: &Context, cmd: &mut Command) {
    for (key, value) in env(cx) {
        cmd.env(key, value);
    }
}

/// Returns `cx` with the remote span context read from the current process's
/// `TRACEPARENT` and `TRACESTATE` environment variables.
///
/// Returns `cx` unchanged when `TRACEPARENT` is unset, empty, or invalid.
#[must_use]
pub fn from_env(cx: &Context) -> Context {
    from_env_lookup(cx, &EnvLookup::process())
}

/// Returns `cx` with the remote span context read from `TRACEPARENT` and
/// `TRACESTATE` in `lookup`.
///
/// Returns `cx` unchanged when `TRACEPARENT` is absent, empty, or invalid
/// (never adopting `TRACESTATE` on its own).
#[must_use]
pub fn from_env_lookup(cx: &Context, lookup: &EnvLookup) -> Context {
    let Some(parent) = lookup.get(ENV_TRACEPARENT).filter(|v| !v.is_empty()) else {
        return cx.clone();
    };
    let mut map = HashMap::with_capacity(2);
    map.insert("traceparent".to_owned(), parent);
    if let Some(state) = lookup.get(ENV_TRACESTATE).filter(|v| !v.is_empty()) {
        map.insert("tracestate".to_owned(), state);
    }
    TraceContextPropagator::new().extract_with_context(cx, &map)
}

/// Convenience wrapper over [`from_env_lookup`] that reads `TRACEPARENT` and
/// `TRACESTATE` from an iterator of `(key, value)` pairs.
#[must_use]
pub fn from_env_pairs<I, K, V>(cx: &Context, pairs: I) -> Context
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    from_env_lookup(cx, &EnvLookup::from_pairs(pairs))
}

/// Writes trace context and baggage from `cx` into `frame` using the
/// process-global propagator.
///
/// Before [`Builder::setup`](crate::Builder::setup) installs a global
/// propagator, the OpenTelemetry no-op global propagator writes nothing.
/// With an [`Sdk`] built by [`Builder::build`](crate::Builder::build), prefer
/// [`inject_with_sdk`] or [`inject_with`].
pub fn inject<I: Injector>(cx: &Context, frame: &mut I) {
    opentelemetry::global::get_text_map_propagator(|prop| {
        prop.inject_context(cx, frame);
    });
}

/// Writes trace context and baggage from `cx` into `frame` using `propagator`.
pub fn inject_with<I: Injector>(propagator: &dyn TextMapPropagator, cx: &Context, frame: &mut I) {
    propagator.inject_context(cx, frame);
}

/// Writes trace context and egress-filtered baggage from `cx` into `frame`
/// using `sdk`'s propagator.
pub fn inject_with_sdk<I: Injector>(sdk: &Sdk, cx: &Context, frame: &mut I) {
    sdk.propagator().inject_context(cx, frame);
}

/// Extracts trace context and baggage from `frame` into `cx` using the
/// process-global propagator.
///
/// Before [`Builder::setup`](crate::Builder::setup) installs a global
/// propagator, the OpenTelemetry no-op global propagator returns `cx`
/// unchanged. With an [`Sdk`] built by [`Builder::build`](crate::Builder::build),
/// prefer [`extract_with_sdk`] or [`extract_with`].
#[must_use]
pub fn extract<E: Extractor>(cx: &Context, frame: &E) -> Context {
    opentelemetry::global::get_text_map_propagator(|prop| prop.extract_with_context(cx, frame))
}

/// Extracts trace context and baggage from `frame` into `cx` using
/// `propagator`.
#[must_use]
pub fn extract_with<E: Extractor>(
    propagator: &dyn TextMapPropagator,
    cx: &Context,
    frame: &E,
) -> Context {
    propagator.extract_with_context(cx, frame)
}

/// Extracts trace context and baggage from `frame` into `cx` using `sdk`'s
/// propagator.
#[must_use]
pub fn extract_with_sdk<E: Extractor>(sdk: &Sdk, cx: &Context, frame: &E) -> Context {
    sdk.propagator().extract_with_context(cx, frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::OsStr;
    use std::str::FromStr as _;
    use std::sync::{Arc, Mutex};

    use opentelemetry::baggage::{BaggageExt as _, KeyValueMetadata};
    use opentelemetry::trace::{Span as _, SpanContext, TraceState, Tracer as _};
    use opentelemetry_sdk::error::OTelSdkResult;
    use opentelemetry_sdk::propagation::TraceContextPropagator;
    use opentelemetry_sdk::trace::{Span, SpanData, SpanProcessor};

    use crate::{Environment, Sdk};

    #[derive(Debug, Clone, Default)]
    struct CaptureSpans(Arc<Mutex<Vec<SpanData>>>);

    impl CaptureSpans {
        fn spans(&self) -> Vec<SpanData> {
            self.0.lock().expect("spans").clone()
        }
    }

    impl SpanProcessor for CaptureSpans {
        fn on_start(&self, _: &mut Span, _: &Context) {}
        fn on_end(&self, span: SpanData) {
            self.0.lock().expect("spans").push(span);
        }
        fn force_flush(&self) -> OTelSdkResult {
            Ok(())
        }
        fn shutdown_with_timeout(&self, _: std::time::Duration) -> OTelSdkResult {
            Ok(())
        }
    }

    fn test_sdk(spans: CaptureSpans) -> Sdk {
        Sdk::builder()
            .service_name("proc-test")
            .environment(Environment::Test)
            .without_otel_env()
            .without_console_log()
            .without_runtime_metrics()
            .with_span_processor(spans)
            .build()
            .expect("sdk")
    }

    // go/o11yproc/o11yproc_test.go TestEnvRoundTripsThroughTheEnvironment
    #[test]
    fn env_round_trips_through_environment_and_command() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans.clone());
        let tracer = sdk.tracer("test");
        let parent = tracer.start("parent");
        let parent_sc = parent.span_context().clone();
        let state = TraceState::from_str("vendor=abc").expect("tracestate");
        let parent_with_state = SpanContext::new(
            parent_sc.trace_id(),
            parent_sc.span_id(),
            parent_sc.trace_flags(),
            parent_sc.is_remote(),
            state,
        );
        let parent_cx = Context::new()
            .with_remote_span_context(parent_with_state)
            .with_baggage([KeyValueMetadata::new("tenant", "acme", "")]);

        let vars = env(&parent_cx);
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].0, ENV_TRACEPARENT);
        assert_eq!(vars[1].0, ENV_TRACESTATE);
        assert_eq!(vars[1].1, "vendor=abc");

        // Command receives both TRACEPARENT and TRACESTATE, and never BAGGAGE.
        let mut cmd = Command::new("worker");
        inject_command(&parent_cx, &mut cmd);
        let cmd_envs: Vec<(&OsStr, Option<&OsStr>)> = cmd.get_envs().collect();
        assert_eq!(cmd_envs.len(), 2);
        assert_eq!(cmd_envs[0].0, OsStr::new(ENV_TRACEPARENT));
        assert_eq!(cmd_envs[1].0, OsStr::new(ENV_TRACESTATE));
        assert_eq!(cmd_envs[1].1, Some(OsStr::new("vendor=abc")));

        let child_cx = from_env_pairs(&Context::new(), vars);
        let sc = child_cx.span().span_context().clone();
        assert_eq!(sc.trace_id(), parent_sc.trace_id());
        assert_eq!(sc.span_id(), parent_sc.span_id());
        assert!(sc.is_remote(), "adopted span context must be remote");
        assert_eq!(sc.trace_state().get("vendor"), Some("abc"));
        assert!(
            child_cx.baggage().is_empty(),
            "baggage must not travel through process env"
        );

        let mut child = tracer.start_with_context("child", &child_cx);
        child.end();
        drop(parent);

        let recorded = spans.spans();
        assert_eq!(recorded.len(), 2);
        let child_span = recorded
            .iter()
            .find(|s| s.name == "child")
            .expect("child span");
        assert_eq!(child_span.parent_span_id, parent_sc.span_id());
    }

    // go/o11yproc/o11yproc_test.go TestEnvOutsideASpanIsEmpty
    #[test]
    fn env_outside_a_span_is_empty() {
        assert!(env(&Context::new()).is_empty());
        let mut cmd = Command::new("worker");
        inject_command(&Context::new(), &mut cmd);
        assert_eq!(cmd.get_envs().count(), 0);
    }

    // go/o11yproc/o11yproc_test.go TestFromEnvIgnoresMissingAndInvalidValues
    #[test]
    fn from_env_ignores_missing_empty_and_invalid_values() {
        for (name, pairs) in [
            ("unset", vec![(ENV_TRACESTATE, "vendor=abc")]),
            (
                "empty",
                vec![(ENV_TRACEPARENT, ""), (ENV_TRACESTATE, "vendor=abc")],
            ),
            (
                "invalid",
                vec![
                    (ENV_TRACEPARENT, "00-not-a-traceparent"),
                    (ENV_TRACESTATE, "vendor=abc"),
                ],
            ),
        ] {
            let cx = from_env_pairs(&Context::new(), pairs);
            let sc = cx.span().span_context().clone();
            assert!(!sc.is_valid(), "{name}: adopted invalid span {sc:?}");
            assert!(
                sc.trace_state().header().is_empty(),
                "{name}: adopted tracestate without valid traceparent"
            );
        }
    }

    // go/o11yproc/o11yproc_test.go TestEnvOverridesAnInheritedTracestate
    #[test]
    fn env_overrides_an_inherited_tracestate() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let span = sdk.tracer("test").start("spawn");
        let want_trace = span.span_context().trace_id();
        let cx = Context::new().with_span(span);

        let mut merged = vec![
            (
                ENV_TRACEPARENT.to_owned(),
                "00-11111111111111111111111111111111-1111111111111111-01".to_owned(),
            ),
            (ENV_TRACESTATE.to_owned(), "vendor=stale".to_owned()),
        ];
        let entries = env(&cx);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, ENV_TRACEPARENT);
        assert_eq!(entries[1].0, ENV_TRACESTATE);
        assert_eq!(entries[1].1, "");
        merged.extend(entries);

        let child_cx = from_env_pairs(&Context::new(), merged);
        let sc = child_cx.span().span_context().clone();
        assert_eq!(sc.trace_id(), want_trace);
        assert!(
            sc.trace_state().header().is_empty(),
            "stale inherited tracestate leaked"
        );
    }

    // go/o11yproc/sdk_test.go TestInjectExtractWithSDKUseItsPropagator
    #[test]
    fn inject_extract_with_sdk_uses_its_propagator_and_egress_filter() {
        let spans = CaptureSpans::default();
        let sdk = Sdk::builder()
            .service_name("proc-egress")
            .environment(Environment::Test)
            .without_otel_env()
            .without_console_log()
            .without_runtime_metrics()
            .with_span_processor(spans)
            .baggage_egress(|key| key != "session")
            .build()
            .expect("sdk");
        let span = sdk.tracer("test").start("send");
        let want_sc = span.span_context().clone();
        let cx = Context::new().with_span(span).with_baggage([
            KeyValueMetadata::new("tenant", "acme", ""),
            KeyValueMetadata::new("session", "s-1", ""),
        ]);

        let mut frame = HashMap::new();
        inject_with_sdk(&sdk, &cx, &mut frame);
        assert!(frame.contains_key("traceparent"), "{frame:?}");
        let bag = frame.get("baggage").map_or("", String::as_str);
        assert!(bag.contains("tenant=acme"), "{bag}");
        assert!(!bag.contains("session"), "{bag}");

        let out = extract_with_sdk(&sdk, &Context::new(), &frame);
        let got_sc = out.span().span_context().clone();
        assert_eq!(got_sc.trace_id(), want_sc.trace_id());
        assert_eq!(got_sc.span_id(), want_sc.span_id());
        assert!(got_sc.is_remote());
        assert_eq!(
            out.baggage().get("tenant").map(ToString::to_string),
            Some("acme".to_owned())
        );
    }

    // go/o11yproc/sdk_test.go TestInjectWithSDKAppliesItsPropagatorConfig
    #[test]
    fn inject_with_sdk_applies_its_propagator_config() {
        let spans = CaptureSpans::default();
        let sdk = Sdk::builder()
            .service_name("proc-tc-only")
            .environment(Environment::Test)
            .without_otel_env()
            .without_console_log()
            .without_runtime_metrics()
            .with_span_processor(spans)
            .propagators([Box::new(TraceContextPropagator::new()) as crate::BoxedPropagator])
            .build()
            .expect("sdk");
        let span = sdk.tracer("test").start("send");
        let cx = Context::new()
            .with_span(span)
            .with_baggage([KeyValueMetadata::new("tenant", "acme", "")]);

        let mut frame = HashMap::new();
        inject_with_sdk(&sdk, &cx, &mut frame);
        assert!(frame.contains_key("traceparent"));
        assert!(!frame.contains_key("baggage"));

        let inbound = HashMap::from([
            ("traceparent".to_owned(), frame["traceparent"].clone()),
            ("baggage".to_owned(), "tenant=acme".to_owned()),
        ]);
        let out = extract_with_sdk(&sdk, &Context::new(), &inbound);
        assert!(out.baggage().is_empty());
    }
}
