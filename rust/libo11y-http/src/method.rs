//! HTTP method normalization and route-aware span naming matching Go's
//! `o11yhttp` contract and OpenTelemetry HTTP semantic conventions 1.41.0.

/// The semantic-convention value for HTTP methods outside the known set.
pub const METHOD_OTHER: &str = "_OTHER";

/// Known HTTP methods per OpenTelemetry HTTP semantic conventions 1.41.0 and
/// Go's `o11yhttp` `knownMethods` table.
const KNOWN_METHODS: &[&str] = &[
    "CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE",
];

/// Normalizes an HTTP request method onto the bounded semantic-convention set.
///
/// Returns `(normalized, exact)`:
/// - An empty method maps to `("_OTHER", true)` so `http.request.method_original`
///   is omitted (matching Go `o11yhttp` / `otelhttp`).
/// - An exact uppercase known method maps to `(method, true)`.
/// - A known method in another case maps to `(UPPER, false)` so the caller
///   records `http.request.method_original`.
/// - Any other method maps to `("_OTHER", false)` so the caller records
///   `http.request.method_original`.
#[must_use]
pub fn normalize_method(method: &str) -> (&'static str, bool) {
    if method.is_empty() {
        return (METHOD_OTHER, true);
    }
    for &known in KNOWN_METHODS {
        if method == known {
            return (known, true);
        }
        if method.eq_ignore_ascii_case(known) {
            return (known, false);
        }
    }
    (METHOD_OTHER, false)
}

/// Returns the method label used in span names: `"HTTP"` when `normalized` is
/// [`METHOD_OTHER`], otherwise `normalized`.
#[must_use]
pub fn span_method(normalized: &str) -> &str {
    if normalized == METHOD_OTHER {
        "HTTP"
    } else {
        normalized
    }
}

/// Strips a leading method prefix from a route pattern (for example,
/// `"GET /users/{id}"` becomes `"/users/{id}"`).
#[must_use]
pub fn route_only(pattern: &str) -> &str {
    pattern.split_once(' ').map_or(pattern, |(_, route)| route)
}

/// Computes the default HTTP server span name matching Go's `defaultSpanName`:
///
/// 1. If `route` is present and non-empty: uses `route` verbatim when it
///    already contains a space (method + route), else `"{span_method} {route}"`.
/// 2. Else if `operation` is present and non-empty: uses `operation`.
/// 3. Else uses `span_method` (`"HTTP"` for `_OTHER`, else normalized method).
#[must_use]
pub fn default_span_name(method_raw: &str, route: Option<&str>, operation: Option<&str>) -> String {
    let (normalized, _) = normalize_method(method_raw);
    let sm = span_method(normalized);
    if let Some(route) = route.filter(|r| !r.is_empty()) {
        if route.contains(' ') {
            return route.to_owned();
        }
        return format!("{sm} {route}");
    }
    if let Some(op) = operation.filter(|o| !o.is_empty()) {
        return op.to_owned();
    }
    sm.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_method_matches_go_contract() {
        for &m in KNOWN_METHODS {
            assert_eq!(normalize_method(m), (m, true));
        }
        assert_eq!(normalize_method("get"), ("GET", false));
        assert_eq!(normalize_method("Post"), ("POST", false));
        assert_eq!(normalize_method("XQZ123"), (METHOD_OTHER, false));
        assert_eq!(normalize_method(""), (METHOD_OTHER, true));
    }

    #[test]
    fn span_naming_and_route_stripping_match_go_contract() {
        assert_eq!(
            default_span_name("GET", Some("/users/{id}"), Some("users")),
            "GET /users/{id}"
        );
        assert_eq!(
            default_span_name("GET", Some("GET /users/{id}"), Some("users")),
            "GET /users/{id}"
        );
        assert_eq!(
            default_span_name("XQZ123", Some("/items/{id}"), Some("items")),
            "HTTP /items/{id}"
        );
        assert_eq!(
            default_span_name("get", Some("/items/{id}"), None),
            "GET /items/{id}"
        );
        assert_eq!(default_span_name("POST", None, Some("orders")), "orders");
        assert_eq!(default_span_name("POST", None, None), "POST");
        assert_eq!(default_span_name("XQZ123", None, None), "HTTP");
        assert_eq!(default_span_name("", None, None), "HTTP");

        assert_eq!(route_only("GET /users/{id}"), "/users/{id}");
        assert_eq!(route_only("/users/{id}"), "/users/{id}");
    }
}
