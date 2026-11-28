package ing.o11y.libo11y.http;

import java.util.Collection;

/** Go {@code path.Match}-compatible glob matcher for HTTP ignore paths. */
public final class PathMatcher {
    private PathMatcher() {}

    public static boolean matchesAny(Collection<String> patterns, String path) {
        if (patterns == null || patterns.isEmpty() || path == null) {
            return false;
        }
        for (String pattern : patterns) {
            if (match(pattern, path)) {
                return true;
            }
        }
        return false;
    }

    public static boolean match(String pattern, String name) {
        if (pattern == null || name == null) {
            return false;
        }
        return matchAt(pattern, 0, name, 0);
    }

    private static boolean matchAt(String p, int pi, String s, int si) {
        while (pi < p.length()) {
            char pc = p.charAt(pi);
            if (pc == '*') {
                // '*' matches any sequence of non-'/' characters
                pi++;
                if (pi == p.length()) {
                    return s.indexOf('/', si) == -1;
                }
                for (int k = si; k <= s.length(); k++) {
                    if (k > si && s.charAt(k - 1) == '/') {
                        break;
                    }
                    if (matchAt(p, pi, s, k)) {
                        return true;
                    }
                }
                return false;
            }
            if (si >= s.length()) {
                return false;
            }
            char sc = s.charAt(si);
            if (pc == '?') {
                if (sc == '/') {
                    return false;
                }
                pi++;
                si++;
            } else if (pc == '\\' && pi + 1 < p.length()) {
                pi++;
                if (p.charAt(pi) != sc) {
                    return false;
                }
                pi++;
                si++;
            } else {
                if (pc != sc) {
                    return false;
                }
                pi++;
                si++;
            }
        }
        return si == s.length();
    }
}
