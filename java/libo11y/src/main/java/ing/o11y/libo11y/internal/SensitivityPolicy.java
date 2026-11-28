package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.O11yException;
import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.spec.AppRegistryValidator;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.LongCounter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/** Key-based sensitivity classifier shared across resource, traces, metrics, and logs. */
public final class SensitivityPolicy {
    public static final int MAX_DEPTH = 16;
    public static final int MAX_NODES = 2048;

    private static final AttributeKey<String> VIOLATION_KIND_KEY =
            AttributeKey.stringKey(Spec.Attributes.RULE);
    private static final AttributeKey<String> SIGNAL_KEY =
            AttributeKey.stringKey(Spec.Attributes.SIGNAL);
    private static final AttributeKey<String> ATTR_KEY =
            AttributeKey.stringKey("o11y.attribute.key");

    private final Map<String, SpecTables.Sensitivity> classes;
    private final PiiMode piiMode;
    private final byte[] piiHashKey;
    private final AtomicReference<LongCounter> violationCounter = new AtomicReference<>();

    public SensitivityPolicy(
            PiiMode piiMode,
            byte[] piiHashKey,
            List<AppRegistryValidator.CompiledAppRegistry> appRegistries) {
        this.piiMode = piiMode == null ? PiiMode.DROP : piiMode;
        if (this.piiMode == PiiMode.HASH) {
            if (piiHashKey == null || piiHashKey.length < PiiTokenizer.MIN_PII_HASH_KEY_LEN) {
                throw new O11yException(
                        O11yException.ErrorCode.PII_HASH_KEY,
                        "PII hash mode requires a piiHashKey of at least 32 bytes");
            }
            this.piiHashKey = piiHashKey.clone();
        } else {
            this.piiHashKey = null;
        }

        Map<String, SpecTables.Sensitivity> merged = new HashMap<>(SpecTables.SENSITIVITY_OF);
        if (appRegistries != null) {
            for (AppRegistryValidator.CompiledAppRegistry reg : appRegistries) {
                merged.putAll(reg.classes());
            }
        }
        this.classes = Collections.unmodifiableMap(merged);
    }

    public void attachViolationCounter(LongCounter counter) {
        this.violationCounter.set(counter);
    }

    public PiiMode piiMode() {
        return piiMode;
    }

    public SpecTables.Sensitivity sensitivityOf(String key) {
        return classes.getOrDefault(key, SpecTables.Sensitivity.INTERNAL);
    }

    public boolean isMetricDisallowed(String key) {
        SpecTables.Sensitivity sens = sensitivityOf(key);
        return sens == SpecTables.Sensitivity.SECRET || sens == SpecTables.Sensitivity.PII;
    }

    private void recordViolation(String kind, String signal, String key) {
        LongCounter counter = violationCounter.get();
        if (counter == null) {
            return;
        }
        counter.add(1L, Attributes.of(VIOLATION_KIND_KEY, kind, SIGNAL_KEY, signal, ATTR_KEY, key));
    }

    public record Decision(boolean drop, Object value) {
        static final Decision DROP = new Decision(true, null);

        static Decision keep(Object value) {
            return new Decision(false, value);
        }
    }

    public Decision classifyScalar(String key, Object value, String signal, boolean countViolation) {
        SpecTables.Sensitivity sens = sensitivityOf(key);
        if (sens == SpecTables.Sensitivity.SECRET) {
            if (countViolation && signal != null) {
                recordViolation("secret_dropped", signal, key);
            }
            return Decision.DROP;
        }
        if (sens == SpecTables.Sensitivity.PII) {
            if (Spec.Signal.METRICS.equals(signal)) {
                return Decision.DROP;
            }
            return switch (piiMode) {
                case DROP -> {
                    if (countViolation && signal != null) {
                        recordViolation("pii_dropped", signal, key);
                    }
                    yield Decision.DROP;
                }
                case HASH -> Decision.keep(PiiTokenizer.token(piiHashKey, value));
                case KEEP -> Decision.keep(value);
            };
        }
        return Decision.keep(value);
    }

