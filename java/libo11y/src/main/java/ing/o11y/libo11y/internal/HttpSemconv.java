package ing.o11y.libo11y.internal;

import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * HTTP semantic-convention rules shared by libo11y's HTTP server and client instrumentation,
 * matching the Go reference ({@code go/o11yhttp}) and semantic conventions 1.41.0. Internal: not
 * part of the public API.
 */
public final class HttpSemconv {
    /** The {@code http.request.method} value for a method outside the known set. */
    public static final String METHOD_OTHER = "_OTHER";

    /**
     * Bucket boundaries, in seconds, that the semantic conventions advise for
     * {@code http.server.request.duration} and {@code http.client.request.duration}.
     */
    public static final List<Double> DURATION_BUCKETS = List.of(
            0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0);

    private static final Set<String> KNOWN_METHODS = Set.of(
            "CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE");

    private HttpSemconv() {}

    /**
     * A request method mapped onto the bounded semantic-convention set.
     *
     * @param value the {@code http.request.method} value: a known method or {@code _OTHER}
     * @param original the {@code http.request.method_original} value, or {@code null} when the
     *     raw method already is {@code value} (or is empty, as in Go)
     */
    public record Method(String value, String original) {
        /** The method part of a span name: the method, or {@code HTTP} for an unknown one. */
        public String spanName() {
            return METHOD_OTHER.equals(value) ? "HTTP" : value;
        }
    }

    /**
     * Normalises a raw request method the way Go's {@code normalizeMethod} (and otelhttp) does: a
     * known method passes through, a known method in another case is upper-cased with the raw
     * value kept as the original, and anything else becomes {@code _OTHER}.
     */
    public static Method method(String raw) {
        if (raw == null || raw.isEmpty()) {
            return new Method(METHOD_OTHER, null);
        }
        if (KNOWN_METHODS.contains(raw)) {
            return new Method(raw, null);
        }
        String upper = raw.toUpperCase(Locale.ROOT);
        if (KNOWN_METHODS.contains(upper)) {
            return new Method(upper, raw);
        }
        return new Method(METHOD_OTHER, raw);
    }

    /**
     * The {@code error.type} for a server response status: the status code for 5xx (and for an
     * invalid code), otherwise {@code null}. Server spans are ERROR under the same rule.
     */
    public static String serverErrorType(int status) {
        return status >= 500 || status < 100 ? Integer.toString(status) : null;
    }

    /**
     * The {@code error.type} for a client response status: the status code for 4xx and 5xx (and
     * for an invalid code), otherwise {@code null}. Client spans are ERROR under the same rule.
     */
    public static String clientErrorType(int status) {
        return status >= 400 || status < 100 ? Integer.toString(status) : null;
    }
}
