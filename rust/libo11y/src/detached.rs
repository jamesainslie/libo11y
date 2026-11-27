//! Detached work propagation: capture an operation's trace context into a
//! compact, bounded [`Carrier`] and start a linked root span later, possibly
//! in another process.
//!
//! A [`Carrier`] holds the W3C `traceparent` and `tracestate` together with
//! any baggage that passed the propagator's egress filter. It serializes as a
//! sorted URL-encoded query string (`baggage=...&traceparent=...&tracestate=...`),
//! matching Go's `o11y.Carrier` byte for byte, and never exceeds
//! [`MAX_CARRIER_TEXT`] (32 KiB): if the encoded form would exceed the bound,
//! `tracestate` is dropped first, then `baggage`, keeping the trace link.
//!
//! Use [`Sdk::capture`] and [`Sdk::start_linked`] with an explicit [`Sdk`], or
//! [`capture`] and [`start_linked`] with the process-global OpenTelemetry
//! providers installed by [`Builder::setup`](crate::Builder::setup).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::str::FromStr;

use opentelemetry::baggage::{Baggage, BaggageExt as _, BaggageMetadata};
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{
    Link, Span as _, SpanBuilder, SpanContext, TraceContextExt as _, Tracer, TracerProvider as _,
};
use opentelemetry::{Context, Key};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::violations::scope;
use crate::{Error, Sdk};

/// Maximum byte length of a serialized [`Carrier`] (32 KiB).
///
/// URL encoding can triple a W3C `tracestate` at its largest (32 members of
/// 256-byte keys and values), so a captured context can exceed this bound.
/// Capture drops `tracestate`, and then `baggage`, to stay within the limit.
pub const MAX_CARRIER_TEXT: usize = 32 << 10;

/// W3C baggage member count limit enforced on parse and restore.
const MAX_BAGGAGE_MEMBERS: usize = 64;

/// W3C baggage header byte length limit enforced on parse and restore.
const MAX_BAGGAGE_BYTES: usize = 8192;

const CARRIER_TRACEPARENT: &str = "traceparent";
const CARRIER_TRACESTATE: &str = "tracestate";
const CARRIER_BAGGAGE: &str = "baggage";

/// Invalid ASCII characters for RFC 7230 HTTP token (W3C baggage key).
const INVALID_TOKEN_CHARS: &[u8] = b"(),/:;<=>?@[\\]{}\"";

/// The trace context of one operation, captured so detached work (a job, a
/// queued email, a message) can link back to it later, possibly in another
/// process.
///
/// The empty (default) `Carrier` represents no captured context and serializes
/// as `""`. A non-empty `Carrier` serializes as a URL-encoded query string
/// with keys in alphabetical order (`baggage`, `traceparent`, `tracestate`,
/// omitting empty `baggage` and `tracestate`) and spaces encoded as `+`,
/// matching Go's `url.Values.Encode` byte for byte.
///
/// The serialized text includes the values of any baggage members that passed
/// the egress filter, so storing or logging a `Carrier` stores or logs those
/// values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Carrier {
    traceparent: String,
    tracestate: String,
    baggage: String,
}

impl Carrier {
    /// Reports whether this carrier holds no captured context.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.traceparent.is_empty()
    }

    /// Returns the captured [`SpanContext`], marked remote. Returns an invalid
    /// [`SpanContext::NONE`] for an empty carrier.
    #[must_use]
    pub fn span_context(&self) -> SpanContext {
        if self.traceparent.is_empty() {
            return SpanContext::NONE;
        }
        let mut map = HashMap::with_capacity(2);
        map.insert(CARRIER_TRACEPARENT.to_owned(), self.traceparent.clone());
        if !self.tracestate.is_empty() {
            map.insert(CARRIER_TRACESTATE.to_owned(), self.tracestate.clone());
        }
        let cx = TraceContextPropagator::new().extract_with_context(&Context::new(), &map);
        cx.span().span_context().clone()
    }

    /// Parses serialized carrier text produced by [`Display`](fmt::Display) or
    /// Go's `Carrier.MarshalText`.
    ///
    /// Empty text returns an empty `Carrier`. Text longer than
    /// [`MAX_CARRIER_TEXT`], malformed query strings, and text without a valid
    /// W3C `traceparent` fail with [`Error::InvalidCarrier`].
    ///
    /// Baggage members that do not parse as W3C baggage, or exceed the W3C
    /// limits of 64 members and 8192 bytes, are dropped while valid members
    /// are kept in their original order (last duplicate wins). Baggage text
    /// exceeding 8192 bytes is dropped whole.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidCarrier`] when `text` exceeds
    /// [`MAX_CARRIER_TEXT`], is not a valid query string, or lacks a valid W3C
    /// `traceparent`.
    pub fn parse(text: &str) -> Result<Self, Error> {
        if text.is_empty() {
            return Ok(Self::default());
        }
        if text.len() > MAX_CARRIER_TEXT {
            return Err(Error::InvalidCarrier {
                detail: format!(
                    "{} bytes exceeds the {MAX_CARRIER_TEXT} byte limit",
                    text.len()
                ),
            });
        }
        let values = parse_query(text).map_err(|detail| Error::InvalidCarrier { detail })?;
        let candidate = Self {
            traceparent: values.get(CARRIER_TRACEPARENT).cloned().unwrap_or_default(),
            tracestate: values.get(CARRIER_TRACESTATE).cloned().unwrap_or_default(),
            baggage: String::new(),
        };
        let sc = candidate.span_context();
        if !sc.is_valid() {
            return Err(Error::InvalidCarrier {
                detail: "no valid traceparent".to_owned(),
            });
        }
        let raw_bag = values.get(CARRIER_BAGGAGE).map_or("", String::as_str);
        Ok(new_carrier(&sc, valid_baggage(raw_bag)))
    }

    /// Renders the serialized form: empty string for an empty carrier.
    #[must_use]
    pub fn encode(&self) -> String {
        if self.is_empty() {
            return String::new();
        }
        let mut out = String::new();
        if !self.baggage.is_empty() {
            out.push_str(CARRIER_BAGGAGE);
            out.push('=');
            query_escape_into(&self.baggage, &mut out);
        }
        if !out.is_empty() {
            out.push('&');
        }
        out.push_str(CARRIER_TRACEPARENT);
        out.push('=');
        query_escape_into(&self.traceparent, &mut out);
        if !self.tracestate.is_empty() {
            out.push('&');
            out.push_str(CARRIER_TRACESTATE);
            out.push('=');
            query_escape_into(&self.tracestate, &mut out);
        }
        out
    }
}

