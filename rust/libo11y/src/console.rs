//! Console log formatting (JSON and logfmt text) matching Go `log/slog` byte
//! for byte in key order and level naming.

use std::fmt::Write as _;
use std::io;
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use opentelemetry::logs::{AnyValue, Severity};
use tracing::Level;

use libo11y_spec::{go_quote, is_go_print};

use crate::BoxError;
use crate::canonical::{base64, go_float};
use crate::log_layer::{LogRecord, LogSink};

/// The output format of libo11y's console log sink.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ConsoleFormat {
    /// Structured JSON, one line per record, with Go `slog.JSONHandler` key
    /// order (`time`, `level`, `msg`, `trace_id`, `span_id`, attributes). The
    /// default.
    #[default]
    Json,
    /// Human-readable logfmt text, matching Go `slog.TextHandler`.
    Text,
}

impl ConsoleFormat {
    /// The format as the effective configuration reports it.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Text => "text",
        }
    }
}

/// Renders a `tracing::Level` as Go `slog.Level.String()` spells it.
///
/// `tracing::Level::TRACE` sits four below `DEBUG`, which Go `slog` formats as
/// `DEBUG-4`.
pub(crate) const fn level_str(level: Level) -> &'static str {
    match level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARN",
        Level::INFO => "INFO",
        Level::DEBUG => "DEBUG",
        Level::TRACE => "DEBUG-4",
    }
}

/// Maps a `tracing::Level` to its OpenTelemetry `Severity` number (`TRACE=1`,
/// `DEBUG=5`, `INFO=9`, `WARN=13`, `ERROR=17`).
pub(crate) const fn severity_number(level: Level) -> Severity {
    match level {
        Level::TRACE => Severity::Trace,
        Level::DEBUG => Severity::Debug,
        Level::INFO => Severity::Info,
        Level::WARN => Severity::Warn,
        Level::ERROR => Severity::Error,
    }
}

/// The console sink: serializes each record to JSON or logfmt text and writes
/// the complete line under one lock so concurrent callers never interleave.
pub(crate) struct ConsoleSink {
    writer: Mutex<Box<dyn io::Write + Send>>,
    format: ConsoleFormat,
}

impl ConsoleSink {
    pub(crate) fn new(writer: Box<dyn io::Write + Send>, format: ConsoleFormat) -> Self {
        Self {
            writer: Mutex::new(writer),
            format,
        }
    }

    pub(crate) fn stdout(format: ConsoleFormat) -> Self {
        Self::new(Box::new(io::stdout()), format)
    }
}

impl LogSink for ConsoleSink {
    fn emit(&self, record: &LogRecord) -> Result<(), BoxError> {
        let line = match self.format {
            ConsoleFormat::Json => format_json(record),
            ConsoleFormat::Text => format_text(record),
        };
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        writer
            .write_all(line.as_bytes())
            .map_err(|err| Box::new(err) as BoxError)
    }
}

/// Formats `record` as one JSON line in Go `slog.JSONHandler` key order:
/// `{"time":"...","level":"...","msg":"...","trace_id":"...","span_id":"...",...attrs}\n`.
pub(crate) fn format_json(record: &LogRecord) -> String {
    let mut out = String::with_capacity(128);
    out.push_str("{\"time\":\"");
    append_rfc3339_nano(record.timestamp(), &mut out);
    out.push_str("\",\"level\":\"");
    out.push_str(level_str(record.level()));
    out.push_str("\",\"msg\":");
    json_quote(record.message(), &mut out);
    if let (Some(trace_id), Some(span_id)) = (record.trace_id(), record.span_id()) {
        // Writing to a String cannot fail.
        let _ = write!(
            out,
            ",\"trace_id\":\"{trace_id}\",\"span_id\":\"{span_id}\""
        );
    }
    for (key, value) in record.attributes() {
        out.push(',');
        json_quote(key.as_str(), &mut out);
        out.push(':');
        append_json_any(value, &mut out);
    }
    out.push_str("}\n");
    out
}

/// Formats `record` as one logfmt line in Go `slog.TextHandler` key order:
/// `time=... level=... msg=... trace_id=... span_id=... k=v\n`.
pub(crate) fn format_text(record: &LogRecord) -> String {
    let mut out = String::with_capacity(128);
    out.push_str("time=");
    append_rfc3339_nano(record.timestamp(), &mut out);
    out.push_str(" level=");
    out.push_str(level_str(record.level()));
    out.push_str(" msg=");
    append_text_value(record.message(), &mut out);
    if let (Some(trace_id), Some(span_id)) = (record.trace_id(), record.span_id()) {
        // Writing to a String cannot fail.
        let _ = write!(out, " trace_id={trace_id} span_id={span_id}");
    }
    for (key, value) in record.attributes() {
        out.push(' ');
        append_text_value(key.as_str(), &mut out);
        out.push('=');
        append_text_any(value, &mut out);
    }
    out.push('\n');
    out
}

