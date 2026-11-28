package ing.o11y.libo11y;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Capture-time value and structure redaction guarding toString, JSON, and structured logs. */
public final class Redact {
    public static final String REDACTED = "[REDACTED]";
    public static final int MAX_DEPTH = 16;
    public static final int MAX_NODES = 2048;

    private Redact() {}

    public enum Mode {
        MASK,
        REDACT,
        OMIT,
        CONFIDENTIAL,
        SECRET
    }

    /** Marks a record component or field for capture-time redaction. */
    @Retention(RetentionPolicy.RUNTIME)
    @Target({ElementType.FIELD, ElementType.RECORD_COMPONENT})
    public @interface O11yRedact {
        Mode value() default Mode.REDACT;
    }

    /** Wrapper for secret values whose {@link #toString()} always renders {@code [REDACTED]}. */
    public static final class Secret<T> {
        private final T value;

        public Secret(T value) {
            this.value = value;
        }

        public static <T> Secret<T> of(T value) {
            return new Secret<>(value);
        }

        public T expose() {
            return value;
        }

        @Override
        public String toString() {
            return REDACTED;
        }
    }

    /** Wrapper for maskable values whose {@link #toString()} masks everything except the last 4 chars. */
    public static final class Masked<T> {
        private final T value;

        public Masked(T value) {
            this.value = value;
        }

        public static <T> Masked<T> of(T value) {
            return new Masked<>(value);
        }

        public T expose() {
            return value;
        }

        @Override
        public String toString() {
            return mask(value == null ? "" : value.toString());
        }
    }

    public static String mask(String s) {
        if (s == null || s.length() <= 4) {
            return "****";
        }
        return "****" + s.substring(s.length() - 4);
    }

    /**
     * Converts an object (including Java records/POJOs annotated with {@link O11yRedact},
     * {@link Secret}, {@link Masked}, Maps, and Collections) into a redacted log-safe representation.
     * Cycles, depth beyond 16, or budgets beyond 2048 nodes fail closed to {@code [REDACTED]}.
     */
    public static Object scrub(Object value) {
        return scrubWalk(value, 0, new Walk());
    }

    private static final class Walk {
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

    private static Object scrubWalk(Object value, int depth, Walk walk) {
        if (depth > MAX_DEPTH || !walk.spend()) {
            return REDACTED;
        }
        if (value == null) {
            return null;
        }
        if (value instanceof Secret<?>) {
            return REDACTED;
        }
        if (value instanceof Masked<?> m) {
            return m.toString();
        }
        if (value instanceof String
                || value instanceof Number
                || value instanceof Boolean
                || value instanceof Character
                || value instanceof Enum<?>) {
            return value;
        }
        if (value instanceof Map<?, ?> map) {
            if (!walk.active.add(map)) {
                return REDACTED;
            }
            try {
                Map<String, Object> out = new LinkedHashMap<>();
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    out.put(String.valueOf(e.getKey()), scrubWalk(e.getValue(), depth + 1, walk));
                }
                return out;
            } finally {
                walk.active.remove(map);
            }
        }
        if (value instanceof Iterable<?> iter) {
            if (!walk.active.add(iter)) {
                return REDACTED;
            }
            try {
                List<Object> out = new ArrayList<>();
                for (Object el : iter) {
                    out.add(scrubWalk(el, depth + 1, walk));
                }
                return out;
            } finally {
                walk.active.remove(iter);
            }
        }
        Class<?> cls = value.getClass();
        if (cls.isRecord()) {
            if (!walk.active.add(value)) {
                return REDACTED;
            }
            try {
                Map<String, Object> out = new LinkedHashMap<>();
                for (RecordComponent comp : cls.getRecordComponents()) {
                    O11yRedact ann = comp.getAnnotation(O11yRedact.class);
                    Object fieldVal;
                    try {
                        var accessor = comp.getAccessor();
                        accessor.setAccessible(true);
                        fieldVal = accessor.invoke(value);
                    } catch (ReflectiveOperationException ex) {
                        out.put(comp.getName(), REDACTED);
                        continue;
                    }
                    applyAnnotatedField(out, comp.getName(), fieldVal, ann, depth, walk);
                }
                return out;
            } finally {
                walk.active.remove(value);
            }
        }
        // Check for @O11yRedact fields on regular classes
        boolean hasAnnotated = false;
        for (Field f : cls.getDeclaredFields()) {
            if (!Modifier.isStatic(f.getModifiers()) && f.isAnnotationPresent(O11yRedact.class)) {
                hasAnnotated = true;
                break;
            }
        }
        if (hasAnnotated) {
            if (!walk.active.add(value)) {
                return REDACTED;
            }
            try {
                Map<String, Object> out = new LinkedHashMap<>();
                for (Field f : cls.getDeclaredFields()) {
                    if (Modifier.isStatic(f.getModifiers())) {
                        continue;
                    }
                    O11yRedact ann = f.getAnnotation(O11yRedact.class);
                    Object fieldVal;
                    try {
                        f.setAccessible(true);
                        fieldVal = f.get(value);
                    } catch (Exception ex) {
                        out.put(f.getName(), REDACTED);
                        continue;
                    }
                    applyAnnotatedField(out, f.getName(), fieldVal, ann, depth, walk);
                }
                return out;
            } finally {
                walk.active.remove(value);
            }
        }
        return value.toString();
    }

    private static void applyAnnotatedField(
            Map<String, Object> out,
            String name,
            Object fieldVal,
            O11yRedact ann,
            int depth,
            Walk walk) {
        if (ann == null) {
            out.put(name, scrubWalk(fieldVal, depth + 1, walk));
            return;
        }
        switch (ann.value()) {
            case OMIT -> {
                // intentionally omitted
            }
            case MASK -> out.put(name, mask(fieldVal == null ? "" : fieldVal.toString()));
            case REDACT, CONFIDENTIAL, SECRET -> out.put(name, REDACTED);
        }
    }
}