impl fmt::Display for Carrier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.encode())
    }
}

impl FromStr for Carrier {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl Serialize for Carrier {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.encode())
    }
}

impl<'de> Deserialize<'de> for Carrier {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(serde::de::Error::custom)
    }
}

/// Captures the active span context and egress-filtered baggage from `cx`
/// using the process-global OpenTelemetry propagator.
///
/// Returns an empty [`Carrier`] when `cx` holds no valid span context. Before
/// [`Builder::setup`](crate::Builder::setup) installs a global propagator, the
/// global no-op propagator injects no baggage. With an [`Sdk`] built by
/// [`Builder::build`](crate::Builder::build), prefer [`Sdk::capture`].
#[must_use]
pub fn capture(cx: &Context) -> Carrier {
    opentelemetry::global::get_text_map_propagator(|prop| capture_with(cx, prop))
}

/// Captures the active span context and baggage from `cx` using `propagator`.
///
/// Returns an empty [`Carrier`] when `cx` holds no valid span context.
#[must_use]
pub fn capture_with(cx: &Context, propagator: &dyn TextMapPropagator) -> Carrier {
    let sc = cx.span().span_context().clone();
    if !sc.is_valid() {
        return Carrier::default();
    }
    let mut out = HashMap::new();
    propagator.inject_context(cx, &mut out);
    let bag = out.remove(CARRIER_BAGGAGE).unwrap_or_default();
    new_carrier(&sc, bag)
}

/// Starts a new root span on the global tracer provider linked to `carrier`,
/// restoring `carrier`'s baggage onto `cx`.
///
/// An empty carrier starts an unlinked root span. The returned [`Context`]
/// carries the merged baggage (with carrier members replacing matching keys in
/// `cx`) and the new span's context. With an [`Sdk`] built by
/// [`Builder::build`](crate::Builder::build), prefer [`Sdk::start_linked`].
#[must_use]
pub fn start_linked(
    cx: &Context,
    carrier: &Carrier,
    name: impl Into<Cow<'static, str>>,
) -> (Context, opentelemetry::global::BoxedSpan) {
    start_linked_with(cx, carrier, name, |builder| builder)
}

/// Like [`start_linked`], allowing the caller to customize the [`SpanBuilder`]
/// (for example setting [`SpanKind::Consumer`](opentelemetry::trace::SpanKind::Consumer)
/// or initial attributes) after the root and link options are applied.
#[must_use]
pub fn start_linked_with(
    cx: &Context,
    carrier: &Carrier,
    name: impl Into<Cow<'static, str>>,
    configure: impl FnOnce(SpanBuilder) -> SpanBuilder,
) -> (Context, opentelemetry::global::BoxedSpan) {
    let tracer = opentelemetry::global::tracer_provider().tracer_with_scope(scope());
    start_linked_on_tracer(cx, &tracer, carrier, name, configure)
}

impl Sdk {
    /// Captures the active span context and baggage from `cx` as a [`Carrier`]
    /// using this SDK's propagator (including its baggage egress filter).
    ///
    /// Returns an empty [`Carrier`] when `cx` holds no valid span context.
    #[must_use]
    pub fn capture(&self, cx: &Context) -> Carrier {
        capture_with(cx, self.propagator())
    }

