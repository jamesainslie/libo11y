package ing.o11y.libo11y.jdbc;

import java.util.Locale;
import java.util.Set;

/** SQL literal sanitizer for PostgreSQL, SQLite, MySQL, MariaDB, and H2 queries. */
public final class SqlSanitizer {
    private static final Set<String> SUPPORTED = Set.of("postgresql", "sqlite", "mysql", "mariadb", "h2");

    private SqlSanitizer() {}

    public static boolean isSupported(String dbSystem) {
        return dbSystem != null && SUPPORTED.contains(dbSystem.toLowerCase(Locale.ROOT));
    }

    public static String extractOperation(String sql) {
        if (sql == null) {
            return "";
        }
        int i = 0;
        int n = sql.length();
        while (i < n && Character.isWhitespace(sql.charAt(i))) {
            i++;
        }
        int start = i;
        while (i < n && Character.isLetter(sql.charAt(i))) {
            i++;
        }
        return start < i ? sql.substring(start, i).toUpperCase(Locale.ROOT) : "";
    }

    public static String sanitize(String dbSystem, String sql) {
        if (!isSupported(dbSystem) || sql == null) {
            return null;
        }
        String sys = dbSystem.toLowerCase(Locale.ROOT);
        boolean backslashEscape = "mysql".equals(sys) || "mariadb".equals(sys);
        boolean dollarQuote = "postgresql".equals(sys);

        StringBuilder out = new StringBuilder(sql.length());
        int i = 0;
        int n = sql.length();
        while (i < n) {
            char c = sql.charAt(i);
            // Line comment --
            if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                i += 2;
                while (i < n && sql.charAt(i) != '\n') {
                    i++;
                }
                continue;
            }
            // Block comment /* ... */
            if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < n && !(sql.charAt(i) == '*' && sql.charAt(i + 1) == '/')) {
                    i++;
                }
                i = Math.min(n, i + 2);
                continue;
            }
            // Single-quoted string literal
            if (c == '\'') {
                out.append('?');
                i++;
                while (i < n) {
                    char sc = sql.charAt(i);
                    if (backslashEscape && sc == '\\' && i + 1 < n) {
                        i += 2;
                        continue;
                    }
                    if (sc == '\'') {
                        if (i + 1 < n && sql.charAt(i + 1) == '\'') {
                            i += 2;
                            continue;
                        }
                        i++;
                        break;
                    }
                    i++;
                }
                continue;
            }
            // PostgreSQL dollar-quoted string $tag$...$tag$
            if (dollarQuote && c == '$') {
                int endTag = sql.indexOf('$', i + 1);
                if (endTag != -1 && isDollarTag(sql, i + 1, endTag)) {
                    String tag = sql.substring(i, endTag + 1);
                    int close = sql.indexOf(tag, endTag + 1);
                    out.append('?');
                    i = close == -1 ? n : close + tag.length();
                    continue;
                }
            }
            // Numeric literals (not part of identifiers)
            if (c >= '0' && c <= '9' && (i == 0 || !isIdentChar(sql.charAt(i - 1)))) {
                out.append('?');
                while (i < n && (Character.isDigit(sql.charAt(i)) || sql.charAt(i) == '.')) {
                    i++;
                }
                if (i < n && (sql.charAt(i) == 'e' || sql.charAt(i) == 'E')) {
                    i++;
                    if (i < n && (sql.charAt(i) == '+' || sql.charAt(i) == '-')) {
                        i++;
                    }
                    while (i < n && Character.isDigit(sql.charAt(i))) {
                        i++;
                    }
                }
                continue;
            }
            out.append(c);
            i++;
        }
        return out.toString().replaceAll("\\s+", " ").trim();
    }

    private static boolean isIdentChar(char c) {
        return Character.isLetterOrDigit(c) || c == '_' || c == '$';
    }

    private static boolean isDollarTag(String sql, int start, int end) {
        for (int k = start; k < end; k++) {
            char c = sql.charAt(k);
            if (!Character.isLetterOrDigit(c) && c != '_') {
                return false;
            }
        }
        return true;
    }
}
