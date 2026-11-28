package ing.o11y.libo11y.spec;

import ing.o11y.libo11y.spec.generated.GoPrintRanges;

/** Go strconv.Quote (%q) implementation backed by specgen's GoPrintRanges table. */
public final class GoQuote {
    private GoQuote() {}

    public static boolean isPrintable(int codepoint) {
        int[] ranges = GoPrintRanges.RANGES;
        int lo = 0;
        int hi = ranges.length;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (ranges[mid] < codepoint) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo < ranges.length && ((lo & 1) == 1 || ranges[lo] == codepoint);
    }

    public static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i);
            i += Character.charCount(cp);
            if (cp == '"' || cp == '\\') {
                sb.append('\\').append((char) cp);
            } else if (isPrintable(cp)) {
                sb.appendCodePoint(cp);
            } else {
                switch (cp) {
                    case 0x07 -> sb.append("\\a");
                    case '\b' -> sb.append("\\b");
                    case '\f' -> sb.append("\\f");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    case 0x0B -> sb.append("\\v");
                    default -> {
                        if (cp < 0x20 || cp == 0x7F) {
                            sb.append(String.format("\\x%02x", cp));
                        } else if (cp < 0x10000) {
                            sb.append(String.format("\\u%04x", cp));
                        } else {
                            sb.append(String.format("\\U%08x", cp));
                        }
                    }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