    /// Starts a new root span for detached work on this SDK's tracer provider
    /// under libo11y's instrumentation scope, linked to `carrier` when valid,
    /// and merges `carrier`'s baggage onto `cx`.
    ///
    /// An empty carrier starts an unlinked root span. The returned [`Context`]
    /// carries the merged baggage and the new root span's context.
    #[must_use]
    pub fn start_linked(
        &self,
        cx: &Context,
        carrier: &Carrier,
        name: impl Into<Cow<'static, str>>,
    ) -> (Context, opentelemetry_sdk::trace::Span) {
        self.start_linked_with(cx, carrier, name, |builder| builder)
    }

    /// Like [`Sdk::start_linked`], allowing the caller to customize the
    /// [`SpanBuilder`] (for example setting
    /// [`SpanKind::Consumer`](opentelemetry::trace::SpanKind::Consumer) or
    /// attributes) after the carrier link is attached.
    #[must_use]
    pub fn start_linked_with(
        &self,
        cx: &Context,
        carrier: &Carrier,
        name: impl Into<Cow<'static, str>>,
        configure: impl FnOnce(SpanBuilder) -> SpanBuilder,
    ) -> (Context, opentelemetry_sdk::trace::Span) {
        let tracer = self.tracer_provider().tracer_with_scope(scope());
        start_linked_on_tracer(cx, &tracer, carrier, name, configure)
    }
}

fn start_linked_on_tracer<T: Tracer>(
    cx: &Context,
    tracer: &T,
    carrier: &Carrier,
    name: impl Into<Cow<'static, str>>,
    configure: impl FnOnce(SpanBuilder) -> SpanBuilder,
) -> (Context, T::Span) {
    // Start from a fresh Context carrying only the merged baggage so no
    // ambient span (nor an unsampled NONE span) affects the ParentBased
    // sampler or leaks under a no-op tracer.
    let root_cx = detached_root_context(cx, &carrier.baggage);
    let mut builder = tracer.span_builder(name);
    let sc = carrier.span_context();
    if sc.is_valid() {
        builder = builder.with_links(vec![Link::new(sc, Vec::new(), 0)]);
    }
    let builder = configure(builder);
    let span = tracer.build_with_context(builder, &root_cx);
    let new_cx = if span.span_context().is_valid() {
        root_cx.with_remote_span_context(span.span_context().clone())
    } else {
        root_cx
    };
    (new_cx, span)
}

/// Builds a [`Carrier`] with canonical W3C `traceparent` and `tracestate`,
/// dropping `tracestate` and then `baggage` if the encoded form exceeds
/// [`MAX_CARRIER_TEXT`].
fn new_carrier(sc: &SpanContext, baggage: String) -> Carrier {
    let mut tc = HashMap::with_capacity(2);
    let span_cx = Context::new().with_remote_span_context(sc.clone());
    TraceContextPropagator::new().inject_context(&span_cx, &mut tc);
    let mut carrier = Carrier {
        traceparent: tc.remove(CARRIER_TRACEPARENT).unwrap_or_default(),
        tracestate: tc.remove(CARRIER_TRACESTATE).unwrap_or_default(),
        baggage,
    };
    if carrier.encode().len() > MAX_CARRIER_TEXT {
        carrier.tracestate.clear();
    }
    if carrier.encode().len() > MAX_CARRIER_TEXT {
        carrier.baggage.clear();
    }
    carrier
}

/// Encodes `s` identically to Go's `net/url.QueryEscape`: ASCII alphanumerics
/// and `-`, `_`, `.`, `~` pass through, space becomes `+`, and every other
/// byte becomes uppercase `%XX`.
fn query_escape_into(s: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(b));
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from(HEX[usize::from(b >> 4)]));
                out.push(char::from(HEX[usize::from(b & 0x0f)]));
            }
        }
    }
}

/// Decodes a URL-encoded query string identically to Go's `net/url.ParseQuery`
/// (first value wins per key, matching `url.Values.Get`).
fn parse_query(query: &str) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    for part in query.split('&') {
        if part.is_empty() {
            continue;
        }
        if part.contains(';') {
            return Err("invalid semicolon separator in query".to_owned());
        }
        let (raw_key, raw_val) = part.split_once('=').unwrap_or((part, ""));
        let key = query_unescape(raw_key)?;
        let val = query_unescape(raw_val)?;
        values.entry(key).or_insert(val);
    }
    Ok(values)
}

/// Decodes a query component identically to Go's `net/url.QueryUnescape`.
fn query_unescape(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let Some(&hi_b) = bytes.get(i + 1) else {
                    return Err(format!("invalid URL escape {:?}", &s[i..]));
                };
                let Some(&lo_b) = bytes.get(i + 2) else {
                    return Err(format!("invalid URL escape {:?}", &s[i..]));
                };
                let (Some(hi), Some(lo)) = (hex_nibble(hi_b), hex_nibble(lo_b)) else {
                    return Err(format!("invalid URL escape {:?}", &s[i..i + 3]));
                };
                out.push((hi << 4) | lo);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|err| format!("invalid UTF-8 in query: {err}"))
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// One parsed W3C baggage member.
#[derive(Clone, PartialEq, Eq)]
struct ParsedMember<'a> {
    raw: &'a str,
    key: String,
    value: String,
    metadata: String,
    canonical: String,
}