/// Writes `value` as JSON. Finite doubles render with Go's shortest `'g'`
/// format; NaN and infinities render as JSON strings, as Go's
/// `slog.JSONHandler` does. Map keys sort in UTF-8 byte order for
/// deterministic output.
fn append_json_any(value: &AnyValue, out: &mut String) {
    match value {
        AnyValue::Int(i) => {
            let _ = write!(out, "{i}");
        }
        AnyValue::Double(f) => {
            if f.is_finite() {
                out.push_str(&go_float(*f));
            } else {
                json_quote(&go_float(*f), out);
            }
        }
        AnyValue::String(s) => json_quote(s.as_str(), out),
        AnyValue::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
        AnyValue::Bytes(bytes) => json_quote(&base64(bytes), out),
        AnyValue::ListAny(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                append_json_any(item, out);
            }
            out.push(']');
        }
        AnyValue::Map(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
            out.push('{');
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_quote(k.as_str(), out);
                out.push(':');
                append_json_any(v, out);
            }
            out.push('}');
        }
        other => json_quote(&format!("{other:?}"), out),
    }
}

/// Writes `value` as a logfmt value.
fn append_text_any(value: &AnyValue, out: &mut String) {
    match value {
        AnyValue::Int(i) => {
            let _ = write!(out, "{i}");
        }
        AnyValue::Double(f) => out.push_str(&go_float(*f)),
        AnyValue::String(s) => append_text_value(s.as_str(), out),
        AnyValue::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
        AnyValue::Bytes(bytes) => append_text_value(&base64(bytes), out),
        AnyValue::ListAny(_) | AnyValue::Map(_) => {
            let mut json = String::new();
            append_json_any(value, &mut json);
            append_text_value(&json, out);
        }
        other => append_text_value(&format!("{other:?}"), out),
    }
}

