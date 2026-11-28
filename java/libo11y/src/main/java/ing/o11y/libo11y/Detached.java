package ing.o11y.libo11y;

import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.baggage.BaggageBuilder;
import io.opentelemetry.api.baggage.BaggageEntryMetadata;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.api.trace.TraceStateBuilder;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapSetter;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Detached work propagation for jobs, queued messages and async workers.
 *
 * <p>{@link #capture(Telemetry, Context)} records the trace context of one operation in a {@link
 * Carrier} that can be stored with the work it hands off. {@link #startLinked(Telemetry, Context,
 * String, Carrier)} later starts the work's span as a new root with a link back to that operation,
 * possibly in another process and in another libo11y implementation: the serialized form is Go's,
 * byte for byte.
 */
public final class Detached {
    /**
     * The bound on a serialized {@link Carrier}: 32 KiB. Capture keeps within it by dropping the
     * tracestate, and then the baggage, so it never fails.
     */
    public static final int MAX_CARRIER_BYTES = 32 * 1024;

    private static final String TRACEPARENT = "traceparent";
    private static final String TRACESTATE = "tracestate";
    private static final String BAGGAGE = "baggage";

    private Detached() {}

    /**
     * The trace context of one operation: the W3C traceparent and tracestate, and the baggage that
     * passed the egress filter. The empty carrier means nothing was captured.
     *
     * <p>A carrier serializes to a URL-encoded query string with sorted keys, such as {@code
     * baggage=tenant%3Dacme&traceparent=00-...&tracestate=...}, exactly as Go's {@code
     * o11y.Carrier} does, so a carrier captured by one libo11y implementation is read by any
     * other. The empty carrier serializes to the empty string. The text includes the captured
     * baggage values, so storing or logging a carrier stores or logs them. Instances are
     * immutable and thread-safe.
     */
    public static final class Carrier {
        private static final Carrier EMPTY = new Carrier("", "", "");

        private final String traceparent;
        private final String tracestate;
        private final String baggage;

        private Carrier(String traceparent, String tracestate, String baggage) {
            this.traceparent = traceparent;
            this.tracestate = tracestate;
            this.baggage = baggage;
        }

        /**
         * Reports whether this carrier holds no captured context.
         *
         * @return true for the empty carrier
         */
        public boolean isEmpty() {
            return traceparent.isEmpty();
        }

        /**
         * Returns the captured span context, marked remote. It is invalid for the empty carrier.
         *
         * @return the captured span context
         */
        public SpanContext spanContext() {
            return parseTraceparent(traceparent, tracestate);
        }

        /**
         * Serializes the carrier. The text never exceeds {@link #MAX_CARRIER_BYTES}, and {@link
         * #unmarshal(String)} accepts whatever this returns.
         *
         * @return the serialized form, empty for the empty carrier
         */
        public String marshal() {
            if (isEmpty()) {
                return "";
            }
            StringBuilder sb = new StringBuilder();
            if (!baggage.isEmpty()) {
                sb.append(BAGGAGE).append('=');
                queryEscape(baggage, sb);
                sb.append('&');
            }
            sb.append(TRACEPARENT).append('=');
            queryEscape(traceparent, sb);
            if (!tracestate.isEmpty()) {
                sb.append('&').append(TRACESTATE).append('=');
                queryEscape(tracestate, sb);
            }
            return sb.toString();
        }

        /**
         * Parses serialized carrier text, as Go's {@code Carrier.UnmarshalText} does. Null or
         * empty text yields the empty carrier. Baggage members that are not valid W3C baggage,
         * and members past the W3C limits of 64 members and 8192 bytes, are dropped and the rest
         * kept in their original order, so damaged tracing data never makes stored work
         * unreadable. Baggage text over 8192 bytes is dropped whole.
         *
         * @param text the serialized carrier
         * @return the carrier
         * @throws O11yException with {@link O11yException.ErrorCode#INVALID_CARRIER} when the text
         *     is longer than {@link #MAX_CARRIER_BYTES}, is not a query string, or holds no valid
         *     W3C traceparent
         */
        public static Carrier unmarshal(String text) {
            if (text == null || text.isEmpty()) {
                return EMPTY;
            }
            int bytes = text.getBytes(StandardCharsets.UTF_8).length;
            if (bytes > MAX_CARRIER_BYTES) {
                throw invalid(bytes + " bytes exceeds the " + MAX_CARRIER_BYTES + " byte limit");
            }
            Map<String, String> values = parseQuery(text);
            SpanContext sc = parseTraceparent(
                    values.getOrDefault(TRACEPARENT, ""), values.getOrDefault(TRACESTATE, ""));
            if (!sc.isValid()) {
                throw invalid("no valid traceparent");
            }
            return newCarrier(sc, validBaggage(values.getOrDefault(BAGGAGE, "")));
        }