fn is_valid_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_graphic() && !INVALID_TOKEN_CHARS.contains(&b))
}

fn is_valid_baggage_octet(b: u8) -> bool {
    b.is_ascii_graphic() && !matches!(b, b'"' | b',' | b';' | b'\\')
}

/// Percent-decodes a W3C baggage value (`+` stays `+`, `%XX` must be valid hex
/// and valid UTF-8).
fn percent_unescape(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = hex_nibble(*bytes.get(i + 1)?)?;
            let lo = hex_nibble(*bytes.get(i + 2)?)?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Parses one raw comma-delimited W3C baggage member.
fn parse_baggage_member(raw: &str) -> Option<ParsedMember<'_>> {
    let (kv_part, props_part) = match raw.split_once(';') {
        Some((kv, props)) => (kv, Some(props)),
        None => (raw, None),
    };
    let (raw_key, raw_val) = kv_part.split_once('=')?;
    let key = raw_key.trim();
    if !is_valid_token(key) {
        return None;
    }
    let val_encoded = raw_val.trim();
    if !val_encoded.bytes().all(is_valid_baggage_octet) {
        return None;
    }
    let value = percent_unescape(val_encoded)?;

    let mut clean_props = Vec::new();
    if let Some(props) = props_part {
        for prop in props.split(';') {
            let prop = prop.trim();
            if prop.is_empty() {
                return None;
            }
            if let Some((pk, pv)) = prop.split_once('=') {
                let pk = pk.trim();
                let pv = pv.trim();
                if !is_valid_token(pk) || !pv.bytes().all(is_valid_baggage_octet) {
                    return None;
                }
                clean_props.push(format!("{pk}={pv}"));
            } else {
                if !is_valid_token(prop) {
                    return None;
                }
                clean_props.push(prop.to_owned());
            }
        }
    }
    let metadata = clean_props.join(";");
    let canonical = if metadata.is_empty() {
        format!("{key}={val_encoded}")
    } else {
        format!("{key}={val_encoded};{metadata}")
    };
    Some(ParsedMember {
        raw,
        key: key.to_owned(),
        value,
        metadata,
        canonical,
    })
}

/// Parses W3C baggage with Go's `baggage.Parse` semantics: rejects inputs over
/// 8192 bytes whole, skips invalid segments, applies last-wins on duplicate
/// keys, and stops at 64 distinct members or 8192 total encoded bytes.
///
/// Returns `(kept_members_in_order, had_issues)` where `had_issues` is true if
/// any segment was skipped, duplicated, or dropped by a limit.
fn parse_baggage(bag: &str) -> (Vec<ParsedMember<'_>>, bool) {
    if bag.is_empty() {
        return (Vec::new(), false);
    }
    if bag.len() > MAX_BAGGAGE_BYTES {
        return (Vec::new(), true);
    }

    // First pass: determine the winning member per key under the 64-member and
    // 8192-byte limits, matching Go's `baggage.Parse`.
    let mut had_issues = false;
    let mut parsed_segments: Vec<ParsedMember<'_>> = Vec::new();
    let mut winners: HashMap<String, ParsedMember<'_>> = HashMap::new();
    let mut total_bytes: usize = 0;

    for raw in bag.split(',') {
        let Some(member) = parse_baggage_member(raw) else {
            had_issues = true;
            continue;
        };
        let member_len = member.canonical.len();
        if let Some(prev) = winners.get(&member.key) {
            had_issues = true;
            let next_total = total_bytes - prev.canonical.len() + member_len;
            if next_total > MAX_BAGGAGE_BYTES {
                continue;
            }
            total_bytes = next_total;
            winners.insert(member.key.clone(), member.clone());
            parsed_segments.push(member);
        } else {
            let comma = usize::from(!winners.is_empty());
            let next_total = total_bytes + comma + member_len;
            if winners.len() >= MAX_BAGGAGE_MEMBERS || next_total > MAX_BAGGAGE_BYTES {
                had_issues = true;
                break;
            }
            total_bytes = next_total;
            winners.insert(member.key.clone(), member.clone());
            parsed_segments.push(member);
        }
    }

    // Second pass: keep the surviving segments in their original order, once
    // per key, matching Go's `validBaggage`.
    let mut seen: HashSet<String> = HashSet::with_capacity(winners.len());
    let mut kept = Vec::with_capacity(winners.len());
    for member in parsed_segments {
        if seen.contains(&member.key) {
            continue;
        }
        if winners
            .get(&member.key)
            .is_some_and(|w| w.canonical == member.canonical)
        {
            seen.insert(member.key.clone());
            kept.push(member);
        }
    }
    (kept, had_issues)
}

