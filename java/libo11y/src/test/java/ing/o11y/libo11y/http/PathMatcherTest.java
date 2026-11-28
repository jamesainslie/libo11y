package ing.o11y.libo11y.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class PathMatcherTest {

    /** The cases of Go's {@code path/match_test.go}, in order: pattern, name, match, bad pattern. */
    static Stream<Arguments> goMatchTests() {
        return Stream.of(
                Arguments.of("abc", "abc", true, false),
                Arguments.of("*", "abc", true, false),
                Arguments.of("*c", "abc", true, false),
                Arguments.of("a*", "a", true, false),
                Arguments.of("a*", "abc", true, false),
                Arguments.of("a*", "ab/c", false, false),
                Arguments.of("a*/b", "abc/b", true, false),
                Arguments.of("a*/b", "a/c/b", false, false),
                Arguments.of("a*b*c*d*e*/f", "axbxcxdxe/f", true, false),
                Arguments.of("a*b*c*d*e*/f", "axbxcxdxexxx/f", true, false),
                Arguments.of("a*b*c*d*e*/f", "axbxcxdxe/xxx/f", false, false),
                Arguments.of("a*b*c*d*e*/f", "axbxcxdxexxx/fff", false, false),
                Arguments.of("a*b?c*x", "abxbbxdbxebxczzx", true, false),
                Arguments.of("a*b?c*x", "abxbbxdbxebxczzy", false, false),
                Arguments.of("ab[c]", "abc", true, false),
                Arguments.of("ab[b-d]", "abc", true, false),
                Arguments.of("ab[e-g]", "abc", false, false),
                Arguments.of("ab[^c]", "abc", false, false),
                Arguments.of("ab[^b-d]", "abc", false, false),
                Arguments.of("ab[^e-g]", "abc", true, false),
                Arguments.of("a\\*b", "a*b", true, false),
                Arguments.of("a\\*b", "ab", false, false),
                Arguments.of("a?b", "a☺b", true, false),
                Arguments.of("a[^a]b", "a☺b", true, false),
                Arguments.of("a???b", "a☺b", false, false),
                Arguments.of("a[^a][^a][^a]b", "a☺b", false, false),
                Arguments.of("[a-ζ]*", "α", true, false),
                Arguments.of("*[a-ζ]", "A", false, false),
                Arguments.of("a?b", "a/b", false, false),
                Arguments.of("a*b", "a/b", false, false),
                Arguments.of("[\\]a]", "]", true, false),
                Arguments.of("[\\-]", "-", true, false),
                Arguments.of("[x\\-]", "x", true, false),
                Arguments.of("[x\\-]", "-", true, false),
                Arguments.of("[x\\-]", "z", false, false),
                Arguments.of("[\\-x]", "x", true, false),
                Arguments.of("[\\-x]", "-", true, false),
                Arguments.of("[\\-x]", "a", false, false),
                Arguments.of("[]a]", "]", false, true),
                Arguments.of("[-]", "-", false, true),
                Arguments.of("[x-]", "x", false, true),
                Arguments.of("[x-]", "-", false, true),
                Arguments.of("[x-]", "z", false, true),
                Arguments.of("[-x]", "x", false, true),
                Arguments.of("[-x]", "-", false, true),
                Arguments.of("[-x]", "a", false, true),
                Arguments.of("\\", "a", false, true),
                Arguments.of("[a-b-c]", "a", false, true),
                Arguments.of("[", "a", false, true),
                Arguments.of("[^", "a", false, true),
                Arguments.of("[^bc", "a", false, true),
                Arguments.of("a[", "a", false, true),
                Arguments.of("a[", "ab", false, true),
                Arguments.of("a[", "x", false, true),
                Arguments.of("a/b[", "x", false, true),
                Arguments.of("*x", "xxx", true, false));
    }

    @ParameterizedTest(name = "match({0}, {1})")
    @MethodSource("goMatchTests")
    void matchesLikeGoPathMatch(String pattern, String name, boolean match, boolean badPattern) {
        if (badPattern) {
            IllegalArgumentException ex =
                    assertThrows(IllegalArgumentException.class, () -> PathMatcher.match(pattern, name));
            assertTrue(ex.getMessage().contains(pattern), ex.getMessage());
            assertThrows(IllegalArgumentException.class, () -> PathMatcher.validate(pattern));
        } else {
            assertEquals(match, PathMatcher.match(pattern, name));
            PathMatcher.validate(pattern);
        }
    }

    @Test
    void supplementaryCodePointsAreOneCharacter() {
        assertTrue(PathMatcher.match("/a?b", "/a😀b"));
        assertTrue(PathMatcher.match("/[😀]", "/😀"));
        assertFalse(PathMatcher.match("/a??b", "/a😀b"));
    }

    @Test
    void validateAllNamesTheFirstMalformedPattern() {
        IllegalArgumentException ex = assertThrows(
                IllegalArgumentException.class,
                () -> PathMatcher.validateAll(List.of("/healthz", "/debug/[", "/x")));
        assertTrue(ex.getMessage().contains("/debug/["), ex.getMessage());
        PathMatcher.validateAll(List.of("/healthz", "/debug/*"));
    }

    @Test
    void matchesAnySkipsMalformedPatternsLikeGoIgnorePaths() {
        assertTrue(PathMatcher.matchesAny(List.of("[", "/healthz"), "/healthz"));
        assertFalse(PathMatcher.matchesAny(List.of("["), "["));
        assertFalse(PathMatcher.matchesAny(List.of("/healthz"), null));
    }
}
