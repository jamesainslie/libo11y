package ing.o11y.libo11y.spec;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Inputs where a lexical shortcut can disagree with gopkg.in/yaml.v3. Each expectation is what the Go
 * reference (go/internal/appregistry, yaml.v3 v3.0.1) returns for the same bytes.
 */
class YamlV3CompatTest {
    private static final String HEADER = String.join(
            "\n",
            "schema: libo11y.app-registry/v1",
            "namespace: lor",
            "attributes:",
            "  lor.user.id:",
            "    type: string",
            "    sensitivity: internal",
            "    cardinality: unbounded",
            "");

    private static final String ROLE_PREFIX =
            "  lor.user.role: {type: string, sensitivity: public, cardinality: enum, values: ";

    static Stream<Arguments> accepted() {
        return Stream.of(
                Arguments.of("plain scalar holding a quote and a slash escape",
                        "    brief: see \"a\\/b\" here",
                        "lor.user.id brief=see \"a\\/b\" here values=[]"),
                Arguments.of("plain scalar holding an apostrophe, then a quote",
                        "    brief: don't \"a\\/b\"",
                        "lor.user.id brief=don't \"a\\/b\" values=[]"),
                Arguments.of("literal block scalar holding a quote",
                        "    brief: |\n      say \"a\\/b\"",
                        "lor.user.id brief=say \"a\\/b\"\n values=[]"),
                Arguments.of("folded block scalar with the slash on a later line",
                        "    brief: >\n      say \"x\n      a\\/b\"",
                        "lor.user.id brief=say \"x a\\/b\"\n values=[]"),
                Arguments.of("plain scalar continuation line starting with a quote",
                        "    brief: foo\n      \"a\\/b\" bar",
                        "lor.user.id brief=foo \"a\\/b\" bar values=[]"),
                Arguments.of("plain scalar holding a backslash apostrophe",
                        "    brief: it\\'s",
                        "lor.user.id brief=it\\'s values=[]"),
                Arguments.of("comment holding a quote and a slash escape",
                        "    brief: x # \"a\\/b\"",
                        "lor.user.id brief=x values=[]"),
                Arguments.of("single-quoted scalar holding a quote",
                        "    brief: 'say \"a\\/b\"'",
                        "lor.user.id brief=say \"a\\/b\" values=[]"),
                Arguments.of("double-quoted escaped backslash before an apostrophe",
                        "    brief: \"a\\\\'\"",
                        "lor.user.id brief=a\\' values=[]"),
                Arguments.of("double-quoted apostrophe escapes across lines",
                        "    brief: \"it\\'s\n      and it\\'s\"",
                        "lor.user.id brief=it's and it's values=[]"),
                Arguments.of("literal block with a quote, then a real apostrophe escape",
                        "    brief: |\n      it\\'s \"x\n" + ROLE_PREFIX + "[\"it\\'s\"]}",
                        "lor.user.id brief=it\\'s \"x\n values=[]\nlor.user.role brief= values=[it's]"),
                Arguments.of("single-quoted scalar ending in a backslash, then an apostrophe escape",
                        ROLE_PREFIX + "['a\\', \"it\\'s\"]}",
                        "lor.user.id brief= values=[]\nlor.user.role brief= values=[a\\, it's]"),
                Arguments.of("astral characters before plain and double-quoted apostrophe escapes",
                        "    brief: \uD83D\uDE00\uD83D\uDE00 it\\'s\n" + ROLE_PREFIX + "[\"\uD83D\uDE00 it\\'s\"]}",
                        "lor.user.id brief=\uD83D\uDE00\uD83D\uDE00 it\\'s values=[]\n"
                                + "lor.user.role brief= values=[\uD83D\uDE00 it's]"),
                Arguments.of("astral escape",
                        "    brief: \"\\U0001F600\"",
                        "lor.user.id brief=\uD83D\uDE00 values=[]"));
    }

    static Stream<Arguments> rejected() {
        return Stream.of(
                Arguments.of("lone surrogate escape after properties", "    brief: &a !!str \"\\ud800\""),
                Arguments.of("long surrogate escape", "    brief: \"\\U0000D800\""),
                Arguments.of("surrogate pair escapes", "    brief: \"\\uD83D\\uDE00\""),
                Arguments.of("escape above U+10FFFF", "    brief: \"\\U00110000\""),
                Arguments.of("slash escape", "    brief: \"a\\/b\""));
    }

    static Stream<Arguments> directives() {
        return Stream.of(
                Arguments.of("%YAML 1.1", true),
                Arguments.of("%YAML 1.01", true),
                Arguments.of("%YAML 1.2", false),
                Arguments.of("%YAML 001.1", false),
                Arguments.of("%YAML 99999999999.1", false),
                Arguments.of("%YAML 1.99999999999", false));
    }

    private static String describe(AppRegistryValidator.AppRegistry reg) {
        List<String> lines = new ArrayList<>();
        for (Map.Entry<String, AppRegistryValidator.AppRegistryAttribute> e : reg.attributes().entrySet()) {
            lines.add(e.getKey() + " brief=" + e.getValue().brief() + " values=" + e.getValue().values());
        }
        lines.sort(null);
        return String.join("\n", lines);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("accepted")
    void acceptsWhatYamlV3Accepts(String name, String body, String want) {
        assertEquals(want, describe(AppRegistryValidator.parse(HEADER + body + "\n")));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("rejected")
    void rejectsWhatYamlV3Rejects(String name, String body) {
        AppRegistryValidator.AppRegistryParseException ex = assertThrows(
                AppRegistryValidator.AppRegistryParseException.class,
                () -> AppRegistryValidator.parse(HEADER + body + "\n"));
        assertEquals("syntax", ex.kind());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("directives")
    void versionDirectiveMatchesYamlV3(String directive, boolean ok) {
        String text = directive + "\n---\n" + HEADER;
        if (ok) {
            assertEquals("lor.user.id brief= values=[]", describe(AppRegistryValidator.parse(text)));
            return;
        }
        AppRegistryValidator.AppRegistryParseException ex = assertThrows(
                AppRegistryValidator.AppRegistryParseException.class,
                () -> AppRegistryValidator.parse(text));
        assertEquals("syntax", ex.kind());
    }
}