/// Returns the valid members of `bag` in their original order, applying W3C
/// baggage limits (64 members, 8192 bytes) and dropping the whole string if it
/// exceeds 8192 bytes.
fn valid_baggage(bag: &str) -> String {
    if bag.is_empty() {
        return String::new();
    }
    let (kept, had_issues) = parse_baggage(bag);
    if !had_issues {
        return bag.to_owned();
    }
    if kept.is_empty() {
        return String::new();
    }
    kept.iter().map(|m| m.raw).collect::<Vec<_>>().join(",")
}

/// Builds a span-free [`Context`] carrying `cx`'s baggage merged with `bag`,
/// replacing members with the same key and enforcing W3C limits (64 members,
/// 8192 bytes).
fn detached_root_context(cx: &Context, bag: &str) -> Context {
    let mut merged: Baggage = cx
        .baggage()
        .iter()
        .map(|(k, (v, m))| (k.clone(), (v.clone(), m.clone())))
        .collect();
    if !bag.is_empty() {
        let (kept, _) = parse_baggage(bag);
        for member in kept {
            let _ = merged.insert_with_metadata(
                Key::new(member.key),
                member.value,
                BaggageMetadata::from(member.metadata),
            );
        }
    }
    if merged.is_empty() {
        Context::new()
    } else {
        Context::new().with_baggage(merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use opentelemetry::baggage::KeyValueMetadata;

    use opentelemetry::propagation::text_map_propagator::FieldIter;
    use opentelemetry::propagation::{Extractor, Injector};
    use opentelemetry::trace::{SpanId, SpanKind, TraceFlags, TraceId, TraceState};
    use opentelemetry_sdk::error::OTelSdkResult;
    use opentelemetry_sdk::trace::{Span, SpanData, SpanProcessor};

    use crate::{Environment, Sdk};

    #[derive(Debug, Clone, Default)]
    struct CaptureSpans(Arc<Mutex<Vec<SpanData>>>);

    impl CaptureSpans {
        fn spans(&self) -> Vec<SpanData> {
            self.0.lock().expect("spans").clone()
        }

        fn named(&self, name: &str) -> SpanData {
            self.spans()
                .into_iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("no span named {name}"))
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
            .service_name("detached-test")
            .environment(Environment::Test)
            .without_otel_env()
            .without_console_log()
            .without_runtime_metrics()
            .with_span_processor(spans)
            .build()
            .expect("sdk")
    }

    fn with_baggage(cx: &Context, pairs: &[(&str, &str)]) -> Context {
        let items = pairs
            .iter()
            .map(|(k, v)| KeyValueMetadata::new((*k).to_owned(), (*v).to_owned(), ""));
        cx.with_baggage(items)
    }

    fn remote_context(tracestate: &str) -> (Context, SpanContext) {
        let ts = if tracestate.is_empty() {
            TraceState::default()
        } else {
            TraceState::from_str(tracestate).expect("valid tracestate")
        };
        let sc = SpanContext::new(
            TraceId::from(0x0af7_6519_16cd_43dd_8448_eb21_1c80_319c_u128),
            SpanId::from(0xb7ad_6b71_6920_3331_u64),
            TraceFlags::SAMPLED,
            true,
            ts,
        );
        (Context::new().with_remote_span_context(sc.clone()), sc)
    }

    // go/detached_test.go TestCarrierRoundTripsThroughText
    #[test]
    fn carrier_round_trips_through_text() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let tracer = sdk.tracer("test");
        let span = tracer.start("request");
        let want = span.span_context().clone();
        let cx = Context::new().with_span(span);

        let carrier = sdk.capture(&with_baggage(&cx, &[("tenant", "acme")]));
        assert!(!carrier.is_empty());

        let text = carrier.to_string();
        let back: Carrier = text.parse().expect("parse");
        let got = back.span_context();
        assert_eq!(got.trace_id(), want.trace_id());
        assert_eq!(got.span_id(), want.span_id());
        assert!(got.is_remote(), "restored span context must be remote");
        assert_eq!(back.to_string(), text);
        assert!(text.contains("tenant%3Dacme"), "{text}");
        assert!(
            text.starts_with("baggage=tenant%3Dacme&traceparent="),
            "keys must be sorted alphabetically: {text}"
        );
    }

    // go/detached_test.go TestCarrierInJSONAndSQL (JSON portion)
    #[test]
    fn carrier_round_trips_through_serde_json() {
        #[derive(serde::Serialize, serde::Deserialize)]
        struct Job {
            trace: Carrier,
        }

        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let span = sdk.tracer("test").start("request");
        let want_span_id = span.span_context().span_id();
        let cx = Context::new().with_span(span);
        let carrier = sdk.capture(&cx);

        let raw = serde_json::to_string(&Job {
            trace: carrier.clone(),
        })
        .expect("serialize");
        let decoded: Job = serde_json::from_str(&raw).expect("deserialize");
        assert_eq!(decoded.trace.span_context().span_id(), want_span_id);
        assert_eq!(decoded.trace, carrier);

        // Empty carrier serializes to "" and deserializes back to empty.
        let empty_raw = serde_json::to_string(&Job {
            trace: Carrier::default(),
        })
        .expect("serialize empty");
        assert_eq!(empty_raw, r#"{"trace":""}"#);
        let empty_decoded: Job = serde_json::from_str(&empty_raw).expect("deserialize empty");
        assert!(empty_decoded.trace.is_empty());
    }

    // go/detached_test.go TestZeroCarrier
    #[test]
    fn empty_carrier_encodes_empty() {
        let carrier = capture(&Context::new());
        assert!(carrier.is_empty());
        assert_eq!(carrier.to_string(), "");
        assert!(!carrier.span_context().is_valid());
        let parsed = Carrier::parse("").expect("empty parses");
        assert!(parsed.is_empty());
    }

    // go/detached_test.go TestCarrierRejectsInvalidText
    #[test]
    fn carrier_rejects_invalid_text() {
        let long = format!("traceparent={}", "a".repeat(40 << 10));
        for (name, text, want_substr) in [
            ("not a query string", "%zz", "o11y: invalid carrier:"),
            ("semicolon separator", "a=1;b=2", "o11y: invalid carrier:"),
            (
                "bad traceparent",
                "traceparent=00-xyz",
                "o11y: invalid carrier: no valid traceparent",
            ),
            (
                "no traceparent",
                "baggage=a%3Db",
                "o11y: invalid carrier: no valid traceparent",
            ),
            (
                "too long",
                long.as_str(),
                "bytes exceeds the 32768 byte limit",
            ),
        ] {
            let err = Carrier::parse(text).expect_err(name);
            assert!(matches!(err, Error::InvalidCarrier { .. }), "{name}: {err}");
            assert!(
                err.to_string().contains(want_substr),
                "{name}: got {err}, want substring {want_substr}"
            );
        }
    }

    // go/detached_test.go TestCaptureAppliesBaggageEgressFilter
    #[test]
    fn capture_applies_baggage_egress_filter() {
        let spans = CaptureSpans::default();
        let sdk = Sdk::builder()
            .service_name("detached-egress")
            .environment(Environment::Test)
            .without_otel_env()
            .without_console_log()
            .without_runtime_metrics()
            .with_span_processor(spans)
            .baggage_egress(|key| key != "session")
            .build()
            .expect("sdk");
        let span = sdk.tracer("test").start("request");
        let cx = Context::new().with_span(span);

        let text = sdk
            .capture(&with_baggage(
                &cx,
                &[("tenant", "acme"), ("session", "s-1")],
            ))
            .to_string();
        assert!(!text.contains("session"), "egress filter missed: {text}");
        assert!(text.contains("tenant"), "egress filter dropped: {text}");
    }

    // go/detached_test.go TestStartLinkedStartsALinkedRoot
    #[test]
    fn start_linked_starts_a_linked_root() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans.clone());
        let tracer = sdk.tracer("test");
        let origin = tracer.start("request");
        let origin_sc = origin.span_context().clone();
        let origin_cx = Context::new().with_span(origin);
        let carrier = sdk.capture(&with_baggage(&origin_cx, &[("tenant", "acme")]));
        origin_cx.span().end();

        let worker_loop = tracer.start("worker-loop");
        let worker_cx = Context::new().with_span(worker_loop);
        let (job_cx, mut job) = sdk.start_linked_with(&worker_cx, &carrier, "send-email", |b| {
            b.with_kind(SpanKind::Consumer)
        });
        // Verify child span started on job_cx parents under job, not worker-loop.
        let mut child = tracer.start_with_context("smtp", &job_cx);
        child.end();
        job.end();
        worker_cx.span().end();

        let span = spans.named("send-email");
        assert_eq!(span.parent_span_id, SpanId::INVALID, "want a new root");
        assert_ne!(
            span.span_context.trace_id(),
            origin_sc.trace_id(),
            "detached span must start its own trace"
        );
        assert_eq!(span.links.len(), 1);
        assert_eq!(span.links[0].span_context.span_id(), origin_sc.span_id());
        assert_eq!(span.span_kind, SpanKind::Consumer);
        assert_eq!(
            job_cx.baggage().get("tenant").map(ToString::to_string),
            Some("acme".to_owned())
        );

        let child_span = spans.named("smtp");
        assert_eq!(child_span.parent_span_id, span.span_context.span_id());
        assert_eq!(
            child_span.span_context.trace_id(),
            span.span_context.trace_id()
        );
    }

    // go/detached_test.go TestStartLinkedWithZeroCarrierStartsUnlinkedRoot
    #[test]
    fn start_linked_with_empty_carrier_starts_unlinked_root() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans.clone());
        let (_, mut span) = sdk.start_linked(&Context::new(), &Carrier::default(), "job");
        span.end();
        let got = spans.named("job");
        assert_eq!(got.parent_span_id, SpanId::INVALID);
        assert!(got.links.is_empty());
    }

    // go/detached_test.go TestCarrierRoundTripsTracestate
    #[test]
    fn carrier_round_trips_tracestate() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let (cx, _) = remote_context("vendor=abc,other=xyz");

        let back = Carrier::parse(&sdk.capture(&cx).to_string()).expect("parse");
        assert_eq!(back.span_context().trace_state().get("vendor"), Some("abc"));
        assert_eq!(back.span_context().trace_state().get("other"), Some("xyz"));
    }

    // go/detached_test.go TestCaptureOfMaximalTracestateReadsBack
    #[test]
    fn capture_of_maximal_tracestate_drops_tracestate_before_baggage() {
        let mut entries = Vec::with_capacity(32);
        for i in 0..32 {
            // Valid W3C tracestate key (<=256) and value (<=256) full of
            // characters that URL-encoding triples (`/` -> `%2F`).
            let key = format!("k{i:02}{}", "/".repeat(253));
            let val = "/".repeat(256);
            entries.push((key, val));
        }
        let ts = TraceState::from_key_value(entries).expect("valid maximal tracestate");
        let sc = SpanContext::new(
            TraceId::from(0x0af7_6519_16cd_43dd_8448_eb21_1c80_319c_u128),
            SpanId::from(0xb7ad_6b71_6920_3331_u64),
            TraceFlags::SAMPLED,
            true,
            ts,
        );
        let cx = Context::new().with_remote_span_context(sc.clone());
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);

        let text = sdk
            .capture(&with_baggage(&cx, &[("tenant", "acme")]))
            .to_string();
        assert!(text.len() <= MAX_CARRIER_TEXT, "len = {}", text.len());
        let back = Carrier::parse(&text).expect("parse");
        assert_eq!(back.span_context().span_id(), sc.span_id());
        assert!(
            text.contains("tenant%3Dacme"),
            "must drop tracestate first and keep baggage: {text}"
        );
        assert!(!text.contains("tracestate="), "{text}");
    }

    #[test]
    fn oversized_baggage_is_dropped_when_carrier_exceeds_32kib() {
        #[derive(Debug)]
        struct HugeBaggage;
        impl TextMapPropagator for HugeBaggage {
            fn inject_context(&self, _: &Context, injector: &mut dyn Injector) {
                injector.set("baggage", format!("k={}", "v".repeat(MAX_CARRIER_TEXT)));
            }
            fn extract_with_context(&self, cx: &Context, _: &dyn Extractor) -> Context {
                cx.clone()
            }
            fn fields(&self) -> FieldIter<'_> {
                FieldIter::new(&[])
            }
        }
        let (cx, sc) = remote_context("vendor=abc");
        let carrier = capture_with(&cx, &HugeBaggage);
        assert!(carrier.encode().len() <= MAX_CARRIER_TEXT);
        assert_eq!(carrier.span_context().span_id(), sc.span_id());
        assert!(!carrier.to_string().contains("baggage="));
    }

    // go/detached_test.go TestCarrierDropsInvalidBaggage
    #[test]
    fn carrier_drops_invalid_baggage() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let (cx, sc) = remote_context("vendor=abc");
        let text = format!("{}&baggage=%3D%3D%3D", sdk.capture(&cx));

        let c = Carrier::parse(&text).expect("link kept");
        assert!(!c.to_string().contains("baggage"), "{c}");
        assert_eq!(c.span_context().span_id(), sc.span_id());
    }

    // go/detached_test.go TestStartLinkedMergesBaggageAndUsesLibraryScope
    #[test]
    fn start_linked_merges_baggage_and_uses_library_scope() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans.clone());
        let (cx, _) = remote_context("");
        let carrier = sdk.capture(&with_baggage(&cx, &[("tenant", "acme"), ("region", "eu")]));

        let worker_cx = with_baggage(&Context::new(), &[("worker", "pool-1"), ("region", "us")]);
        let (job_cx, mut job) = sdk.start_linked(&worker_cx, &carrier, "job");
        job.end();

        let bag = job_cx.baggage();
        for (key, want) in [("tenant", "acme"), ("region", "eu"), ("worker", "pool-1")] {
            assert_eq!(
                bag.get(key).map(ToString::to_string).as_deref(),
                Some(want),
                "key {key}"
            );
        }
        assert_eq!(spans.named("job").instrumentation_scope.name(), "libo11y");
    }

    // go/detached_test.go TestCarrierKeepsValidBaggageMembers
    #[test]
    fn carrier_keeps_valid_baggage_members() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let (cx, _) = remote_context("");
        let text = format!("{}&baggage=tenant%3Dacme%2C%3D%3D%3D", sdk.capture(&cx));

        let c = Carrier::parse(&text).expect("parse");
        let encoded = c.to_string();
        assert!(encoded.contains("tenant%3Dacme"), "{encoded}");
        assert!(!encoded.contains("%3D%3D%3D"), "{encoded}");

        let (job_cx, mut job) = sdk.start_linked(&Context::new(), &c, "job");
        job.end();
        assert_eq!(
            job_cx.baggage().get("tenant").map(ToString::to_string),
            Some("acme".to_owned())
        );
        assert_eq!(job_cx.baggage().len(), 1);
    }

    // go/detached_test.go TestStartLinkedKeepsBaggageUpToTheMemberLimit
    #[test]
    fn start_linked_keeps_baggage_up_to_the_member_limit() {
        #[derive(Debug)]
        struct RawBaggage(String);
        impl TextMapPropagator for RawBaggage {
            fn inject_context(&self, _: &Context, injector: &mut dyn Injector) {
                injector.set("baggage", self.0.clone());
            }
            fn extract_with_context(&self, cx: &Context, _: &dyn Extractor) -> Context {
                cx.clone()
            }
            fn fields(&self) -> FieldIter<'_> {
                FieldIter::new(&[])
            }
        }

        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let (cx, _) = remote_context("");
        let raw_70 = (0..70)
            .map(|i| format!("k{i:02}=v{i:02}"))
            .collect::<Vec<_>>()
            .join(",");
        let carrier = capture_with(&cx, &RawBaggage(raw_70));

        let (job_cx, mut job) = sdk.start_linked(&Context::new(), &carrier, "job");
        job.end();
        assert_eq!(job_cx.baggage().len(), 64);

        let back = Carrier::parse(&carrier.to_string()).expect("parse");
        let (job_cx2, mut job2) = sdk.start_linked(&Context::new(), &back, "job");
        job2.end();
        assert_eq!(job_cx2.baggage().len(), 64);
    }

    // go/detached_test.go TestCarrierKeepsValidBaggageInOrder
    #[test]
    fn carrier_keeps_valid_baggage_in_order() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let (cx, _) = remote_context("");
        let base = sdk.capture(&cx).to_string();
        let text = format!("{base}&baggage=c%3D3%2Ca%3D1%2C%3D%3D%3D%2Cb%3D2");
        let want = format!("baggage=c%3D3%2Ca%3D1%2Cb%3D2&{base}");

        for _ in 0..20 {
            let c = Carrier::parse(&text).expect("parse");
            assert_eq!(c.to_string(), want);
        }
    }

    // go/detached_test.go TestBaggageOverTheByteLimitIsDroppedWhole
    #[test]
    fn baggage_over_the_byte_limit_is_dropped_whole() {
        #[derive(Debug)]
        struct LargeBaggage(String);
        impl TextMapPropagator for LargeBaggage {
            fn inject_context(&self, _: &Context, injector: &mut dyn Injector) {
                injector.set("baggage", self.0.clone());
            }
            fn extract_with_context(&self, cx: &Context, _: &dyn Extractor) -> Context {
                cx.clone()
            }
            fn fields(&self) -> FieldIter<'_> {
                FieldIter::new(&[])
            }
        }

        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let (cx, sc) = remote_context("");
        let large = (0..40)
            .map(|i| format!("k{i:02}={}", "v".repeat(250)))
            .collect::<Vec<_>>()
            .join(",");
        assert!(large.len() > MAX_BAGGAGE_BYTES);
        let carrier = capture_with(&cx, &LargeBaggage(large));
        assert!(carrier.to_string().contains("baggage="));

        let back = Carrier::parse(&carrier.to_string()).expect("parse");
        assert!(!back.to_string().contains("baggage"));
        assert_eq!(back.span_context().span_id(), sc.span_id());

        let (job_cx, mut job) = sdk.start_linked(&Context::new(), &carrier, "job");
        job.end();
        assert!(job_cx.baggage().is_empty());
    }

    // go/detached_test.go TestCarrierKeepsTheMembersParseKeeps
    #[test]
    fn carrier_keeps_the_members_parse_keeps() {
        let spans = CaptureSpans::default();
        let sdk = test_sdk(spans);
        let (cx, _) = remote_context("");
        let base = sdk.capture(&cx).to_string();

        for (name, bag, want) in [
            (
                "property with trailing space",
                "a=1;p ,===,b=2",
                vec![("a", "1"), ("b", "2")],
            ),
            (
                "spaces around members",
                " a = 1 ;p=x , === , b=2",
                vec![("a", "1"), ("b", "2")],
            ),
            ("last duplicate wins", "a=1,a=2,===", vec![("a", "2")]),
            (
                "empty segment",
                "a=1,,===,b=2",
                vec![("a", "1"), ("b", "2")],
            ),
        ] {
            let mut escaped_bag = String::new();
            query_escape_into(bag, &mut escaped_bag);
            let text = format!("{base}&baggage={escaped_bag}");
            let c = Carrier::parse(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            let (job_cx, mut job) = sdk.start_linked(&Context::new(), &c, "job");
            job.end();
            let got_bag = job_cx.baggage();
            assert_eq!(got_bag.len(), want.len(), "{name}: {got_bag:?}");
            for (k, v) in want {
                assert_eq!(
                    got_bag.get(k).map(ToString::to_string).as_deref(),
                    Some(v),
                    "{name}: key {k}"
                );
            }
        }
    }

    #[test]
    fn query_escape_matches_go_url_values_encode() {
        let mut out = String::new();
        query_escape_into("a b+c~d*e=1&2", &mut out);
        assert_eq!(out, "a+b%2Bc~d%2Ae%3D1%262");
    }
}
