package ing.o11y.libo11y;

import ing.o11y.libo11y.internal.SensitivityPolicy;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.logs.LogRecordBuilder;
import io.opentelemetry.api.logs.Logger;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.context.Context;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Consumer;

/**
 * Structured logger emitting correlated JSON console records, OTLP log records,
 * and optional extra sinks through a single {@link SensitivityPolicy}.
 */
public final class StructuredLogger {
    public record LogEntry(
            Instant timestamp,
            Severity severity,
            String message,
            String eventName,
            String traceId,
            String spanId,
            String traceFlags,
            Map<String, Object> attributes) {}

    private final Logger otelLogger;
    private final SensitivityPolicy policy;
    private final Severity minLevel;
    private final boolean consoleEnabled;
    private final OutputStream consoleOutput;
    private final BiFunction<String, Object, Object> attrReplacer;
    private final List<Consumer<LogEntry>> extraSinks;
    private final Map<String, Object> boundAttrs;

    StructuredLogger(
            Logger otelLogger,
            SensitivityPolicy policy,
            Severity minLevel,
            boolean consoleEnabled,
            OutputStream consoleOutput,
            BiFunction<String, Object, Object> attrReplacer,
            List<Consumer<LogEntry>> extraSinks,
            Map<String, Object> boundAttrs) {
        this.otelLogger = otelLogger;
        this.policy = policy;
        this.minLevel = minLevel == null ? Severity.INFO : minLevel;
        this.consoleEnabled = consoleEnabled;
        this.consoleOutput = consoleOutput;
        this.attrReplacer = attrReplacer;
        this.extraSinks = extraSinks == null ? List.of() : List.copyOf(extraSinks);
        this.boundAttrs = boundAttrs == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(boundAttrs));
    }

    public StructuredLogger with(Map<String, Object> attrs) {
        Map<String, Object> merged = new LinkedHashMap<>(boundAttrs);
        if (attrs != null) {
            merged.putAll(attrs);
        }
        return new StructuredLogger(
                otelLogger, policy, minLevel, consoleEnabled, consoleOutput, attrReplacer, extraSinks, merged);
    }

    public StructuredLogger with(String key, Object value) {
        Map<String, Object> merged = new LinkedHashMap<>(boundAttrs);
        merged.put(key, value);
        return new StructuredLogger(
                otelLogger, policy, minLevel, consoleEnabled, consoleOutput, attrReplacer, extraSinks, merged);
    }

    public void debug(String message) {
        log(Severity.DEBUG, message, Map.of());
    }

    public void debug(String message, Map<String, Object> attrs) {
        log(Severity.DEBUG, message, attrs);
    }

    public void info(String message) {
        log(Severity.INFO, message, Map.of());
    }

    public void info(String message, Map<String, Object> attrs) {
        log(Severity.INFO, message, attrs);
    }

    public void warn(String message) {
        log(Severity.WARN, message, Map.of());
    }

    public void warn(String message, Map<String, Object> attrs) {
        log(Severity.WARN, message, attrs);
    }

    public void error(String message) {
        log(Severity.ERROR, message, Map.of());
    }

    public void error(String message, Map<String, Object> attrs) {
        log(Severity.ERROR, message, attrs);
    }

    public void event(String eventName, Map<String, Object> attrs) {
        emit(Context.current(), Severity.INFO, eventName, eventName, attrs, false);
    }

    public void log(Severity severity, String message, Map<String, Object> attrs) {
        emit(Context.current(), severity, message, null, attrs, false);
    }

    public void emit(
            Context context,
            Severity severity,
            String message,
            String eventName,
            Map<String, Object> attrs,
            boolean bypassLevelGate) {
        Context ctx = context == null ? Context.current() : context;
        boolean forced = bypassLevelGate || ForceEmit.isForced(ctx);
        if (!forced && severity.getSeverityNumber() < minLevel.getSeverityNumber()) {
            return;
        }

        Map<String, Object> merged = new LinkedHashMap<>(boundAttrs);
        if (attrs != null) {
            merged.putAll(attrs);
        }
        if (eventName != null && !eventName.isEmpty()) {
            merged.put(Spec.EVENT_NAME_KEY, eventName);
        }

        // Scrub capture-time @O11yRedact / Secret / Masked objects first
        Map<String, Object> scrubbed = new LinkedHashMap<>(merged.size());
        for (Map.Entry<String, Object> e : merged.entrySet()) {
            Object val = Redact.scrub(e.getValue());
            if (attrReplacer != null) {
                val = attrReplacer.apply(e.getKey(), val);
            }
            if (val != null) {
                scrubbed.put(e.getKey(), val);
            }
        }

        // Single SensitivityPolicy pass (counts violations once per emitted record)
        Map<String, Object> clean = policy.classifyLogMap(scrubbed, true);

        SpanContext sc = Span.fromContext(ctx).getSpanContext();
        String traceId = sc.isValid() ? sc.getTraceId() : "";
        String spanId = sc.isValid() ? sc.getSpanId() : "";
        String traceFlags = sc.isValid() ? sc.getTraceFlags().asHex() : "";

        Instant now = Instant.now();
        LogEntry entry = new LogEntry(
                now,
                severity,
                message == null ? "" : message,
                eventName,
                traceId,
                spanId,
                traceFlags,
                Collections.unmodifiableMap(clean));

        // 1. Console JSON leg
        if (consoleEnabled && consoleOutput != null) {
            byte[] line = (formatJson(entry) + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (consoleOutput) {
                try {
                    consoleOutput.write(line);
                    consoleOutput.flush();
                } catch (IOException ex) {
                    if (bypassLevelGate) {
                        throw new O11yException(O11yException.ErrorCode.CANARY_REJECTED,
                                "console sink rejected startup canary: " + ex.getMessage(), ex);
                    }
                }
            }
        }

        // 2. Extra sinks
        for (Consumer<LogEntry> sink : extraSinks) {
            sink.accept(entry);
        }

        // 3. OTLP log leg
        if (otelLogger != null) {
            LogRecordBuilder builder = otelLogger.logRecordBuilder()
                    .setTimestamp(now)
                    .setSeverity(severity)
                    .setSeverityText(severity.name())
                    .setBody(entry.message())
                    .setContext(ctx);
            if (eventName != null && !eventName.isEmpty()) {
                builder.setEventName(eventName);
            }
            AttributesBuilder ab = Attributes.builder();
            flattenForOtel("", clean, ab);
            builder.setAllAttributes(ab.build());
            builder.emit();
        }
    }

    private static void flattenForOtel(String prefix, Map<String, Object> map, AttributesBuilder ab) {
        for (Map.Entry<String, Object> e : map.entrySet()) {
            String key = prefix.isEmpty() ? e.getKey() : prefix + "." + e.getKey();
            Object v = e.getValue();
            if (v == null) {
                continue;
            }
            if (v instanceof Map<?, ?> nested) {
                Map<String, Object> typed = new LinkedHashMap<>();
                nested.forEach((nk, nv) -> typed.put(String.valueOf(nk), nv));
                flattenForOtel(key, typed, ab);
            } else if (v instanceof Boolean b) {
                ab.put(AttributeKey.booleanKey(key), b);
            } else if (v instanceof Long l) {
                ab.put(AttributeKey.longKey(key), l);
            } else if (v instanceof Integer i) {
                ab.put(AttributeKey.longKey(key), i.longValue());
            } else if (v instanceof Double d) {
                ab.put(AttributeKey.doubleKey(key), d);
            } else if (v instanceof Float f) {
                ab.put(AttributeKey.doubleKey(key), f.doubleValue());
            } else if (v instanceof List<?> list) {
                List<String> strs = list.stream().map(String::valueOf).toList();
                ab.put(AttributeKey.stringArrayKey(key), strs);
            } else {
                ab.put(AttributeKey.stringKey(key), String.valueOf(v));
            }
        }
    }

    public static String formatJson(LogEntry entry) {
        StringBuilder sb = new StringBuilder(256);
        sb.append('{');
        appendField(sb, "time", entry.timestamp().toString(), false);
        appendField(sb, "level", entry.severity().name(), true);
        appendField(sb, "msg", entry.message(), true);
        if (!entry.traceId().isEmpty()) {
            appendField(sb, "trace_id", entry.traceId(), true);
            appendField(sb, "span_id", entry.spanId(), true);
            appendField(sb, "trace_flags", entry.traceFlags(), true);
        }
        for (Map.Entry<String, Object> e : entry.attributes().entrySet()) {
            sb.append(',');
            appendJsonString(sb, e.getKey());
            sb.append(':');
            appendJsonValue(sb, e.getValue());
        }
        sb.append('}');
        return sb.toString();
    }

    private static void appendField(StringBuilder sb, String key, String val, boolean comma) {
        if (comma) {
            sb.append(',');
        }
        appendJsonString(sb, key);
        sb.append(':');
        appendJsonString(sb, val);
    }

    private static void appendJsonValue(StringBuilder sb, Object val) {
        if (val == null) {
            sb.append("null");
        } else if (val instanceof Boolean b) {
            sb.append(b ? "true" : "false");
        } else if (val instanceof Integer || val instanceof Long || val instanceof Short || val instanceof Byte) {
            sb.append(val);
        } else if (val instanceof Double d) {
            if (Double.isFinite(d)) {
                sb.append(d);
            } else {
                appendJsonString(sb, d.toString());
            }
        } else if (val instanceof Float f) {
            if (Float.isFinite(f)) {
                sb.append(f);
            } else {
                appendJsonString(sb, f.toString());
            }
        } else if (val instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                appendJsonString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                appendJsonValue(sb, e.getValue());
            }
            sb.append('}');
        } else if (val instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object el : it) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                appendJsonValue(sb, el);
            }
            sb.append(']');
        } else {
            appendJsonString(sb, String.valueOf(val));
        }
    }

    private static void appendJsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }
}
