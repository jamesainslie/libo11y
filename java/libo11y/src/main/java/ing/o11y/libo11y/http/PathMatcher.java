package ing.o11y.libo11y.http;

import java.util.Collection;

/**
 * Glob matcher for HTTP ignore paths with the syntax and results of Go's {@code path.Match}.
 *
 * <p>The pattern syntax is:
 *
 * <pre>
 * pattern:
 *     { term }
 * term:
 *     '*'         matches any sequence of non-'/' characters
 *     '?'         matches any single non-'/' character
 *     '[' [ '^' ] { character-range } ']'
 *                 character class (must be non-empty)
 *     c           matches character c (c != '*', '?', '\\', '[')
 *     '\\' c      matches character c
 * character-range:
 *     c           matches character c (c != '\\', '-', ']')
 *     '\\' c      matches character c
 *     lo '-' hi   matches character c for lo &lt;= c &lt;= hi
 * </pre>
 *
 * <p>A character is a Unicode code point. The match must cover the whole name. A malformed
 * pattern is rejected with an {@link IllegalArgumentException}; check patterns with
 * {@link #validate(String)} when they are configured, so a typo fails at startup rather than
 * silently never matching.
 */
public final class PathMatcher {
    private PathMatcher() {}

    /**
     * Reports whether {@code path} matches any of {@code patterns}. As with Go's
     * {@code o11yhttp.WithIgnorePaths}, a malformed pattern never matches, so a request is never
     * rejected at request time because of configuration. A {@code null} collection or path
     * matches nothing.
     */
    public static boolean matchesAny(Collection<String> patterns, String path) {
        if (patterns == null || patterns.isEmpty() || path == null) {
            return false;
        }
        int[] name = path.codePoints().toArray();
        for (String pattern : patterns) {
            if (pattern == null) {
                continue;
            }
            try {
                if (matches(pattern.codePoints().toArray(), name)) {
                    return true;
                }
            } catch (BadPatternException ex) {
                // Malformed patterns never match; validate them when they are configured.
            }
        }
        return false;
    }

    /**
     * Reports whether {@code name} matches the whole of {@code pattern}. A {@code null} pattern
     * or name matches nothing.
     *
     * @throws IllegalArgumentException if {@code pattern} is malformed
     */
    public static boolean match(String pattern, String name) {
        if (pattern == null || name == null) {
            return false;
        }
        try {
            return matches(pattern.codePoints().toArray(), name.codePoints().toArray());
        } catch (BadPatternException ex) {
            throw malformed(pattern);
        }
    }

    /**
     * Checks that {@code pattern} is well formed.
     *
     * @throws IllegalArgumentException if {@code pattern} is {@code null} or malformed
     */
    public static void validate(String pattern) {
        if (pattern == null) {
            throw new IllegalArgumentException("ignore path pattern must not be null");
        }
        match(pattern, "");
    }

    /**
     * Checks every pattern in {@code patterns} with {@link #validate(String)}. A {@code null}
     * collection is valid.
     *
     * @throws IllegalArgumentException naming the first malformed pattern
     */
    public static void validateAll(Collection<String> patterns) {
        if (patterns != null) {
            patterns.forEach(PathMatcher::validate);
        }
    }

    private static IllegalArgumentException malformed(String pattern) {
        return new IllegalArgumentException("syntax error in ignore path pattern \"" + pattern + "\"");
    }

    /** Signals a malformed pattern inside the matcher, translated at the public boundary. */
    private static final class BadPatternException extends Exception {
        private static final long serialVersionUID = 1L;

        BadPatternException() {
            super(null, null, false, false);
        }
    }

    // The algorithm below follows Go's path.Match (src/path/match.go) chunk for chunk, over
    // code points instead of UTF-8 bytes.