/// Quotes `s` as JSON, matching Go's `slog.JSONHandler` (no HTML escaping of
/// `<`, `>`, `&`).
fn json_quote(s: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if c < ' ' => {
                let b = u32::from(c);
                out.push_str("\\u00");
                out.push(char::from(HEX[(b >> 4) as usize]));
                out.push(char::from(HEX[(b & 0xf) as usize]));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Appends `s` in Go `slog.TextHandler` logfmt form: quoted with Go's quoting
/// when empty or containing white space, `=`, `"`, or a non-printable rune.
fn append_text_value(s: &str, out: &mut String) {
    let needs_quotes = s.is_empty()
        || s.chars()
            .any(|c| c.is_whitespace() || c == '=' || c == '"' || !is_go_print(c));
    if needs_quotes {
        out.push_str(&go_quote(s));
    } else {
        out.push_str(s);
    }
}

/// Formats `time` in UTC as RFC 3339 with nanosecond precision and trailing
/// fractional zeros stripped, matching Go's `time.RFC3339Nano`.
pub(crate) fn append_rfc3339_nano(time: SystemTime, out: &mut String) {
    let (secs, nanos) = match time.duration_since(UNIX_EPOCH) {
        Ok(d) => (i64::try_from(d.as_secs()).unwrap_or(0), d.subsec_nanos()),
        Err(err) => {
            let d = err.duration();
            let sub = d.subsec_nanos();
            let whole = i64::try_from(d.as_secs()).unwrap_or(0);
            if sub == 0 {
                (-whole, 0)
            } else {
                (-whole - 1, 1_000_000_000 - sub)
            }
        }
    };
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    // Writing to a String cannot fail.
    let _ = write!(
        out,
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
    );
    if nanos > 0 {
        let mut frac = [b'0'; 9];
        let mut n = nanos;
        for slot in frac.iter_mut().rev() {
            *slot = b'0' + u8::try_from(n % 10).unwrap_or(0);
            n /= 10;
        }
        let trimmed = frac
            .iter()
            .rposition(|&b| b != b'0')
            .map_or(0, |idx| idx + 1);
        out.push('.');
        for &b in &frac[..trimmed] {
            out.push(char::from(b));
        }
    }
    out.push('Z');
}

/// The proleptic Gregorian date of `days` since 1970-01-01, by Howard
/// Hinnant's `civil_from_days`.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use opentelemetry::Key;
    use opentelemetry::trace::{SpanId, TraceId};

    use super::*;

    fn rfc3339(time: SystemTime) -> String {
        let mut out = String::new();
        append_rfc3339_nano(time, &mut out);
        out
    }

    #[test]
    fn rfc3339_nano_matches_go() {
        let base = UNIX_EPOCH + Duration::from_secs(1_764_064_800);
        assert_eq!(rfc3339(base), "2025-11-25T10:00:00Z");
        assert_eq!(
            rfc3339(base + Duration::from_millis(123)),
            "2025-11-25T10:00:00.123Z"
        );
        assert_eq!(
            rfc3339(base + Duration::from_nanos(123_456_789)),
            "2025-11-25T10:00:00.123456789Z"
        );
        assert_eq!(
            rfc3339(base + Duration::from_nanos(50)),
            "2025-11-25T10:00:00.00000005Z"
        );
        // One second before the epoch.
        assert_eq!(
            rfc3339(UNIX_EPOCH - Duration::from_secs(1)),
            "1969-12-31T23:59:59Z"
        );
        assert_eq!(
            rfc3339(UNIX_EPOCH - Duration::from_millis(250)),
            "1969-12-31T23:59:59.75Z"
        );
    }

    #[test]
    fn levels_and_severities_match_go() {
        assert_eq!(level_str(Level::ERROR), "ERROR");
        assert_eq!(level_str(Level::WARN), "WARN");
        assert_eq!(level_str(Level::INFO), "INFO");
        assert_eq!(level_str(Level::DEBUG), "DEBUG");
        assert_eq!(level_str(Level::TRACE), "DEBUG-4");

        assert_eq!(severity_number(Level::TRACE) as i32, 1);
        assert_eq!(severity_number(Level::DEBUG) as i32, 5);
        assert_eq!(severity_number(Level::INFO) as i32, 9);
        assert_eq!(severity_number(Level::WARN) as i32, 13);
        assert_eq!(severity_number(Level::ERROR) as i32, 17);
    }

    #[test]
    fn json_format_keeps_exact_go_slog_key_order() {
        let ts = UNIX_EPOCH + Duration::from_secs(1_764_064_800) + Duration::from_micros(42);
        let trace_id = TraceId::from(0x0af7_6519_16cd_43dd_8448_eb21_1c80_319c_u128);
        let span_id = SpanId::from(0xb7ad_6b71_6920_3331_u64);
        let record = LogRecord::new(
            ts,
            Level::TRACE,
            "order \"placed\"\nnow".to_owned(),
            "app".to_owned(),
            Some(trace_id),
            Some(span_id),
            None,
            vec![
                (Key::from_static_str("count"), AnyValue::Int(7)),
                (Key::from_static_str("ok"), AnyValue::Boolean(true)),
                (Key::from_static_str("ratio"), AnyValue::Double(0.25)),
                (Key::from_static_str("nan"), AnyValue::Double(f64::NAN)),
                (Key::from_static_str("raw"), AnyValue::from("<tag & value>")),
            ],
        );
        let line = format_json(&record);
        assert_eq!(
            line,
            concat!(
                "{\"time\":\"2025-11-25T10:00:00.000042Z\",",
                "\"level\":\"DEBUG-4\",",
                "\"msg\":\"order \\\"placed\\\"\\nnow\",",
                "\"trace_id\":\"0af7651916cd43dd8448eb211c80319c\",",
                "\"span_id\":\"b7ad6b7169203331\",",
                "\"count\":7,",
                "\"ok\":true,",
                "\"ratio\":0.25,",
                "\"nan\":\"NaN\",",
                "\"raw\":\"<tag & value>\"}\n"
            )
        );
        // Valid JSON parse round-trip.
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["level"], "DEBUG-4");
        assert_eq!(parsed["count"], 7);
    }

    #[test]
    fn text_format_matches_go_slog_logfmt() {
        let ts = UNIX_EPOCH + Duration::from_secs(1_764_064_800);
        let trace_id = TraceId::from(0x0af7_6519_16cd_43dd_8448_eb21_1c80_319c_u128);
        let span_id = SpanId::from(0xb7ad_6b71_6920_3331_u64);
        let map = AnyValue::Map(Box::new(HashMap::from([
            (Key::from_static_str("b"), AnyValue::Int(2)),
            (Key::from_static_str("a"), AnyValue::from("x")),
        ])));
        let record = LogRecord::new(
            ts,
            Level::INFO,
            "hello world".to_owned(),
            "app".to_owned(),
            Some(trace_id),
            Some(span_id),
            None,
            vec![
                (Key::from_static_str("simple"), AnyValue::from("ok")),
                (Key::from_static_str("empty"), AnyValue::from("")),
                (Key::from_static_str("eq"), AnyValue::from("a=b")),
                (Key::from_static_str("nested"), map),
            ],
        );
        assert_eq!(
            format_text(&record),
            "time=2025-11-25T10:00:00Z level=INFO msg=\"hello world\" trace_id=0af7651916cd43dd8448eb211c80319c span_id=b7ad6b7169203331 simple=ok empty=\"\" eq=\"a=b\" nested=\"{\\\"a\\\":\\\"x\\\",\\\"b\\\":2}\"\n"
        );
    }
}
