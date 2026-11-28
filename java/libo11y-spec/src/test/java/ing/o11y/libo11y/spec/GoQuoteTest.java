package ing.o11y.libo11y.spec;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Locale;
import org.junit.jupiter.api.parallel.ResourceLock;
import org.junit.jupiter.api.parallel.Resources;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class GoQuoteTest {
    /** The expectation is Go's strconv.Quote of "\x01\u0085\U000e0001". */
    private static final String WANT = "\"\\x01\\u0085\\U000e0001\"";

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"ar-SA-u-nu-arab", "hi-IN-u-nu-deva", "th-TH-u-nu-thai", "fa-IR", "tr-TR"})
    @ResourceLock(Resources.LOCALE)
    void quotesWithAsciiDigitsUnderAnyDefaultLocale(String tag) {
        Locale saved = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag(tag));
            assertEquals(WANT, GoQuote.quote("\u0001\u0085" + new String(Character.toChars(0xE0001))));
        } finally {
            Locale.setDefault(saved);
        }
    }
}
