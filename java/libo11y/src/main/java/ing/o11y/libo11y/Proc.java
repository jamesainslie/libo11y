package ing.o11y.libo11y;

import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Child-process ({@code TRACEPARENT}/{@code TRACESTATE}, never baggage) and
 * framed-socket trace propagation without depending on process globals.
 */
public final class Proc {
    private static final W3CTraceContextPropagator TRACE_ONLY = W3CTraceContextPropagator.getInstance();

    private Proc() {}

    private static final TextMapSetter<Map<String, String>> ENV_SETTER = (carrier, key, value) -> {
        if (carrier != null && key != null && value != null) {
            String upper = key.toUpperCase(Locale.ROOT);
            if ("TRACEPARENT".equals(upper) || "TRACESTATE".equals(upper)) {
                carrier.put(upper, value);
            }
        }
    };

    private static final TextMapGetter<Map<String, String>> ENV_GETTER = new TextMapGetter<>() {
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
            String upper = key.toUpperCase(Locale.ROOT);
            if ("TRACEPARENT".equals(upper) || "TRACESTATE".equals(upper)) {
                return carrier.get(upper);
            }
            return null;
        }
    };

    private static final TextMapSetter<Map<String, String>> FRAME_SETTER = (carrier, key, value) -> {
        if (carrier != null && key != null && value != null) {
            carrier.put(key, value);
        }
    };

    private static final TextMapGetter<Map<String, String>> FRAME_GETTER = new TextMapGetter<>() {
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
            String v = carrier.get(key);
            if (v != null) {
                return v;
            }
            for (Map.Entry<String, String> e : carrier.entrySet()) {
                if (e.getKey().equalsIgnoreCase(key)) {
                    return e.getValue();
                }
            }
            return null;
        }
    };

    /** Returns {@code TRACEPARENT} and optional {@code TRACESTATE} environment entries (never baggage). */
    public static Map<String, String> envEntries(Context context) {
        Map<String, String> out = new LinkedHashMap<>();
        TRACE_ONLY.inject(context == null ? Context.current() : context, out, ENV_SETTER);
        return Collections.unmodifiableMap(out);
    }

    /** Injects {@code TRACEPARENT}/{@code TRACESTATE} into a mutable environment map (e.g. ProcessBuilder.environment()). */
    public static void injectEnv(Context context, Map<String, String> env) {
        env.remove("TRACEPARENT");
        env.remove("TRACESTATE");
        env.putAll(envEntries(context));
    }

    /** Extracts trace context from {@code TRACEPARENT}/{@code TRACESTATE} environment variables. */
    public static Context extractEnv(Map<String, String> env) {
        return TRACE_ONLY.extract(Context.root(), env, ENV_GETTER);
    }

    /** Injects trace and egress-filtered baggage headers into a framed-socket header map using the given Telemetry. */
    public static Map<String, String> injectFrame(Telemetry telemetry, Context context) {
        Map<String, String> frame = new LinkedHashMap<>();
        telemetry.propagators().getTextMapPropagator().inject(
                context == null ? Context.current() : context, frame, FRAME_SETTER);
        return Collections.unmodifiableMap(frame);
    }

    /** Extracts trace and baggage context from a framed-socket header map using the given Telemetry. */
    public static Context extractFrame(Telemetry telemetry, Map<String, String> frame) {
        return telemetry.propagators().getTextMapPropagator().extract(Context.root(), frame, FRAME_GETTER);
    }
}