        /** Returns {@link #marshal()}, which includes the captured baggage values. */
        @Override
        public String toString() {
            return marshal();
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Carrier c
                    && traceparent.equals(c.traceparent)
                    && tracestate.equals(c.tracestate)
                    && baggage.equals(c.baggage);
        }

        @Override
        public int hashCode() {
            return Objects.hash(traceparent, tracestate, baggage);
        }
    }

    /**
     * The span {@link #startLinked} started, with the scope that made its context current. Closing
     * it closes the scope and ends the span.
     *
     * @param span the detached work's span
     * @param scope the scope holding the span and the restored baggage
     */
    public record LinkedSpan(Span span, Scope scope) implements AutoCloseable {
        @Override
        public void close() {
            try {
                scope.close();
            } finally {
                span.end();
            }
        }
    }

    private static final TextMapSetter<Map<String, String>> MAP_SETTER = (carrier, key, value) -> {
        if (carrier != null && key != null && value != null) {
            carrier.put(key, value);
        }
    };

    /**
     * Captures the trace context of {@link Context#current()}.
     *
     * @param telemetry the SDK whose propagator injects the baggage
     * @return the carrier, empty when the context holds no valid span context
     */
    public static Carrier capture(Telemetry telemetry) {
        return capture(telemetry, Context.current());
    }

    /**
     * Captures the trace context of {@code context}. The baggage is what the SDK's propagator
     * injects, so it has passed the baggage egress filter. When the serialized form would exceed
     * {@link #MAX_CARRIER_BYTES} the carrier drops the tracestate, and then the baggage, and keeps
     * the link. Capture never fails.
     *
     * @param telemetry the SDK whose propagator injects the baggage
     * @param context the context to capture, or null for the current context
     * @return the carrier, empty when the context holds no valid span context
     */
    public static Carrier capture(Telemetry telemetry, Context context) {
        Context ctx = context == null ? Context.current() : context;
        SpanContext sc = Span.fromContext(ctx).getSpanContext();
        if (!sc.isValid()) {
            return Carrier.EMPTY;
        }
        Map<String, String> out = new HashMap<>();
        telemetry.propagators().getTextMapPropagator().inject(ctx, out, MAP_SETTER);
        return newCarrier(sc, goBaggage(out.getOrDefault(BAGGAGE, "")));
    }

    /**
     * Starts the span for detached work under {@link Context#current()}.
     *
     * @param telemetry the SDK whose tracer starts the span
     * @param spanName the span name
     * @param carrier the captured operation, or null
     * @return the started span and the scope that made it current
     * @see #startLinked(Telemetry, Context, String, Carrier)
     */
    public static LinkedSpan startLinked(Telemetry telemetry, String spanName, Carrier carrier) {
        return startLinked(telemetry, Context.current(), spanName, carrier);
    }

    /**
     * Starts the span for detached work: a new root span with one link to the operation captured
     * in {@code carrier}. The carrier's baggage members are added to the baggage in {@code
     * context}, replacing members with the same key, with the W3C limits Go applies. The new
     * span and the merged baggage are made current until the returned value is closed. The empty
     * carrier starts an unlinked root span.
     *
     * @param telemetry the SDK whose tracer starts the span, under libo11y's own instrumentation
     *     scope {@code libo11y}, as Go starts it under its library scope
     * @param context the context whose baggage the work keeps, or null for the current context
     * @param spanName the span name
     * @param carrier the captured operation, or null
     * @return the started span and the scope that made it current
     */
    public static LinkedSpan startLinked(Telemetry telemetry, Context context, String spanName, Carrier carrier) {
        return startLinked(context, telemetry.tracer("libo11y"), spanName, carrier);
    }

