package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.Redact.Masked;
import ing.o11y.libo11y.Redact.Mode;
import ing.o11y.libo11y.Redact.O11yRedact;
import ing.o11y.libo11y.Redact.Secret;
import ing.o11y.libo11y.internal.PiiTokenizer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.NotSerializableException;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.lang.constant.ModuleDesc;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class RedactTest {

    // The reference is Go go/redact/redact.go.

    @Test
    void redactedLiteralIsTheContractLiteral() {
        assertEquals("REDACTED", Redact.REDACTED);
        assertEquals("REDACTED", Secret.of("hunter2").toString());
    }

    @Test
    void maskIsARunOfXOfEqualCodePointCount() {
        assertEquals("XXXXXXXXXXXXXXXXXXX", Redact.mask("4111-1111-1111-4242"));
        assertEquals("", Redact.mask(""));
        assertEquals("", Redact.mask(null));
        // Go counts runes: one X per code point, including a supplementary one.
        assertEquals("XXXXXX", Redact.mask("héllo😀"));
        assertEquals("XXXX", Masked.of("1234").toString());
        assertEquals("XXXXX", Masked.of(12345).toString());
        assertEquals("", Masked.of(null).toString());
    }

    @Test
    void secretAndMaskedAreGuardedOnEveryFormattingPath() {
        Secret<String> secret = Secret.of("hunter2");
        Masked<String> masked = Masked.of("4242");
        assertEquals("REDACTED|XXXX", String.format("%s|%s", secret, masked));
        assertEquals("  REDACTED", String.format("%10s", secret));
        assertEquals("REDACTED", String.valueOf(secret));
        assertEquals("pw=REDACTED", "pw=" + secret);
        assertEquals("[REDACTED, XXXX]", List.of(secret, masked).toString());
        assertEquals("hunter2", secret.expose());
        assertEquals("4242", masked.expose());
        // Java serialization would write the wrapped value, so neither wrapper is Serializable.
        assertFalse(Serializable.class.isAssignableFrom(Secret.class));
        assertFalse(Serializable.class.isAssignableFrom(Masked.class));
        assertThrows(NotSerializableException.class, () -> serialize(secret));
        assertThrows(NotSerializableException.class, () -> serialize(masked));
    }

    private static void serialize(Object value) throws IOException {
        try (ObjectOutputStream out = new ObjectOutputStream(new ByteArrayOutputStream())) {
            out.writeObject(value);
        }
    }

    record Tags(
            @O11yRedact(Mode.MASK) String masked,
            @O11yRedact(Mode.CONFIDENTIAL) String confidential,
            @O11yRedact(Mode.REDACT) String redacted,
            @O11yRedact(Mode.SECRET) String secret,
            @O11yRedact(Mode.OMIT) String omitted,
            @O11yRedact String byDefault,
            String plain) {}

    @Test
    void tagValuesMapToTheContractProtections() {
        Map<String, Object> out = asMap(Redact.scrub(new Tags("4111", "ab", "123", "pw", "9", "x", "acme")));
        assertEquals("XXXX", out.get("masked"));
        assertEquals("XX", out.get("confidential"), "confidential masks");
        assertEquals("REDACTED", out.get("redacted"));
        assertEquals("REDACTED", out.get("secret"), "secret redacts");
        assertFalse(out.containsKey("omitted"));
        assertEquals("REDACTED", out.get("byDefault"));
        assertEquals("acme", out.get("plain"));
        assertEquals(List.of("masked", "confidential", "redacted", "secret", "byDefault", "plain"),
                new ArrayList<>(out.keySet()));
    }

    record Card(String number, @O11yRedact(Mode.REDACT) String cvv, @O11yRedact(Mode.OMIT) String pin, int expiry) {}

    record Payment(@O11yRedact(Mode.MASK) Card card, @O11yRedact(Mode.MASK) Object items, String merchant) {}

    @Test
    void strictestProtectionWinsThroughNesting() {
        Map<String, Object> items = new LinkedHashMap<>();
        items.put("sku", "A-1");
        Payment p = new Payment(new Card("4111", "123", "9", 1228), List.of("abc", Secret.of("s"), items), "acme");
        Map<String, Object> out = asMap(Redact.scrub(p));
        Map<String, Object> card = asMap(out.get("card"));
        assertEquals("XXXX", card.get("number"), "fields under a masked field are masked at minimum");
        assertEquals("REDACTED", card.get("cvv"), "a stricter inner tag still wins");
        assertFalse(card.containsKey("pin"));
        assertEquals("XXXX", card.get("expiry"), "non-string scalars are masked through their text");
        List<?> list = assertInstanceOf(List.class, out.get("items"));
        assertEquals("XXX", list.get(0));
        assertEquals("REDACTED", list.get(1));
        // Under a mask floor map entries are keyed by sorted position and carry the masked key.
        Map<String, Object> entry = asMap(asMap(list.get(2)).get("0"));
        assertEquals("XXX", entry.get("key"));
        assertEquals("XXX", entry.get("value"));
        assertEquals("acme", out.get("merchant"));
        assertFalse(out.toString().contains("4111") || out.toString().contains("123") || out.toString().contains("A-1"));
    }

    @Test
    void protectionFollowsValuesIntoCollectionsMapsAndArrays() {
        Map<String, Object> in = new LinkedHashMap<>();
        in.put("cards", List.of(new Card("4111", "123", "9", 1)));
        in.put("arr", new Object[] {Secret.of("x"), "ok"});
        in.put("masked", Masked.of("abc"));
        Map<String, Object> out = asMap(Redact.scrub(in));
        Map<String, Object> card = asMap(((List<?>) out.get("cards")).get(0));
        assertEquals("4111", card.get("number"));
        assertEquals("REDACTED", card.get("cvv"));
        assertEquals(List.of("REDACTED", "ok"), out.get("arr"));
        assertEquals("XXX", out.get("masked"));
    }

    static class Base {
        @O11yRedact(Mode.MASK)
        String card = "4111111111114242";

        @Override
        public String toString() {
            return "card=" + card;
        }
    }

    static class Child extends Base {
        String name = "alice";
    }

    @Test
    void inheritedAnnotatedFieldsAreProtected() {
        Map<String, Object> out = asMap(Redact.scrub(new Child()));
        assertEquals("XXXXXXXXXXXXXXXX", out.get("card"));
        assertEquals("alice", out.get("name"));
    }

    static class Holder {
        Card card = new Card("4111", "123", "9", 1);

        @Override
        public String toString() {
            return "Holder" + card;
        }
    }

    @Test
    void anUnannotatedClassHoldingAProtectedTypeIsWalkedNotPrinted() {
        Map<String, Object> out = asMap(Redact.scrub(new Holder()));
        assertEquals("REDACTED", asMap(out.get("card")).get("cvv"));
    }

    @Test
    void anUnreadableRecordFailsClosedInsteadOfThrowing() {
        // ModuleDescImpl is a package-private record in java.lang.constant, which java.base does not
        // open, so setAccessible on its accessor throws InaccessibleObjectException.
        Object out = Redact.scrub(ModuleDesc.of("acme.billing"));
        assertEquals(Map.of("name", "REDACTED"), out);
    }

    record Wrapper(Object inner) {}

    @Test
    void throwingMethodsFailClosedInsteadOfThrowing() {
        Object badToString = new Object() {
            @Override
            public String toString() {
                throw new IllegalStateException("boom");
            }
        };
        Iterable<String> badIterable = () -> new Iterator<>() {
            @Override
            public boolean hasNext() {
                return true;
            }

            @Override
            public String next() {
                throw new IllegalStateException("boom");
            }
        };
        assertEquals("REDACTED", Redact.scrub(badToString));
        assertEquals("REDACTED", Redact.scrub(badIterable));
        assertEquals(Map.of("inner", "REDACTED"), Redact.scrub(new Wrapper(badToString)));
    }

    @Test
    void cyclesAndDeepNestingFailClosed() {
        Map<String, Object> cyclic = new LinkedHashMap<>();
        cyclic.put("self", cyclic);
        assertEquals("REDACTED", asMap(Redact.scrub(cyclic)).get("self"));

        // Go's bound: a value deeper than 32 levels below the root renders REDACTED.
        assertEquals("x", leaf(Redact.scrub(nest(32)), 32));
        assertEquals("REDACTED", leaf(Redact.scrub(nest(33)), 33));
    }

    private static Object nest(int levels) {
        Object v = "x";
        for (int i = 0; i < levels; i++) {
            v = List.of(v);
        }
        return v;
    }

    private static Object leaf(Object v, int levels) {
        for (int i = 0; i < levels; i++) {
            v = ((List<?>) v).get(0);
        }
        return v;
    }

    @Test
    void canonicalPiiInputTypesPassThroughUnchanged() {
        byte[] bytes = {1, 2, 3};
        assertSame(bytes, Redact.scrub(bytes));
        for (Object v : new Object[] {
            "s", 1, 2L, (short) 3, (byte) 4, 1.5d, 2.5f, BigInteger.TEN, new BigDecimal("1.25"), true, 'c'
        }) {
            assertSame(v, Redact.scrub(v));
        }
        long[] longs = {1L, 2L};
        assertSame(longs, Redact.scrub(longs));
    }

    @Test
    void scrubbingKeepsEverySharedPiiTokenVector() throws IOException {
        ObjectMapper mapper = new ObjectMapper();
        JsonNode root = mapper.readTree(Files.readString(
                conformanceDir().resolve("vectors").resolve("pii-hash.json"), StandardCharsets.UTF_8));
        byte[] key = HexFormat.of().parseHex(root.get("key_hex").asString());
        int n = 0;
        for (JsonNode c : root.get("cases")) {
            Object val = "bytes".equals(c.get("kind").asString())
                    ? Base64.getDecoder().decode(c.get("value").asString(""))
                    : convert(c.get("value"));
            assertEquals(c.get("token").asString(), PiiTokenizer.token(key, Redact.scrub(val)),
                    "token mismatch after scrub on " + c.get("name").asString());
            n++;
        }
        assertTrue(n >= 31);
    }

    private static Object convert(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isBoolean()) {
            return node.asBoolean();
        }
        if (node.isIntegralNumber()) {
            return node.asLong();
        }
        if (node.isFloatingPointNumber()) {
            return node.asDouble();
        }
        if (node.isArray()) {
            List<Object> list = new ArrayList<>(node.size());
            for (JsonNode child : node) {
                list.add(convert(child));
            }
            return list;
        }
        if (node.isObject()) {
            Map<String, Object> map = new LinkedHashMap<>();
            for (Map.Entry<String, JsonNode> e : node.properties()) {
                map.put(e.getKey(), convert(e.getValue()));
            }
            return map;
        }
        return node.asString();
    }

    private static Path conformanceDir() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("conformance");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("conformance/ directory not found");
    }


    /** An exception whose message folds in a field the caller tagged secret, like Go's taggedErr. */
    static final class TaggedException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        @O11yRedact(Mode.SECRET)
        private final String token;

        TaggedException(String token) {
            this.token = token;
        }

        @Override
        public String getMessage() {
            return "auth failed: " + token;
        }
    }

    /** An exception that folds a value of unknown type into its message, like Go's opaqueCauseErr. */
    static final class OpaqueDetailException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        private final transient Object detail;

        OpaqueDetailException(Object detail) {
            this.detail = detail;
        }

        @Override
        public String getMessage() {
            return "op: " + (detail instanceof Secret<?> s ? s.expose() : String.valueOf(detail));
        }
    }

    record ErrorHolder(Throwable plain, @O11yRedact(Mode.MASK) Throwable masked) {}

    @Test
    void cleanErrorsRenderTheirTextAndMaskedErrorsTheirMaskedText() {
        IllegalStateException wrapped = new IllegalStateException("db", new IOException("conn refused"));
        assertEquals("java.lang.IllegalStateException: db", Redact.scrub(wrapped));
        assertEquals("ing.o11y.libo11y.RedactTest$OpaqueDetailException: op: timeout",
                Redact.scrub(new OpaqueDetailException("timeout")));

        Map<String, Object> out = asMap(Redact.scrub(new ErrorHolder(wrapped, wrapped)));
        assertEquals("java.lang.IllegalStateException: db", out.get("plain"));
        assertEquals(Redact.mask("java.lang.IllegalStateException: db"), out.get("masked"));
    }

    @Test
    void anErrorThatCouldCarryProtectionRendersRedacted() {
        TaggedException tagged = new TaggedException("raw-err-tok-1");
        RuntimeException wrapTag = new RuntimeException(new TaggedException("raw-err-tok-2"));
        IllegalStateException causeTag = new IllegalStateException("ctx", new TaggedException("raw-err-tok-3"));
        OpaqueDetailException opaqueSecret = new OpaqueDetailException(Secret.of("raw-err-tok-4"));
        OpaqueDetailException opaqueTagged = new OpaqueDetailException(new TaggedException("raw-err-tok-5"));
        IllegalStateException suppressed = new IllegalStateException("ok");
        suppressed.addSuppressed(new TaggedException("raw-err-tok-6"));

        for (Throwable err : List.of(tagged, wrapTag, causeTag, opaqueSecret, opaqueTagged, suppressed)) {
            assertEquals(Redact.REDACTED, Redact.scrub(err), err.getClass().getName());
        }
        Map<String, Object> out = asMap(Redact.scrub(new ErrorHolder(wrapTag, causeTag)));
        assertEquals(Redact.REDACTED, out.get("plain"));
        assertEquals(Redact.REDACTED, out.get("masked"));
    }

    @Test
    void aCauseChainDeeperThanTheBoundRendersRedacted() {
        Throwable deep = new IllegalStateException("leaf");
        for (int i = 0; i <= Redact.MAX_DEPTH; i++) {
            deep = new IllegalStateException("level", deep);
        }
        assertEquals(Redact.REDACTED, Redact.scrub(deep));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object v) {
        return (Map<String, Object>) assertInstanceOf(Map.class, v);
    }
}
