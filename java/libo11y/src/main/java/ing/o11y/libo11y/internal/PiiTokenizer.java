package ing.o11y.libo11y.internal;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collection;
import java.util.Collections;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Canonical PII rendering and HMAC-SHA256 tokenization matching conformance/vectors/pii-hash.json. */
public final class PiiTokenizer {
    public static final int MAX_COMPOSITE_DEPTH = 16;
    public static final int MAX_COMPOSITE_NODES = 2048;
    public static final String CANONICAL_TRUNCATED = "truncated";
    public static final int MIN_PII_HASH_KEY_LEN = 32;

    private PiiTokenizer() {}

    private static final class Walk {
        private int remaining = MAX_COMPOSITE_NODES;
        private final Set<Object> active = Collections.newSetFromMap(new IdentityHashMap<>());

        boolean spend() {
            if (remaining <= 0) {
                return false;
            }
            remaining--;
            return true;
        }

        boolean enter(Object obj) {
            return active.add(obj);
        }

        void leave(Object obj) {
            active.remove(obj);
        }
    }

    private record Entry(byte[] utf8Key, String key, Object val) {}

    private record ObjPair(String key, Object value) {}

    public static String canonicalFloat(double value) {
        if (Double.isNaN(value)) {
            return "NaN";
        }
        if (value == Double.POSITIVE_INFINITY) {
            return "+Inf";
        }
        if (value == Double.NEGATIVE_INFINITY) {
            return "-Inf";
        }
        if (value == 0.0) {
            return Double.doubleToRawLongBits(value) < 0 ? "-0" : "0";
        }

        boolean neg = value < 0;
        double absVal = neg ? -value : value;
        String s = Double.toString(absVal);

        String mant;
        int exp;
        int eIdx = s.indexOf('E');
        if (eIdx == -1) {
            eIdx = s.indexOf('e');
        }
        if (eIdx != -1) {
            mant = s.substring(0, eIdx);
            exp = Integer.parseInt(s.substring(eIdx + 1));
        } else {
            mant = s;
            exp = 0;
        }

        String digits;
        int dotIdx = mant.indexOf('.');
        if (dotIdx != -1) {
            String intPart = mant.substring(0, dotIdx);
            String fracPart = mant.substring(dotIdx + 1);
            String digitsRaw = intPart + fracPart;
            int firstNonZero = 0;
            while (firstNonZero < digitsRaw.length() && digitsRaw.charAt(firstNonZero) == '0') {
                firstNonZero++;
            }
            String stripped = digitsRaw.substring(firstNonZero);
            if ("0".equals(intPart)) {
                exp -= firstNonZero;
            } else {
                exp += intPart.length() - 1;
            }
            digits = trimTrailingZeros(stripped);
        } else {
            exp += mant.length() - 1;
            digits = trimTrailingZeros(mant);
        }

        if (digits.isEmpty()) {
            return neg ? "-0" : "0";
        }
        if (digits.length() == 2) {
            // Double.toString never prints fewer than two significant digits, so a value whose
            // shortest round-tripping form has one digit (Double.MIN_VALUE is 5e-324 in Go, 4.9E-324
            // in Java) gets one digit too many. Take the one-digit neighbour that reads back as the
            // same double, preferring the nearer one, as Go's shortest formatting does.
            BigDecimal shortest = oneDigitForm(absVal);
            if (shortest != null) {
                digits = shortest.unscaledValue().toString();
                exp = shortest.precision() - shortest.scale() - 1;
            }
        }

        String prefix = neg ? "-" : "";
        if (exp < -4 || exp >= 6) {
            String body = digits.length() == 1 ? digits : digits.charAt(0) + "." + digits.substring(1);
            String sign = exp >= 0 ? "+" : "-";
            int absExp = Math.abs(exp);
            String expFmt = absExp < 100 ? String.format(Locale.ROOT, "%02d", absExp) : Integer.toString(absExp);
            return prefix + body + "e" + sign + expFmt;
        }

        if (exp < 0) {
            return prefix + "0." + "0".repeat(-exp - 1) + digits;
        }
        if (exp + 1 >= digits.length()) {
            return prefix + digits + "0".repeat(exp + 1 - digits.length());
        }
        int split = exp + 1;
        return prefix + digits.substring(0, split) + "." + digits.substring(split);
    }

    /** Returns the nearer one-significant-digit decimal that parses back to value, or null. */
    private static BigDecimal oneDigitForm(double value) {
        BigDecimal exact = new BigDecimal(value);
        BigDecimal best = null;
        for (RoundingMode mode : new RoundingMode[] {RoundingMode.FLOOR, RoundingMode.CEILING}) {
            BigDecimal candidate = exact.round(new MathContext(1, mode)).stripTrailingZeros();
            if (candidate.signum() == 0 || Double.parseDouble(candidate.toString()) != value) {
                continue;
            }
            if (best == null
                    || candidate.subtract(exact).abs().compareTo(best.subtract(exact).abs()) < 0) {
                best = candidate;
            }
        }
        return best;
    }

