//! OpenTelemetry propagation carriers over [`http::HeaderMap`].

use http::HeaderMap;
use http::header::{HeaderName, HeaderValue};
use opentelemetry::propagation::{Extractor, Injector};

/// Reads propagation headers from an [`http::HeaderMap`].
#[derive(Debug)]
pub struct HeaderExtractor<'a>(pub &'a HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(HeaderName::as_str).collect()
    }
}

/// Writes propagation headers into an [`http::HeaderMap`].
#[derive(Debug)]
pub struct HeaderInjector<'a>(pub &'a mut HeaderMap);

impl Injector for HeaderInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            self.0.insert(name, val);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injector_and_extractor_round_trip_valid_headers() {
        let mut headers = HeaderMap::new();
        {
            let mut injector = HeaderInjector(&mut headers);
            injector.set(
                "traceparent",
                "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01".to_owned(),
            );
            injector.set("baggage", "tenant=acme".to_owned());
            // Invalid header names/values are silently ignored without panicking.
            injector.set("bad header\r\n", "value".to_owned());
            injector.set("x-bad-value", "line1\r\nline2".to_owned());
        }

        let extractor = HeaderExtractor(&headers);
        assert_eq!(
            extractor.get("traceparent"),
            Some("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
        );
        assert_eq!(extractor.get("baggage"), Some("tenant=acme"));
        assert_eq!(extractor.get("x-bad-value"), None);
        let keys = extractor.keys();
        assert!(keys.contains(&"traceparent"));
        assert!(keys.contains(&"baggage"));
    }
}