    /**
     * {@link #startLinked(Telemetry, Context, String, Carrier)} under {@link Context#current()}
     * with a caller-chosen tracer.
     *
     * @param telemetry unused, kept for symmetry with the other overloads
     * @param tracer the tracer that starts the span
     * @param spanName the span name
     * @param carrier the captured operation, or null
     * @return the started span and the scope that made it current
     */
    public static LinkedSpan startLinked(Telemetry telemetry, Tracer tracer, String spanName, Carrier carrier) {
        return startLinked(Context.current(), tracer, spanName, carrier);
    }

    private static LinkedSpan startLinked(Context context, Tracer tracer, String spanName, Carrier carrier) {
        Carrier c = carrier == null ? Carrier.EMPTY : carrier;
        Context base = restoreBaggage(context == null ? Context.current() : context, c.baggage);
        SpanBuilder builder = tracer.spanBuilder(spanName).setNoParent();
        SpanContext linked = c.spanContext();
        if (linked.isValid()) {
            builder.addLink(linked);
        }
        Span span = builder.startSpan();
        return new LinkedSpan(span, base.with(span).makeCurrent());
    }

    private static O11yException invalid(String detail) {
        return new O11yException(O11yException.ErrorCode.INVALID_CARRIER, "invalid detached carrier: " + detail);
    }

    // ---- carrier construction (Go newCarrier) ----

    private static Carrier newCarrier(SpanContext sc, String bag) {
        String traceparent = "00-" + sc.getTraceId() + "-" + sc.getSpanId() + "-"
                + String.format(java.util.Locale.ROOT, "%02x", sc.getTraceFlags().asByte() & 0x03);
        StringBuilder ts = new StringBuilder();
        sc.getTraceState().forEach((k, v) -> {
            if (ts.length() > 0) {
                ts.append(',');
            }
            ts.append(k).append('=').append(v);
        });
        Carrier c = new Carrier(traceparent, ts.toString(), bag);
        if (c.marshal().length() > MAX_CARRIER_BYTES) {
            c = new Carrier(c.traceparent, "", c.baggage);
        }
        if (c.marshal().length() > MAX_CARRIER_BYTES) {
            c = new Carrier(c.traceparent, "", "");
        }
        return c;
    }

    // ---- traceparent and tracestate (Go propagation.TraceContext extract) ----

    private static SpanContext parseTraceparent(String traceparent, String tracestate) {
        String[] rest = {traceparent};
        String ver = cut(rest);
        if (!isLowerHex(ver, 2)) {
            return SpanContext.getInvalid();
        }
        int version = Integer.parseInt(ver, 16);
        if (version > 254) {
            return SpanContext.getInvalid();
        }
        String traceId = cut(rest);
        String spanId = cut(rest);
        String flags = cut(rest);
        if (!isLowerHex(traceId, 32) || !isLowerHex(spanId, 16) || !isLowerHex(flags, 2)) {
            return SpanContext.getInvalid();
        }
        int opts = Integer.parseInt(flags, 16);
        if (version == 0 && (!rest[0].isEmpty() || opts > 3)) {
            return SpanContext.getInvalid();
        }
        SpanContext sc = SpanContext.createFromRemoteParent(
                traceId, spanId, TraceFlags.fromByte((byte) (opts & 0x03)), parseTraceState(tracestate));
        return sc.isValid() ? sc : SpanContext.getInvalid();
    }

    /** Go's strings.Cut on "-": returns the part before it and leaves what follows, empty when none does. */
    private static String cut(String[] rest) {
        String s = rest[0];
        int i = s.indexOf('-');
        if (i < 0) {
            rest[0] = "";
            return s;
        }
        rest[0] = s.substring(i + 1);
        return s.substring(0, i);
    }

