package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.AttributeType;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.common.KeyValue;
import io.opentelemetry.api.common.Value;
import io.opentelemetry.api.common.ValueType;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Applies the sensitivity policy to the attributes of an OpenTelemetry log record, the way Go's
 * {@code redactingLogProcessor} does. A classified key is dropped or tokenized as one value. A
 * {@link Value} attribute under an unclassified key is walked: map members are judged on their
 * dotted effective keys and array elements share their holder's key. The walk fails closed: a
 * composite at the depth bound is dropped whole, and once the node budget is spent the members not
 * yet examined are dropped. A map or array emptied by classification is dropped.
 */
final class LogAttributeClassifier {
    private LogAttributeClassifier() {}

    /** The node budget of one walk over one top-level attribute. */
    private static final class Walk {
        private int remaining = SensitivityPolicy.MAX_NODES;

        boolean spend() {
            if (remaining <= 0) {
                return false;
            }
            remaining--;
            return true;
        }
    }

    /**
     * Returns the classified attributes, or {@code null} when nothing in {@code raw} is classified, so
     * the caller can pass the record through untouched. Each drop is counted once on the policy's
     * violation counter.
     */
    static Attributes classify(Attributes raw, SensitivityPolicy policy) {
        if (raw == null || raw.isEmpty() || !mayNeedClassification(raw, policy)) {
            return null;
        }
        AttributesBuilder out = Attributes.builder();
        boolean[] changed = {false};
        raw.forEach((key, value) -> changed[0] |= putClassified(out, key, value, policy));
        return changed[0] ? out.build() : null;
    }

    private static boolean mayNeedClassification(Attributes raw, SensitivityPolicy policy) {
        for (AttributeKey<?> key : raw.asMap().keySet()) {
            if (key.getType() == AttributeType.VALUE || isClassified(policy, key.getKey())) {
                return true;
            }
        }
        return false;
    }

    private static boolean isClassified(SensitivityPolicy policy, String key) {
        SpecTables.Sensitivity sens = policy.sensitivityOf(key);
        return sens == SpecTables.Sensitivity.SECRET || sens == SpecTables.Sensitivity.PII;
    }

    private static boolean tokenizes(SensitivityPolicy policy, String key) {
        return policy.piiMode() == PiiMode.HASH && policy.sensitivityOf(key) == SpecTables.Sensitivity.PII;
    }

    /** Puts the classified form of one top-level attribute and reports whether it differs from the raw one. */
    private static boolean putClassified(AttributesBuilder out, AttributeKey<?> key, Object value, SensitivityPolicy policy) {
        String name = key.getKey();
        if (isClassified(policy, name)) {
            SensitivityPolicy.Decision d = policy.classifyScalar(name, plain(value, 0), Spec.Signal.LOGS, true);
            if (d.drop()) {
                return true;
            }
            if (tokenizes(policy, name)) {
                out.put(AttributeKey.stringKey(name), String.valueOf(d.value()));
                return true;
            }
            putRaw(out, key, value);
            return false;
        }
        if (value instanceof Value<?> v) {
            Value<?> walked = walk(name, v, 0, new Walk(), policy);
            if (walked != null) {
                out.put(AttributeKey.valueKey(name), walked);
            }
            return walked != v;
        }
        putRaw(out, key, value);
        return false;
    }

    @SuppressWarnings("unchecked")
    private static void putRaw(AttributesBuilder out, AttributeKey<?> key, Object value) {
        out.put((AttributeKey<Object>) key, value);
    }

    private static boolean isComposite(Value<?> v) {
        return v.getType() == ValueType.KEY_VALUE_LIST || v.getType() == ValueType.ARRAY;
    }

    /**
     * Classifies the members of {@code v}, held under the effective key {@code prefix}. Returns
     * {@code v} itself when nothing changed, {@code null} when the value is dropped, and a rebuilt
     * value otherwise.
     */
    @SuppressWarnings("unchecked")
    private static Value<?> walk(String prefix, Value<?> v, int depth, Walk walk, SensitivityPolicy policy) {
        if (!isComposite(v)) {
            return v;
        }
        if (depth >= SensitivityPolicy.MAX_DEPTH || !walk.spend()) {
            return null;
        }
        boolean changed = false;
        if (v.getType() == ValueType.KEY_VALUE_LIST) {
            List<KeyValue> members = (List<KeyValue>) v.getValue();
            List<KeyValue> kept = new ArrayList<>(members.size());
            for (KeyValue m : members) {
                if (!walk.spend()) {
                    changed = true;
                    break;
                }
                String key = prefix + "." + m.getKey();
                Value<?> mv = m.getValue();
                Value<?> out;
                if (isClassified(policy, key)) {
                    SensitivityPolicy.Decision d = policy.classifyScalar(key, plain(mv, 0), Spec.Signal.LOGS, true);
                    if (d.drop()) {
                        out = null;
                    } else if (tokenizes(policy, key)) {
                        out = Value.of(String.valueOf(d.value()));
                    } else {
                        out = mv;
                    }
                } else {
                    out = walk(key, mv, depth + 1, walk, policy);
                }
                if (out != mv) {
                    changed = true;
                }
                if (out != null) {
                    kept.add(out == mv ? m : KeyValue.of(m.getKey(), out));
                }
            }
            if (!changed) {
                return v;
            }
            return kept.isEmpty() ? null : Value.of(kept.toArray(new KeyValue[0]));
        }
        List<Value<?>> elements = (List<Value<?>>) v.getValue();
        List<Value<?>> kept = new ArrayList<>(elements.size());
        for (Value<?> e : elements) {
            if (isComposite(e) && !walk.spend()) {
                changed = true;
                break;
            }
            Value<?> out = walk(prefix, e, depth + 1, walk, policy);
            if (out != e) {
                changed = true;
            }
            if (out != null) {
                kept.add(out);
            }
        }
        if (!changed) {
            return v;
        }
        return kept.isEmpty() ? null : Value.of(kept);
    }

    /**
     * Renders an attribute value as the plain Java value {@link PiiTokenizer} canonicalizes, so a
     * token over an OpenTelemetry {@link Value} matches the token over the same value logged as a
     * Java map or list. Past the tokenizer's depth bound it yields the tokenizer's own truncation
     * marker.
     */
    @SuppressWarnings("unchecked")
    private static Object plain(Object value, int depth) {
        if (!(value instanceof Value<?> v)) {
            return value;
        }
        if (depth > PiiTokenizer.MAX_COMPOSITE_DEPTH) {
            return PiiTokenizer.CANONICAL_TRUNCATED;
        }
        return switch (v.getType()) {
            case STRING, BOOLEAN, LONG, DOUBLE -> v.getValue();
            case EMPTY -> null;
            case BYTES -> {
                ByteBuffer buf = ((ByteBuffer) v.getValue()).duplicate();
                byte[] bytes = new byte[buf.remaining()];
                buf.get(bytes);
                yield bytes;
            }
            case ARRAY -> {
                List<Value<?>> elements = (List<Value<?>>) v.getValue();
                List<Object> out = new ArrayList<>(elements.size());
                for (Value<?> e : elements) {
                    out.add(plain(e, depth + 1));
                }
                yield out;
            }
            case KEY_VALUE_LIST -> {
                List<KeyValue> members = (List<KeyValue>) v.getValue();
                Map<String, Object> out = new LinkedHashMap<>();
                for (KeyValue m : members) {
                    out.put(m.getKey(), plain(m.getValue(), depth + 1));
                }
                yield out;
            }
        };
    }
}