    /** Classifies an OpenTelemetry Attributes bag for spans, events, links, logs, or resource. */
    public Attributes classifyAttributes(Attributes attrs, String signal, boolean countViolation) {
        if (attrs == null || attrs.isEmpty()) {
            return Attributes.empty();
        }
        AttributesBuilder builder = Attributes.builder();
        attrs.forEach((key, val) -> {
            String k = key.getKey();
            Decision d = classifyScalar(k, val, signal, countViolation);
            if (!d.drop()) {
                putTyped(builder, key, d.value());
            }
        });
        return builder.build();
    }

    /** Classifies metric measurement attributes (always drops SECRET and PII, never counts). */
    public Attributes classifyMetricAttributes(Attributes attrs) {
        if (attrs == null || attrs.isEmpty()) {
            return Attributes.empty();
        }
        AttributesBuilder builder = Attributes.builder();
        attrs.forEach((key, val) -> {
            if (!isMetricDisallowed(key.getKey())) {
                putTyped(builder, key, val);
            }
        });
        return builder.build();
    }

    @SuppressWarnings("unchecked")
    private static void putTyped(AttributesBuilder builder, AttributeKey<?> key, Object value) {
        if (value == null) {
            return;
        }
        if (value instanceof String s && key.getType() != io.opentelemetry.api.common.AttributeType.STRING) {
            // PII HASH mode converts non-string values to "hmac-sha256:..." string tokens.
            builder.put(AttributeKey.stringKey(key.getKey()), s);
            return;
        }
        builder.put((AttributeKey<Object>) key, value);
    }

    /**
     * Classifies a structured-log attribute map, walking nested Maps/Collections on dotted keys
     * with cycle detection, depth cap (16), and node budget (2048).
     */
    public Map<String, Object> classifyLogMap(Map<String, Object> raw, boolean countViolation) {
        if (raw == null || raw.isEmpty()) {
            return Map.of();
        }
        LogWalk walk = new LogWalk();
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : raw.entrySet()) {
            String k = entry.getKey();
            if (k == null || k.isEmpty()) {
                continue;
            }
            Object v = classifyLogValue(k, entry.getValue(), 0, walk, countViolation);
            if (v != DROPPED_SENTINEL) {
                out.put(k, v);
            }
        }
        return out;
    }

    private static final Object DROPPED_SENTINEL = new Object();

    private static final class LogWalk {
        int remaining = MAX_NODES;
        final Set<Object> active = Collections.newSetFromMap(new IdentityHashMap<>());

        boolean spend() {
            if (remaining <= 0) {
                return false;
            }
            remaining--;
            return true;
        }
    }

    private Object classifyLogValue(
            String dottedKey,
            Object value,
            int depth,
            LogWalk walk,
            boolean countViolation) {
        if (depth > MAX_DEPTH || !walk.spend()) {
            return DROPPED_SENTINEL;
        }
        Decision top = classifyScalar(dottedKey, value, Spec.Signal.LOGS, countViolation);
        if (top.drop()) {
            return DROPPED_SENTINEL;
        }
        if (top.value() != value) {
            // Tokenized to hmac-sha256:... string
            return top.value();
        }
        if (value instanceof Map<?, ?> map) {
            if (!walk.active.add(map)) {
                return DROPPED_SENTINEL;
            }
            try {
                Map<String, Object> nested = new LinkedHashMap<>();
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    String childKey = String.valueOf(e.getKey());
                    String full = dottedKey + "." + childKey;
                    Object cv = classifyLogValue(full, e.getValue(), depth + 1, walk, countViolation);
                    if (cv != DROPPED_SENTINEL) {
                        nested.put(childKey, cv);
                    }
                }
                return nested;
            } finally {
                walk.active.remove(map);
            }
        }
        if (value instanceof Iterable<?> iter) {
            if (!walk.active.add(iter)) {
                return DROPPED_SENTINEL;
            }
            try {
                List<Object> nested = new ArrayList<>();
                for (Object el : iter) {
                    Object cv = classifyLogValue(dottedKey, el, depth + 1, walk, countViolation);
                    if (cv != DROPPED_SENTINEL) {
                        nested.add(cv);
                    }
                }
                return nested;
            } finally {
                walk.active.remove(iter);
            }
        }
        return value;
    }
}
