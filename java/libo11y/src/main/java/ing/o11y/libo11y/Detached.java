package ing.o11y.libo11y;

import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Detached work propagation (queues, jobs, async workers) using serializable carriers
 * bounded to 32 KiB with egress-filtered baggage and linked root spans.
 */
public final class Detached {
    public static final int MAX_CARRIER_BYTES = 32 * 1024;

    private Detached() {}

    public static final class Carrier {
        private final Map<String, String> headers;

        public Carrier(Map<String, String> headers) {
            this.headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
        }

        public Map<String, String> headers() {
            return headers;
        }

        public boolean isEmpty() {
            return headers.isEmpty();
        }

        /** Serializes the carrier as newline-delimited {@code key=value} text (<= 32 KiB). */
        public String marshal() {
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, String> e : headers.entrySet()) {
                if (e.getKey().contains("\n") || e.getKey().contains("=") || e.getValue().contains("\n")) {
                    continue;
                }
                if (sb.length() > 0) {
                    sb.append('\n');
                }
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
            String out = sb.toString();
            if (out.getBytes(StandardCharsets.UTF_8).length > MAX_CARRIER_BYTES) {
                throw new O11yException(
                        O11yException.ErrorCode.INVALID_OPTION,
                        "detached carrier exceeds " + MAX_CARRIER_BYTES + " bytes");
            }
            return out;
        }

        public static Carrier unmarshal(String text) {
            if (text == null || text.isEmpty()) {
                return new Carrier(Map.of());
            }
            if (text.getBytes(StandardCharsets.UTF_8).length > MAX_CARRIER_BYTES) {
                throw new O11yException(
                        O11yException.ErrorCode.INVALID_OPTION,
                        "detached carrier exceeds " + MAX_CARRIER_BYTES + " bytes");
            }
            Map<String, String> map = new LinkedHashMap<>();
            for (String line : text.split("\n")) {
                if (line.isEmpty()) {
                    continue;
                }
                int eq = line.indexOf('=');
                if (eq > 0) {
                    map.put(line.substring(0, eq), line.substring(eq + 1));
                }
            }
            return new Carrier(map);
        }
    }

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

    private static final TextMapGetter<Map<String, String>> MAP_GETTER = new TextMapGetter<>() {
        @Override
        @SuppressWarnings("deprecation")
        public Iterable<String> keys(Map<String, String> carrier) {
            return carrier == null ? java.util.List.of() : carrier.keySet();
        }

        @Override
        public String get(Map<String, String> carrier, String key) {
            if (carrier == null || key == null) {
                return null;
            }
            String exact = carrier.get(key);
            if (exact != null) {
                return exact;
            }
            for (Map.Entry<String, String> e : carrier.entrySet()) {
                if (e.getKey().equalsIgnoreCase(key)) {
                    return e.getValue();
                }
            }
            return null;
        }
    };

    public static Carrier capture(Telemetry telemetry) {
        return capture(telemetry, Context.current());
    }

    public static Carrier capture(Telemetry telemetry, Context context) {
        Map<String, String> map = new LinkedHashMap<>();
        telemetry.propagators().getTextMapPropagator().inject(
                context == null ? Context.current() : context, map, MAP_SETTER);
        Carrier carrier = new Carrier(map);
        carrier.marshal(); // enforce 32 KiB limit
        return carrier;
    }

    public static LinkedSpan startLinked(Telemetry telemetry, String spanName, Carrier carrier) {
        return startLinked(telemetry, telemetry.tracer("libo11y.detached"), spanName, carrier);
    }

    public static LinkedSpan startLinked(Telemetry telemetry, Tracer tracer, String spanName, Carrier carrier) {
        Context extracted = Context.root();
        if (carrier != null && !carrier.isEmpty()) {
            extracted = telemetry.propagators().getTextMapPropagator()
                    .extract(Context.root(), carrier.headers(), MAP_GETTER);
        }
        SpanContext linked = Span.fromContext(extracted).getSpanContext();
        Baggage baggage = Baggage.fromContext(extracted);

        var builder = tracer.spanBuilder(spanName).setNoParent();
        if (linked.isValid()) {
            builder.addLink(linked);
        }
        Span span = builder.startSpan();
        Context newCtx = Context.root().with(baggage).with(span);
        return new LinkedSpan(span, newCtx.makeCurrent());
    }
}
