package ing.o11y.libo11y;

import ing.o11y.libo11y.internal.PiiTokenizer;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.reflect.AccessibleObject;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Capture-time protection for sensitive values in logs.
 *
 * <p>Three protections exist, from weakest to strictest:
 *
 * <ul>
 *   <li>mask: a run of {@code X} with one {@code X} per Unicode code point, keeping only the
 *       value's length;
 *   <li>redact: the literal {@value #REDACTED};
 *   <li>omit: the field is absent.
 * </ul>
 *
 * <p>{@link Secret} and {@link Masked} protect a single value wherever it is formatted. {@link
 * #scrub(Object)} applies the protections declared with {@link O11yRedact} on record components
 * and fields, with the strictest protection in scope winning through nesting. {@link
 * StructuredLogger} scrubs every attribute value it receives.
 */
public final class Redact {
    /** The literal that replaces redacted values. */
    public static final String REDACTED = "REDACTED";

    /**
     * The deepest level {@link #scrub(Object)} walks below the root, which is level 0. Anything
     * deeper renders as {@value #REDACTED}.
     */
    public static final int MAX_DEPTH = 32;

    private Redact() {}

    /**
     * Protection declared by {@link O11yRedact}. {@link #CONFIDENTIAL} and {@link #SECRET} are the
     * specification's classification words: confidential masks and secret redacts.
     */
    public enum Mode {
        /** Renders the value as a same-length run of {@code X}. */
        MASK,
        /** Renders the value as {@value Redact#REDACTED}. */
        REDACT,
        /** Leaves the field out entirely. */
        OMIT,
        /** A synonym for {@link #MASK}. */
        CONFIDENTIAL,
        /** A synonym for {@link #REDACT}. */
        SECRET
    }

    /**
     * Marks a record component or field for capture-time protection by {@link Redact#scrub(Object)}
     * and therefore by {@link StructuredLogger}.
     *
     * <p>The annotation protects the value only on the paths that scrub it. A record's generated
     * {@code toString()}, and any {@code toString()} a class writes itself, still print the raw
     * component values: a library cannot change them. Hold a value that must never be printed in
     * a {@link Secret} or {@link Masked}, whose own {@code toString()} is protected, or override
     * {@code toString()}.
     */
    @Retention(RetentionPolicy.RUNTIME)
    @Target({ElementType.FIELD, ElementType.RECORD_COMPONENT})
    public @interface O11yRedact {
        /** The protection to apply. */
        Mode value() default Mode.REDACT;
    }

    /**
     * Wraps a value that must never appear in telemetry. It renders as {@value Redact#REDACTED}
     * through {@code toString()}, so through string concatenation, {@code String.format} and every
     * logging framework. It is deliberately not {@link java.io.Serializable}, so Java
     * serialization cannot write the wrapped value. Read the value with {@link #expose()}.
     *
     * @param <T> the wrapped type
     */
    public static final class Secret<T> {
        private final T value;

        /**
         * Wraps {@code value}.
         *
         * @param value the secret value
         */
        public Secret(T value) {
            this.value = value;
        }

        /**
         * Wraps {@code value}.
         *
         * @param value the secret value
         * @param <T> the wrapped type
         * @return the wrapper
         */
        public static <T> Secret<T> of(T value) {
            return new Secret<>(value);
        }

        /**
         * Returns the wrapped value. The deliberate name keeps every read easy to audit.
         *
         * @return the wrapped value
         */
        public T expose() {
            return value;
        }

        /** Returns {@value Redact#REDACTED}. */
        @Override
        public String toString() {
            return REDACTED;
        }
    }

    /**
     * Wraps a value that renders as a run of {@code X} with one {@code X} per code point of its
     * text, keeping only its length. Like {@link Secret} it is protected through {@code
     * toString()} and is not {@link java.io.Serializable}. Read the value with {@link #expose()}.
     *
     * @param <T> the wrapped type
     */
    public static final class Masked<T> {
        private final T value;

        /**
         * Wraps {@code value}.
         *
         * @param value the value to mask
         */
        public Masked(T value) {
            this.value = value;
        }

        /**
         * Wraps {@code value}.
         *
         * @param value the value to mask
         * @param <T> the wrapped type
         * @return the wrapper
         */
        public static <T> Masked<T> of(T value) {
            return new Masked<>(value);
        }

        /**
         * Returns the wrapped value.
         *
         * @return the wrapped value
         */
        public T expose() {
            return value;
        }

        /** Returns the masked text: empty for a null value. */
        @Override
        public String toString() {
            return value == null ? "" : maskValue(value);
        }
    }

    /**
     * Masks {@code s} as a run of {@code X} with one {@code X} per Unicode code point, so the empty
     * string and null mask to the empty string.
     *
     * @param s the text to mask
     * @return the masked text
     */
    public static String mask(String s) {
        if (s == null) {
            return "";
        }
        return "X".repeat(s.codePointCount(0, s.length()));
    }

    /**
     * Returns a log-safe form of {@code value} with every protection applied.
     *
     * <p>{@link Secret} renders {@value #REDACTED} and {@link Masked} renders masked. Records
     * render as a map of their components, and other classes that carry an {@link O11yRedact}
     * annotation anywhere in their fields, inherited fields included, or that hold a type that
     * does, render as a map of their fields. Each component or field takes the strictest of its
     * own protection and the protection in scope, so the fields of a record inside a masked field
     * are masked at minimum. Protection follows values into maps, iterables and arrays.
     *
     * <p>Under no protection, strings, numbers, booleans, characters, enums, byte arrays and other
     * primitive arrays are returned unchanged, so every input the sensitivity policy tokenizes
     * keeps its token. Maps become maps with string keys, and iterables and object arrays become
     * lists. Under a mask, a map becomes a map keyed by sorted position, each entry holding the
     * masked key and the protected value, so masked keys cannot collide. Any other value renders
     * as its {@code toString()}, masked under a mask.
     *
     * <p>Scrubbing never throws. A cycle, a value deeper than {@link #MAX_DEPTH}, a component or
     * field it cannot read (such as one in a package the module does not open), and a method that
     * throws while it is walked all render {@value #REDACTED}.
     *
     * @param value the value to protect
     * @return the protected form
     */
    public static Object scrub(Object value) {
        return new Walk().protect(value, Level.PASSTHROUGH, 0);
    }

    /** Protection levels, ordered so the stricter level compares greater and wins through nesting. */
    private enum Level {
        PASSTHROUGH,
        MASK,
        REDACT,
        OMIT;

        static Level of(O11yRedact ann) {
            if (ann == null) {
                return PASSTHROUGH;
            }
            return switch (ann.value()) {
                case MASK, CONFIDENTIAL -> MASK;
                case REDACT, SECRET -> REDACT;
                case OMIT -> OMIT;
            };
        }

        Level max(Level other) {
            return compareTo(other) >= 0 ? this : other;
        }
    }

    private static final class Walk {
        private final Set<Object> active = Collections.newSetFromMap(new IdentityHashMap<>());

        Object protect(Object value, Level floor, int depth) {
            if (floor.compareTo(Level.REDACT) >= 0 || depth > MAX_DEPTH) {
                return REDACTED;
            }
            if (value == null) {
                return null;
            }
            try {
                return protectNonNull(value, floor, depth);
            } catch (RuntimeException e) {
                // A user method (toString, an accessor, an iterator) threw while it was walked.
                // Redaction must never throw into the caller's log call: fail closed.
                return REDACTED;
            }
        }

        private Object protectNonNull(Object value, Level floor, int depth) {
            if (value instanceof Secret<?>) {
                return REDACTED;
            }
            if (value instanceof Masked<?> m) {
                return m.toString();
            }
            if (isScalar(value)) {
                return floor == Level.MASK ? maskValue(value) : value;
            }
            Class<?> cls = value.getClass();
            if (cls.isArray() && cls.getComponentType().isPrimitive() && floor == Level.PASSTHROUGH) {
                return value;
            }
            if (!active.add(value)) {
                return REDACTED; // a cycle
            }
            try {
                if (value instanceof Map<?, ?> map) {
                    return protectMap(map, floor, depth);
                }
                if (value instanceof Iterable<?> iter) {
                    List<Object> out = new ArrayList<>();
                    for (Object el : iter) {
                        out.add(protect(el, floor, depth + 1));
                    }
                    return out;
                }
                if (cls.isArray()) {
                    int n = Array.getLength(value);
                    List<Object> out = new ArrayList<>(n);
                    for (int i = 0; i < n; i++) {
                        out.add(protect(Array.get(value, i), floor, depth + 1));
                    }
                    return out;
                }
                if (cls.isRecord()) {
                    return protectRecord(value, cls, floor, depth);
                }
                if (mayCarryProtection(cls)) {
                    return protectFields(value, cls, floor, depth);
                }
            } finally {
                active.remove(value);
            }
            String text = value.toString();
            return floor == Level.MASK && !REDACTED.equals(text) ? mask(text) : text;
        }

        /**
         * Renders a map as Go does. Entries are keyed by their key text, in the map's own order.
         * Under a mask, or when a key renders REDACTED or two keys render the same text, entries
         * are instead keyed by sorted position and each holds the protected key and value, so
         * protected keys cannot collide.
         */
        private Map<String, Object> protectMap(Map<?, ?> map, Level floor, int depth) {
            List<KeyedValue> entries = new ArrayList<>(map.size());
            Set<String> texts = new HashSet<>();
            boolean positional = floor == Level.MASK;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                Object key = e.getKey();
                boolean redacted = key != null && mayCarryProtection(key.getClass());
                String text = redacted ? REDACTED : String.valueOf(key);
                positional = positional || redacted || !texts.add(text);
                entries.add(new KeyedValue(text, redacted, e.getValue()));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            if (!positional) {
                for (KeyedValue e : entries) {
                    out.put(e.text(), protect(e.value(), floor, depth + 1));
                }
                return out;
            }
            entries.sort(Comparator.comparing(KeyedValue::text, Redact::compareUtf8));
            for (int i = 0; i < entries.size(); i++) {
                KeyedValue e = entries.get(i);
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("key", floor == Level.MASK && !e.redacted() ? mask(e.text()) : e.text());
                entry.put("value", protect(e.value(), floor, depth + 1));
                out.put(Integer.toString(i), entry);
            }
            return out;
        }

        private Map<String, Object> protectRecord(Object value, Class<?> cls, Level floor, int depth) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (RecordComponent comp : cls.getRecordComponents()) {
                Level effective = floor.max(Level.of(comp.getAnnotation(O11yRedact.class)));
                if (effective == Level.OMIT) {
                    continue;
                }
                out.put(comp.getName(), read(comp.getAccessor(), value, effective, depth));
            }
            return out;
        }

        private Map<String, Object> protectFields(Object value, Class<?> cls, Level floor, int depth) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Field f : instanceFields(cls)) {
                Level effective = floor.max(Level.of(f.getAnnotation(O11yRedact.class)));
                if (effective == Level.OMIT || out.containsKey(f.getName())) {
                    // A shadowed superclass field keeps the subclass field's name and is left out.
                    continue;
                }
                out.put(f.getName(), read(f, value, effective, depth));
            }
            return out;
        }

        /** Reads a component or field, failing closed to REDACTED when it cannot be read. */
        private Object read(AccessibleObject member, Object target, Level effective, int depth) {
            if (effective.compareTo(Level.REDACT) >= 0) {
                return REDACTED; // never read what is redacted anyway
            }
            Object v;
            try {
                member.setAccessible(true);
                v = member instanceof Method m ? m.invoke(target) : ((Field) member).get(target);
            } catch (ReflectiveOperationException | RuntimeException e) {
                // InaccessibleObjectException (a package the module does not open), a
                // SecurityException, or an accessor that threw: fail closed.
                return REDACTED;
            }
            return protect(v, effective, depth + 1);
        }
    }

    private record KeyedValue(String text, boolean redacted, Object value) {}

    private static boolean isScalar(Object value) {
        return value instanceof String
                || value instanceof Number
                || value instanceof Boolean
                || value instanceof Character
                || value instanceof Enum<?>;
    }

    /** Masks a value's text, rendering floats the way Go does so the mask has Go's length. */
    static String maskValue(Object value) {
        if (value instanceof Double d) {
            return mask(PiiTokenizer.canonicalFloat(d));
        }
        if (value instanceof Float f) {
            return mask(PiiTokenizer.canonicalFloat(f.doubleValue()));
        }
        return mask(String.valueOf(value));
    }

    private static int compareUtf8(String a, String b) {
        // Code point order is UTF-8 byte order.
        int i = 0;
        int j = 0;
        while (i < a.length() && j < b.length()) {
            int ca = a.codePointAt(i);
            int cb = b.codePointAt(j);
            if (ca != cb) {
                return Integer.compare(ca, cb);
            }
            i += Character.charCount(ca);
            j += Character.charCount(cb);
        }
        return Integer.compare(a.length() - i, b.length() - j);
    }

    /** Non-static, non-synthetic fields of {@code cls} and its superclasses, subclass first. */
    private static List<Field> instanceFields(Class<?> cls) {
        List<Field> out = new ArrayList<>();
        for (Class<?> c = cls; c != null && c != Object.class; c = c.getSuperclass()) {
            if (isPlatformClass(c)) {
                break; // platform classes carry no annotations; their private state is not walked
            }
            for (Field f : c.getDeclaredFields()) {
                if (!Modifier.isStatic(f.getModifiers()) && !f.isSynthetic()) {
                    out.add(f);
                }
            }
        }
        return out;
    }

    private static boolean isPlatformClass(Class<?> c) {
        String name = c.getName();
        return name.startsWith("java.") || name.startsWith("javax.") || name.startsWith("jdk.")
                || name.startsWith("sun.") || name.startsWith("com.sun.");
    }

    private static final ClassValue<Boolean> MAY_CARRY = new ClassValue<>() {
        @Override
        protected Boolean computeValue(Class<?> type) {
            return scanType(type, new HashSet<>(), 0);
        }
    };

    /**
     * Reports whether a value of {@code cls} could hold something {@link #scrub(Object)} must
     * protect: an {@link O11yRedact} annotation on any field or component reachable through its
     * declared field types (generic arguments and array components included), or a {@link Secret}
     * or {@link Masked}. Platform types count as clean. Scans deeper than {@link #MAX_DEPTH} fail
     * closed.
     */
    static boolean mayCarryProtection(Class<?> cls) {
        return MAY_CARRY.get(cls);
    }

    private static boolean scanType(Type type, Set<Type> seen, int depth) {
        if (depth > MAX_DEPTH) {
            return true;
        }
        if (!seen.add(type)) {
            return false;
        }
        if (type instanceof ParameterizedType p) {
            if (scanType(p.getRawType(), seen, depth + 1)) {
                return true;
            }
            for (Type arg : p.getActualTypeArguments()) {
                if (scanType(arg, seen, depth + 1)) {
                    return true;
                }
            }
            return false;
        }
        if (type instanceof GenericArrayType g) {
            return scanType(g.getGenericComponentType(), seen, depth + 1);
        }
        if (type instanceof WildcardType w) {
            for (Type b : w.getUpperBounds()) {
                if (scanType(b, seen, depth + 1)) {
                    return true;
                }
            }
            return false;
        }
        if (type instanceof TypeVariable<?> v) {
            for (Type b : v.getBounds()) {
                if (scanType(b, seen, depth + 1)) {
                    return true;
                }
            }
            return false;
        }
        if (!(type instanceof Class<?> c)) {
            return false;
        }
        if (c == Secret.class || c == Masked.class) {
            return true;
        }
        if (c.isArray()) {
            return scanType(c.getComponentType(), seen, depth + 1);
        }
        if (c.isPrimitive() || isPlatformClass(c)) {
            return false;
        }
        if (c.isRecord()) {
            for (RecordComponent comp : c.getRecordComponents()) {
                if (comp.isAnnotationPresent(O11yRedact.class)
                        || scanType(comp.getGenericType(), seen, depth + 1)) {
                    return true;
                }
            }
            return false;
        }
        for (Field f : instanceFields(c)) {
            if (f.isAnnotationPresent(O11yRedact.class) || scanType(f.getGenericType(), seen, depth + 1)) {
                return true;
            }
        }
        return false;
    }
}