    private static String trimTrailingZeros(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '0') {
            end--;
        }
        return s.substring(0, end);
    }

    private static String encodeJsonString(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '<' -> sb.append("\\u003c");
                case '>' -> sb.append("\\u003e");
                case '&' -> sb.append("\\u0026");
                case '\u2028' -> sb.append("\\u2028");
                case '\u2029' -> sb.append("\\u2029");
                default -> {
                    if (ch < 0x20) {
                        sb.append(String.format(Locale.ROOT, "\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static String renderJsonNode(Object node) {
        if (node instanceof String s) {
            return encodeJsonString(s);
        }
        if (node instanceof List<?> list) {
            if (!list.isEmpty() && list.get(0) instanceof ObjPair) {
                StringBuilder sb = new StringBuilder("{");
                for (int i = 0; i < list.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    ObjPair kv = (ObjPair) list.get(i);
                    sb.append(encodeJsonString(kv.key())).append(':').append(renderJsonNode(kv.value()));
                }
                return sb.append('}').toString();
            }
            if (list == EMPTY_OBJECT) {
                return "{}";
            }
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(renderJsonNode(list.get(i)));
            }
            return sb.append(']').toString();
        }
        return encodeJsonString(String.valueOf(node));
    }

    private static final List<ObjPair> EMPTY_OBJECT = Collections.unmodifiableList(new ArrayList<>(0));

    private static Object buildNode(Object value, int depth, Walk walk) {
        if (depth > MAX_COMPOSITE_DEPTH || !walk.spend()) {
            return CANONICAL_TRUNCATED;
        }
        if (value == null) {
            return "";
        }
        if (value instanceof Boolean b) {
            return b ? "true" : "false";
        }
        if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long
                || value instanceof BigInteger) {
            return value.toString();
        }
        if (value instanceof Float f) {
            return canonicalFloat(f.doubleValue());
        }
        if (value instanceof Double d) {
            return canonicalFloat(d);
        }
        if (value instanceof BigDecimal dec) {
            return dec.toString();
        }
        if (value instanceof String s) {
            return s;
        }
        if (value instanceof byte[] bytes) {
            return Base64.getEncoder().encodeToString(bytes);
        }
        if (value instanceof Map<?, ?> map) {
            if (!walk.enter(map)) {
                return CANONICAL_TRUNCATED;
            }
            try {
                if (map.isEmpty()) {
                    return EMPTY_OBJECT;
                }
                List<Entry> pairs = new ArrayList<>(map.size());
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    String ks = e.getKey() == null ? "" : String.valueOf(e.getKey());
                    pairs.add(new Entry(ks.getBytes(StandardCharsets.UTF_8), ks, e.getValue()));
                }
                pairs.sort((a, b) -> Arrays.compareUnsigned(a.utf8Key(), b.utf8Key()));
                List<ObjPair> out = new ArrayList<>(pairs.size());
                for (Entry e : pairs) {
                    out.add(new ObjPair(e.key(), buildNode(e.val(), depth + 1, walk)));
                }
                return out;
            } finally {
                walk.leave(map);
            }
        }
        if (value instanceof Collection<?> iter) {
            if (!walk.enter(iter)) {
                return CANONICAL_TRUNCATED;
            }
            try {
                List<Object> list = new ArrayList<>();
                for (Object el : iter) {
                    list.add(buildNode(el, depth + 1, walk));
                }
                return list;
            } finally {
                walk.leave(iter);
            }
        }
        if (value.getClass().isArray()) {
            if (!walk.enter(value)) {
                return CANONICAL_TRUNCATED;
            }
            try {
                int len = Array.getLength(value);
                List<Object> list = new ArrayList<>(len);
                for (int i = 0; i < len; i++) {
                    list.add(buildNode(Array.get(value, i), depth + 1, walk));
                }
                return list;
            } finally {
                walk.leave(value);
            }
        }
        return value.toString();
    }

    public static String canonicalValue(Object value) {
        Object node = buildNode(value, 0, new Walk());
        if (node instanceof String s) {
            return s;
        }
        return renderJsonNode(node);
    }

    public static String token(byte[] key, Object value) {
        String canonical = canonicalValue(value);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] digest = mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8));
            return "hmac-sha256:" + HexFormat.of().formatHex(digest, 0, 16);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("HMAC-SHA256 failed", ex);
        }
    }
}