    private static boolean isLowerHex(String s, int n) {
        if (s.length() != n) {
            return false;
        }
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    /** Go's trace.ParseTraceState: any invalid member, duplicate or overflow drops the whole state. */
    private static TraceState parseTraceState(String ts) {
        if (ts.isEmpty()) {
            return TraceState.getDefault();
        }
        List<String[]> members = new ArrayList<>();
        Set<String> found = new HashSet<>();
        for (String raw : ts.split(",", -1)) {
            if (raw.isEmpty()) {
                continue;
            }
            int eq = raw.indexOf('=');
            if (eq < 0) {
                return TraceState.getDefault();
            }
            String key = trimLeftOws(raw.substring(0, eq));
            String value = trimRightOws(raw.substring(eq + 1));
            if (!traceStateKey(key) || !traceStateValue(value) || !found.add(key)) {
                return TraceState.getDefault();
            }
            members.add(new String[] {key, value});
            if (members.size() > 32) {
                return TraceState.getDefault();
            }
        }
        // The builder puts each new key in front, so build from the last member to keep the order.
        TraceStateBuilder b = TraceState.builder();
        for (int i = members.size() - 1; i >= 0; i--) {
            b.put(members.get(i)[0], members.get(i)[1]);
        }
        return b.build();
    }

    private static String trimLeftOws(String s) {
        int i = 0;
        while (i < s.length() && (s.charAt(i) == ' ' || s.charAt(i) == '\t')) {
            i++;
        }
        return s.substring(i);
    }

    private static String trimRightOws(String s) {
        int i = s.length();
        while (i > 0 && (s.charAt(i - 1) == ' ' || s.charAt(i - 1) == '\t')) {
            i--;
        }
        return s.substring(0, i);
    }

    private static boolean traceStateKey(String key) {
        int at = key.indexOf('@');
        if (at < 0) {
            return traceStateKeyPart(key, 255, false);
        }
        return traceStateKeyPart(key.substring(0, at), 240, true) && traceStateKeyPart(key.substring(at + 1), 13, false);
    }

    private static boolean traceStateKeyPart(String key, int maxRest, boolean tenant) {
        if (key.isEmpty() || key.length() - 1 > maxRest) {
            return false;
        }
        char first = key.charAt(0);
        boolean firstOk = (first >= 'a' && first <= 'z') || (tenant && first >= '0' && first <= '9');
        if (!firstOk) {
            return false;
        }
        for (int i = 1; i < key.length(); i++) {
            char c = key.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '*' || c == '/')) {
                return false;
            }
        }
        return true;
    }

    private static boolean traceStateValue(String v) {
        int n = v.length();
        if (n == 0 || n > 256) {
            return false;
        }
        for (int i = 0; i < n; i++) {
            char c = v.charAt(i);
            int lo = i == n - 1 ? 0x21 : 0x20;
            if (c < lo || c > 0x7e || c == ',' || c == '=') {
                return false;
            }
        }
        return true;
    }

    // ---- query strings (Go net/url QueryEscape and ParseQuery) ----

    private static final char[] UPPER_HEX = "0123456789ABCDEF".toCharArray();

    private static void queryEscape(String s, StringBuilder out) {
        for (byte raw : s.getBytes(StandardCharsets.UTF_8)) {
            int b = raw & 0xff;
            if ((b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
                    || b == '-' || b == '_' || b == '.' || b == '~') {
                out.append((char) b);
            } else if (b == ' ') {
                out.append('+');
            } else {
                out.append('%').append(UPPER_HEX[b >> 4]).append(UPPER_HEX[b & 0x0f]);
            }
        }
    }

    /** Go's url.ParseQuery followed by Values.Get: the first value of each key wins, and any error fails. */
    private static Map<String, String> parseQuery(String query) {
        int params = 1;
        for (int i = 0; i < query.length(); i++) {
            if (query.charAt(i) == '&') {
                params++;
            }
        }
        if (params > 10_000) {
            throw invalid("number of URL query parameters exceeded limit");
        }
        Map<String, String> values = new LinkedHashMap<>();
        for (String part : query.split("&", -1)) {
            if (part.indexOf(';') >= 0) {
                throw invalid("invalid semicolon separator in query");
            }
            if (part.isEmpty()) {
                continue;
            }
            int eq = part.indexOf('=');
            String key = unescape(eq < 0 ? part : part.substring(0, eq), true);
            String value = unescape(eq < 0 ? "" : part.substring(eq + 1), true);
            if (key == null || value == null) {
                throw invalid("invalid URL escape in query");
            }
            values.putIfAbsent(key, value);
        }
        return values;
    }

    /**
     * Go's url.QueryUnescape (plus as space) or url.PathUnescape (plus kept). Returns null on a
     * malformed escape. Invalid UTF-8 decodes to U+FFFD.
     */
    private static String unescape(String s, boolean plusIsSpace) {
        if (s.indexOf('%') < 0 && (!plusIsSpace || s.indexOf('+') < 0)) {
            return s;
        }
        byte[] in = s.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length);
        for (int i = 0; i < in.length; i++) {
            byte b = in[i];
            if (b == '%') {
                if (i + 2 >= in.length || hexValue(in[i + 1]) < 0 || hexValue(in[i + 2]) < 0) {
                    return null;
                }
                out.write(hexValue(in[i + 1]) << 4 | hexValue(in[i + 2]));
                i += 2;
            } else if (b == '+' && plusIsSpace) {
                out.write(' ');
            } else {
                out.write(b);
            }
        }
        return out.toString(StandardCharsets.UTF_8);
    }

    private static int hexValue(byte b) {
        if (b >= '0' && b <= '9') {
            return b - '0';
        }
        if (b >= 'a' && b <= 'f') {
            return b - 'a' + 10;
        }
        if (b >= 'A' && b <= 'F') {
            return b - 'A' + 10;
        }
        return -1;
    }

    // ---- W3C baggage (Go go.opentelemetry.io/otel/baggage Parse) ----

    private static final int MAX_BAGGAGE_MEMBERS = 64;
    private static final int MAX_BAGGAGE_BYTES = 8192;

    /** One parsed baggage member: its key, decoded value, raw metadata and Go's String() form. */
    private record Member(String key, String value, String metadata) {
        String render() {
            StringBuilder sb = new StringBuilder(key).append('=');
            for (byte raw : value.getBytes(StandardCharsets.UTF_8)) {
                int c = raw & 0xff;
                if (c == '%' || !isValueChar(c)) {
                    sb.append('%').append(UPPER_HEX[c >> 4]).append(UPPER_HEX[c & 0x0f]);
                } else {
                    sb.append((char) c);
                }
            }
            if (!metadata.isEmpty()) {
                sb.append(';').append(metadata);
            }
            return sb.toString();
        }
    }

    /** What Go's baggage.Parse keeps, by key, and whether it reported an error. */
    private record Parsed(Map<String, Member> members, boolean failed) {}

    private static Parsed parseBaggage(String bag) {
        Map<String, Member> members = new LinkedHashMap<>();
        if (bag.isEmpty()) {
            return new Parsed(members, false);
        }
        if (bag.getBytes(StandardCharsets.UTF_8).length > MAX_BAGGAGE_BYTES) {
            return new Parsed(members, true);
        }
        boolean failed = false;
        Map<String, Integer> sizes = new HashMap<>();
        int total = 0;
        for (String raw : bag.split(",", -1)) {
            if (members.size() >= MAX_BAGGAGE_MEMBERS) {
                failed = true;
                break;
            }
            Member m = parseMember(raw);
            if (m == null) {
                failed = true;
                continue;
            }
            boolean existing = members.containsKey(m.key());
            int bytes = m.render().length() + (!existing && !members.isEmpty() ? 1 : 0);
            Integer old = sizes.get(m.key());
            int next = old == null ? total + bytes : total - old + bytes;
            if (next > MAX_BAGGAGE_BYTES) {
                failed = true;
                break;
            }
            members.put(m.key(), m);
            sizes.put(m.key(), bytes);
            total = next;
        }
        return new Parsed(members, failed);
    }

    private static Member parseMember(String member) {
        String keyValue = member;
        String metadata = "";
        int semi = member.indexOf(';');
        if (semi >= 0) {
            keyValue = member.substring(0, semi);
            String raw = member.substring(semi + 1);
            for (String prop : raw.split(";", -1)) {
                if (!prop.isEmpty() && !validProperty(prop)) {
                    return null;
                }
            }
            metadata = normalizeMetadata(raw);
        }
        int eq = keyValue.indexOf('=');
        if (eq < 0) {
            return null;
        }
        String key = goTrimSpace(keyValue.substring(0, eq));
        if (key.isEmpty() || !key.chars().allMatch(Detached::isKeyChar)) {
            return null;
        }
        String rawValue = goTrimSpace(keyValue.substring(eq + 1));
        if (!rawValue.chars().allMatch(Detached::isValueChar)) {
            return null;
        }
        String value = unescape(rawValue, false);
        if (value == null) {
            return null;
        }
        return new Member(key, value, metadata);
    }

    /** Go's parsePropertyFields: key [OWS "=" OWS value] OWS, with valid percent-encoding. */
    private static boolean validProperty(String s) {
        int i = skipOws(s, 0);
        int keyStart = i;
        while (i < s.length() && isKeyChar(s.charAt(i))) {
            i++;
        }
        if (i == keyStart) {
            return false;
        }
        i = skipOws(s, i);
        if (i == s.length()) {
            return true;
        }
        if (s.charAt(i) != '=') {
            return false;
        }
        i = skipOws(s, i + 1);
        int valueStart = i;
        while (i < s.length() && isValueChar(s.charAt(i))) {
            i++;
        }
        String value = s.substring(valueStart, i);
        if (skipOws(s, i) != s.length()) {
            return false;
        }
        for (int j = 0; j < value.length(); j++) {
            if (value.charAt(j) == '%') {
                if (j + 2 >= value.length()
                        || hexValue((byte) value.charAt(j + 1)) < 0
                        || hexValue((byte) value.charAt(j + 2)) < 0) {
                    return false;
                }
                j += 2;
            }
        }
        return true;
    }

    private static String normalizeMetadata(String metadata) {
        if (metadata.isEmpty()
                || (metadata.charAt(0) != ';' && metadata.charAt(metadata.length() - 1) != ';'
                        && !metadata.contains(";;"))) {
            return metadata;
        }
        StringBuilder sb = new StringBuilder();
        for (String p : metadata.split(";", -1)) {
            if (!p.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append(';');
                }
                sb.append(p);
            }
        }
        return sb.toString();
    }

    private static int skipOws(String s, int i) {
        while (i < s.length() && (s.charAt(i) == ' ' || s.charAt(i) == '\t')) {
            i++;
        }
        return i;
    }

    /** Go's strings.TrimSpace: Unicode White_Space at both ends. */
    private static String goTrimSpace(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isGoSpace(s.charAt(start))) {
            start++;
        }
        while (end > start && isGoSpace(s.charAt(end - 1))) {
            end--;
        }
        return s.substring(start, end);
    }

    private static boolean isGoSpace(char c) {
        return (c >= '\t' && c <= '\r') || c == 0x85 || Character.isSpaceChar(c);
    }

    /** RFC 7230 token characters, Go's safeKeyCharset. */
    private static boolean isKeyChar(int c) {
        if (c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
            return true;
        }
        return c < 0x80 && "!#$%&'*+-.^_`|~".indexOf(c) >= 0;
    }

    /** W3C baggage-octet, Go's safeValueCharset. */
    private static boolean isValueChar(int c) {
        return c == 0x21 || (c >= 0x23 && c <= 0x2b) || (c >= 0x2d && c <= 0x3a)
                || (c >= 0x3c && c <= 0x5b) || (c >= 0x5d && c <= 0x7e);
    }

    /** Go's validBaggage: the raw members Parse keeps, in their original order, once each. */
    private static String validBaggage(String bag) {
        Parsed parsed = parseBaggage(bag);
        if (!parsed.failed()) {
            return bag;
        }
        if (parsed.members().isEmpty()) {
            return "";
        }
        List<String> kept = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String raw : bag.split(",", -1)) {
            Parsed one = parseBaggage(raw);
            if (one.failed() || one.members().size() != 1) {
                continue;
            }
            Member m = one.members().values().iterator().next();
            Member winner = parsed.members().get(m.key());
            if (seen.contains(m.key()) || winner == null || !winner.render().equals(m.render())) {
                continue;
            }
            seen.add(m.key());
            kept.add(raw);
        }
        return String.join(",", kept);
    }

    /**
     * Renders injected baggage the way Go's propagator writes it, member by member in the
     * injected order, so a carrier captured here carries Go's bytes. Members that do not parse
     * are dropped.
     */
    private static String goBaggage(String injected) {
        if (injected.isEmpty()) {
            return "";
        }
        List<String> out = new ArrayList<>();
        for (String raw : injected.split(",", -1)) {
            Member m = parseMember(raw);
            if (m != null) {
                out.add(m.render());
            }
        }
        return String.join(",", out);
    }

    /** Go's restoreBaggage: the members Parse keeps, set on top of the baggage in context. */
    private static Context restoreBaggage(Context context, String bag) {
        if (bag.isEmpty()) {
            return context;
        }
        Parsed parsed = parseBaggage(bag);
        if (parsed.members().isEmpty()) {
            return context;
        }
        BaggageBuilder merged = Baggage.fromContext(context).toBuilder();
        for (Member m : parsed.members().values()) {
            merged.put(m.key(), m.value(), BaggageEntryMetadata.create(m.metadata()));
        }
        return context.with(merged.build());
    }
}
