package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.O11yException;
import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.spec.AppRegistryValidator;
import ing.o11y.libo11y.spec.GoQuote;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.LongCounter;
import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.Collection;
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

    private static final AttributeKey<String> RULE_KEY =
            AttributeKey.stringKey(Spec.Attributes.RULE);
    private static final AttributeKey<String> SIGNAL_KEY =
            AttributeKey.stringKey(Spec.Attributes.SIGNAL);

    /** Rule counted when a secret-classified attribute is dropped. */
    public static final String RULE_SECRET_ATTRIBUTE = "secret_attribute";
    /** Rule counted when a PII-classified attribute is dropped or tokenized. */
    public static final String RULE_PII_ATTRIBUTE = "pii_attribute";

    private final Map<String, SpecTables.Sensitivity> classes;
    private final PiiMode piiMode;
    private final byte[] piiHashKey;
    /** Shared with every {@link #silent()} copy; a silent copy never reads it. */
    private final AtomicReference<LongCounter> violationCounter;
    private final boolean counting;

    /**
     * Builds the policy. Each application registry must declare its own namespace: two
     * registries that declare one namespace fail with {@code INVALID_APP_REGISTRY}, so a later
     * registry cannot reclassify the keys of an earlier one.
     */
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
            Map<String, String> declaredBy = new HashMap<>();
            for (AppRegistryValidator.CompiledAppRegistry reg : appRegistries) {
                String first = declaredBy.putIfAbsent(reg.namespace(), reg.source());
                if (first != null) {
                    throw new O11yException(
                            O11yException.ErrorCode.INVALID_APP_REGISTRY,
                            "o11y: invalid application registry: " + first + " and " + reg.source()
                                    + " both declare namespace " + GoQuote.quote(reg.namespace()));
                }
                // Registry namespaces are disjoint from the specification's (the validator
                // refuses o11y, otel and every semconv namespace), so a spec class wins.
                reg.classes().forEach(merged::putIfAbsent);
            }
        }
        this.classes = Collections.unmodifiableMap(merged);
        this.violationCounter = new AtomicReference<>();
        this.counting = true;
    }

    private SensitivityPolicy(SensitivityPolicy base) {
        this.classes = base.classes;
        this.piiMode = base.piiMode;
        this.piiHashKey = base.piiHashKey;
        this.violationCounter = base.violationCounter;
        this.counting = false;
    }

    /**
     * Returns a copy that makes the same decisions but records no violations. It serves a second
     * redaction of data another wrapper already counts, so one attribute is one violation.
     */
    public SensitivityPolicy silent() {
        return counting ? new SensitivityPolicy(this) : this;
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

    /**
     * Reports whether a metric attribute under key must be removed: secret always, PII unless the
     * mode is {@link PiiMode#KEEP}. Hash mode drops PII on metrics, because a token per value would
     * multiply series cardinality. Metric-side removals are never counted.
     */
    public boolean isMetricDisallowed(String key) {
        return switch (sensitivityOf(key)) {
            case SECRET -> true;
            case PII -> piiMode != PiiMode.KEEP;
            default -> false;
        };
    }

    /** Counts n violations of rule on signal, once the violation counter is attached. */
    public void recordViolations(String signal, String rule, long n) {
        if (!counting || n <= 0) {
            return;
        }
        LongCounter counter = violationCounter.get();
        if (counter == null) {
            return;
        }
        counter.add(n, Attributes.of(SIGNAL_KEY, signal, RULE_KEY, rule));
    }

    /** Names the violation rule for an attribute of the given class that was dropped or rewritten. */
    public static String ruleFor(SpecTables.Sensitivity sens) {
        return sens == SpecTables.Sensitivity.SECRET ? RULE_SECRET_ATTRIBUTE : RULE_PII_ATTRIBUTE;
    }

    public record Decision(boolean drop, Object value) {
        static final Decision DROP = new Decision(true, null);

        static Decision keep(Object value) {
            return new Decision(false, value);
        }
    }

    /**
     * Classifies one value. On logs, spans and the resource a secret is dropped and PII is dropped,
     * tokenized or kept per the mode, and each drop or rewrite is counted when countViolation is
     * set and signal is not null. On metrics the rule of {@link #isMetricDisallowed} applies and
     * nothing is counted.
     */
    public Decision classifyScalar(String key, Object value, String signal, boolean countViolation) {
        if (Spec.Signal.METRICS.equals(signal)) {
            return isMetricDisallowed(key) ? Decision.DROP : Decision.keep(value);
        }
        SpecTables.Sensitivity sens = sensitivityOf(key);
        Decision d;
        if (sens == SpecTables.Sensitivity.SECRET) {
            d = Decision.DROP;
        } else if (sens == SpecTables.Sensitivity.PII) {
            d = switch (piiMode) {
                case DROP -> Decision.DROP;
                case HASH -> Decision.keep(PiiTokenizer.token(piiHashKey, value));
                case KEEP -> Decision.keep(value);
            };
            if (piiMode == PiiMode.KEEP) {
                return d;
            }
        } else {
            return Decision.keep(value);
        }
        if (countViolation && signal != null) {
            recordViolations(signal, ruleFor(sens), 1L);
        }
        return d;
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

    /**
     * Classifies metric measurement attributes per {@link #isMetricDisallowed} and never counts.
     * Returns attrs itself when every attribute is kept, so the common path allocates nothing.
     */
    public Attributes classifyMetricAttributes(Attributes attrs) {
        if (attrs == null || attrs.isEmpty()) {
            return Attributes.empty();
        }
        boolean[] dropsAny = {false};
        attrs.forEach((key, val) -> dropsAny[0] |= isMetricDisallowed(key.getKey()));
        if (!dropsAny[0]) {
            return attrs;
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
        if (value instanceof Collection<?> coll) {
            return classifyLogSequence(dottedKey, coll, coll, depth, walk, countViolation);
        }
        if (value.getClass().isArray() && !(value instanceof byte[])) {
            int len = Array.getLength(value);
            List<Object> elements = new ArrayList<>(len);
            for (int i = 0; i < len; i++) {
                elements.add(Array.get(value, i));
            }
            return classifyLogSequence(dottedKey, value, elements, depth, walk, countViolation);
        }
        return value;
    }

    /** Walks the elements of a collection or array (identity), judging each on the parent key. */
    private Object classifyLogSequence(
            String dottedKey,
            Object identity,
            Iterable<?> elements,
            int depth,
            LogWalk walk,
            boolean countViolation) {
        if (!walk.active.add(identity)) {
            return DROPPED_SENTINEL;
        }
        try {
            List<Object> nested = new ArrayList<>();
            for (Object el : elements) {
                Object cv = classifyLogValue(dottedKey, el, depth + 1, walk, countViolation);
                if (cv != DROPPED_SENTINEL) {
                    nested.add(cv);
                }
            }
            return nested;
        } finally {
            walk.active.remove(identity);
        }
    }
}
