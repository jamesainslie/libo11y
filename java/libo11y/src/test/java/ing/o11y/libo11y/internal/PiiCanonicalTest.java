package ing.o11y.libo11y.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

import ing.o11y.libo11y.PiiMode;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PiiCanonicalTest {
    /** Expected values are Go's strconv.FormatFloat(v, 'g', -1, 64). */
    @Test
    void canonicalFloatIsGosShortestForm() {
        Map<Double, String> want = new LinkedHashMap<>();
        want.put(Double.MIN_VALUE, "5e-324");
        want.put(-Double.MIN_VALUE, "-5e-324");
        want.put(2 * Double.MIN_VALUE, "1e-323");
        want.put(3 * Double.MIN_VALUE, "1.5e-323");
        want.put(9e-322, "9e-322");
        want.put(5e-310, "5e-310");
        want.put(Double.MIN_NORMAL, "2.2250738585072014e-308");
        want.put(Double.MAX_VALUE, "1.7976931348623157e+308");
        want.put(1e21, "1e+21");
        want.put(1e20, "1e+20");
        want.put(1e23, "1e+23");
        want.put(1e100, "1e+100");
        want.put(1e-100, "1e-100");
        want.put(123456.0, "123456");
        want.put(1234567.0, "1.234567e+06");
        want.put(0.0001, "0.0001");
        want.put(0.00001, "1e-05");
        want.put(2e-5, "2e-05");
        want.put(1.5, "1.5");
        want.put(100.0, "100");
        want.put(0.1, "0.1");
        want.put(1.0 / 3, "0.3333333333333333");
        want.put((double) 0.1f, "0.10000000149011612");
        want.forEach((v, s) -> assertEquals(s, PiiTokenizer.canonicalFloat(v), "value " + v));
    }

    @Test
    void canonicalRenderingIgnoresTheDefaultLocale() {
        Locale saved = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("ar-EG"));
            assertEquals("1e-05", PiiTokenizer.canonicalFloat(0.00001));
            assertEquals("[\"\\u0001\"]", PiiTokenizer.canonicalValue(List.of("\u0001")));
        } finally {
            Locale.setDefault(saved);
        }
    }

    @Test
    void aPathIsAScalarNotANestedList() {
        Path p = Path.of("/var/data/file.txt");
        assertEquals("/var/data/file.txt", PiiTokenizer.canonicalValue(p));
        SensitivityPolicy policy = new SensitivityPolicy(PiiMode.DROP, null, List.of());
        Map<String, Object> out = policy.classifyLogMap(Map.of("app.file", p), false);
        assertSame(p, out.get("app.file"));
    }

    @Test
    void arraysAreWalkedOnLogs() {
        SensitivityPolicy policy = new SensitivityPolicy(PiiMode.DROP, null, List.of());
        Object[] hosts = {Map.of("ip", "10.0.0.1", "name", "a")};
        Map<String, Object> out = policy.classifyLogMap(Map.of("host", hosts), false);
        assertEquals(List.of(Map.of("name", "a")), out.get("host"));
        int[] ints = {1, 2};
        assertEquals(List.of(1, 2), policy.classifyLogMap(Map.of("app.ints", ints), false).get("app.ints"));
        byte[] raw = {1, 2};
        assertSame(raw, policy.classifyLogMap(Map.of("app.raw", raw), false).get("app.raw"));
    }
}