    private static boolean matches(int[] pattern, int[] name) throws BadPatternException {
        int p = 0;
        int n = 0;
        pattern:
        while (p < pattern.length) {
            boolean star = false;
            while (p < pattern.length && pattern[p] == '*') {
                p++;
                star = true;
            }
            int chunkStart = p;
            int chunkEnd = chunkEnd(pattern, p);
            p = chunkEnd;
            if (star && chunkStart == chunkEnd) {
                // Trailing * matches the rest of the name unless it has a '/'.
                for (int i = n; i < name.length; i++) {
                    if (name[i] == '/') {
                        return false;
                    }
                }
                return true;
            }
            // Look for a match at the current position.
            int rest = matchChunk(pattern, chunkStart, chunkEnd, name, n);
            // The last chunk must exhaust the name, or a later star could still match.
            if (rest >= 0 && (rest == name.length || p < pattern.length)) {
                n = rest;
                continue;
            }
            if (star) {
                // Look for a match skipping i+1 characters; a star cannot skip '/'.
                for (int i = n; i < name.length && name[i] != '/'; i++) {
                    rest = matchChunk(pattern, chunkStart, chunkEnd, name, i + 1);
                    if (rest >= 0) {
                        if (p == pattern.length && rest < name.length) {
                            continue;
                        }
                        n = rest;
                        continue pattern;
                    }
                }
            }
            // Before returning false, check that the rest of the pattern is well formed.
            while (p < pattern.length) {
                while (p < pattern.length && pattern[p] == '*') {
                    p++;
                }
                int start = p;
                p = chunkEnd(pattern, p);
                matchChunk(pattern, start, p, name, name.length);
            }
            return false;
        }
        return n == name.length;
    }

    /** Returns the end of the chunk starting at {@code from}: the next '*' outside a class. */
    private static int chunkEnd(int[] pattern, int from) {
        boolean inRange = false;
        for (int i = from; i < pattern.length; i++) {
            switch (pattern[i]) {
                case '\\' -> {
                    if (i + 1 < pattern.length) {
                        i++;
                    }
                }
                case '[' -> inRange = true;
                case ']' -> inRange = false;
                case '*' -> {
                    if (!inRange) {
                        return i;
                    }
                }
                default -> { }
            }
        }
        return pattern.length;
    }

    /**
     * Matches {@code pattern[c..end)} against the start of {@code name[s..]}. Returns the index in
     * {@code name} after the match, or -1 if it does not match. The whole chunk is parsed even
     * after a mismatch, so a malformed chunk is always reported.
     */
    private static int matchChunk(int[] pattern, int c, int end, int[] name, int s)
            throws BadPatternException {
        boolean failed = false;
        while (c < end) {
            failed = failed || s >= name.length;
            int pc = pattern[c];
            if (pc == '[') {
                int r = -1;
                if (!failed) {
                    r = name[s];
                    s++;
                }
                c++;
                boolean negated = false;
                if (c < end && pattern[c] == '^') {
                    negated = true;
                    c++;
                }
                boolean match = false;
                int ranges = 0;
                while (true) {
                    if (c < end && pattern[c] == ']' && ranges > 0) {
                        c++;
                        break;
                    }
                    int[] lo = escaped(pattern, c, end);
                    c = lo[1];
                    int hi = lo[0];
                    if (pattern[c] == '-') {
                        int[] h = escaped(pattern, c + 1, end);
                        hi = h[0];
                        c = h[1];
                    }
                    match = match || (lo[0] <= r && r <= hi);
                    ranges++;
                }
                failed = failed || match == negated;
            } else if (pc == '?') {
                if (!failed) {
                    failed = name[s] == '/';
                    s++;
                }
                c++;
            } else {
                if (pc == '\\') {
                    c++;
                    if (c == end) {
                        throw new BadPatternException();
                    }
                }
                if (!failed) {
                    failed = pattern[c] != name[s];
                    s++;
                }
                c++;
            }
        }
        return failed ? -1 : s;
    }

    /**
     * Reads one possibly escaped character of a character class at {@code c}. Returns the
     * character and the index after it. Like Go's {@code getEsc}, the class must continue after
     * the character, and a lone surrogate counts as an invalid encoding.
     */
    private static int[] escaped(int[] pattern, int c, int end) throws BadPatternException {
        if (c >= end || pattern[c] == '-' || pattern[c] == ']') {
            throw new BadPatternException();
        }
        if (pattern[c] == '\\') {
            c++;
            if (c >= end) {
                throw new BadPatternException();
            }
        }
        int r = pattern[c];
        if (r >= Character.MIN_SURROGATE && r <= Character.MAX_SURROGATE) {
            throw new BadPatternException();
        }
        c++;
        if (c >= end) {
            throw new BadPatternException();
        }
        return new int[] {r, c};
    }
}
