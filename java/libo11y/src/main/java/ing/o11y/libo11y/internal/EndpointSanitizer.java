package ing.o11y.libo11y.internal;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;

/** Byte-exact port of Go's net/url.Parse + URL.String() endpoint sanitization. */
public final class EndpointSanitizer {
    public static final String WITHHELD = "unparseable";
    private static final String HEX_UPPER = "0123456789ABCDEF";

    private enum Mode {
        PATH,
        HOST,
        ZONE,
        USER_PASSWORD,
        FRAGMENT
    }

    private static final class InvalidUrlException extends RuntimeException {}

    private static final class ParsedUrl {
        String scheme = "";
        byte[] opaqueText = new byte[0];
        boolean hasUser;
        byte[] host = new byte[0];
        byte[] path = new byte[0];
        byte[] rawPath = new byte[0];
        boolean omitHost;
    }

    private EndpointSanitizer() {}

    private static int u(byte c) {
        return c & 0xFF;
    }

    private static boolean isAlnum(byte c) {
        int b = u(c);
        return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A);
    }

    private static boolean isHex(byte c) {
        int b = u(c);
        return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
    }

    private static int unhex(byte c) {
        int b = u(c);
        if (b >= 0x30 && b <= 0x39) {
            return b - 0x30;
        }
        if (b >= 0x61 && b <= 0x66) {
            return b - 0x61 + 10;
        }
        return b - 0x41 + 10;
    }

    private static boolean isHostOk(byte c) {
        return switch (u(c)) {
            case '!', '$', '&', '\'', '(', ')', '*', '+', ',', ';', '=', ':', '<', '>', '"', '[', ']' -> true;
            default -> false;
        };
    }

    private static boolean isGenDelim(byte c) {
        return switch (u(c)) {
            case '$', '&', '+', ',', '/', ':', ';', '=', '?', '@' -> true;
            default -> false;
        };
    }

    private static boolean isUnreservedPunct(byte c) {
        return switch (u(c)) {
            case '-', '_', '.', '~' -> true;
            default -> false;
        };
    }

    private static boolean isFragOk(byte c) {
        return switch (u(c)) {
            case '!', '(', ')', '*' -> true;
            default -> false;
        };
    }

    private static boolean isUserinfoPunct(byte c) {
        return switch (u(c)) {
            case '-', '.', '_', ':', '~', '!', '$', '&', '\'', '(', ')', '*', '+', ',', ';', '=', '%', '@' -> true;
            default -> false;
        };
    }

    private static boolean isValidEncExtra(byte c) {
        return switch (u(c)) {
            case '!', '$', '&', '\'', '(', ')', '*', '+', ',', ';', '=', ':', '@', '[', ']', '%' -> true;
            default -> false;
        };
    }

    private static boolean shouldEscape(byte c, Mode mode) {
        if (isAlnum(c)) {
            return false;
        }
        if ((mode == Mode.HOST || mode == Mode.ZONE) && isHostOk(c)) {
            return false;
        }
        if (isUnreservedPunct(c)) {
            return false;
        }
        if (isGenDelim(c)) {
            if (mode == Mode.PATH) {
                return u(c) == '?';
            }
            if (mode == Mode.USER_PASSWORD) {
                int b = u(c);
                return b == '@' || b == '/' || b == '?' || b == ':';
            }
            return mode != Mode.FRAGMENT;
        }
        return !(mode == Mode.FRAGMENT && isFragOk(c));
    }

    private static byte[] unescape(byte[] s, Mode mode) {
        int n = 0;
        int i = 0;
        while (i < s.length) {
            byte c = s[i];
            if (u(c) == 0x25) {
                n++;
                if (i + 2 >= s.length || !isHex(s[i + 1]) || !isHex(s[i + 2])) {
                    throw new InvalidUrlException();
                }
                boolean pct25 = u(s[i + 1]) == '2' && u(s[i + 2]) == '5';
                if (mode == Mode.HOST && unhex(s[i + 1]) < 8 && !pct25) {
                    throw new InvalidUrlException();
                }
                if (mode == Mode.ZONE) {
                    byte v = (byte) ((unhex(s[i + 1]) << 4) | unhex(s[i + 2]));
                    if (!pct25 && u(v) != 0x20 && shouldEscape(v, Mode.HOST)) {
                        throw new InvalidUrlException();
                    }
                }
                i += 3;
            } else {
                if ((mode == Mode.HOST || mode == Mode.ZONE) && u(c) < 0x80 && shouldEscape(c, mode)) {
                    throw new InvalidUrlException();
                }
                i++;
            }
        }
        if (n == 0) {
            return s.clone();
        }
        byte[] output = new byte[s.length - 2 * n];
        int j = 0;
        i = 0;
        while (i < s.length) {
            if (u(s[i]) == 0x25) {
                output[j++] = (byte) ((unhex(s[i + 1]) << 4) | unhex(s[i + 2]));
                i += 3;
            } else {
                output[j++] = s[i++];
            }
        }
        return output;
    }

    private static byte[] escape(byte[] s, Mode mode) {
        int count = 0;
        for (byte c : s) {
            if (shouldEscape(c, mode)) {
                count++;
            }
        }
        if (count == 0) {
            return s.clone();
        }
        byte[] output = new byte[s.length + 2 * count];
        int j = 0;
        for (byte c : s) {
            if (shouldEscape(c, mode)) {
                int b = u(c);
                output[j++] = 0x25;
                output[j++] = (byte) HEX_UPPER.charAt(b >>> 4);
                output[j++] = (byte) HEX_UPPER.charAt(b & 0x0F);
            } else {
                output[j++] = c;
            }
        }
        return output;
    }

    private static boolean validEncoded(byte[] s, Mode mode) {
        for (byte c : s) {
            if (isValidEncExtra(c)) {
                continue;
            }
            if (shouldEscape(c, mode)) {
                return false;
            }
        }
        return true;
    }

    private static boolean validOptionalPort(byte[] port) {
        if (port.length == 0) {
            return true;
        }
        if (u(port[0]) != ':') {
            return false;
        }
        for (int i = 1; i < port.length; i++) {
            int b = u(port[i]);
            if (b < 0x30 || b > 0x39) {
                return false;
            }
        }
        return true;
    }

    private static boolean validUserinfo(byte[] s) {
        for (byte c : s) {
            if (!isAlnum(c) && !isUserinfoPunct(c)) {
                return false;
            }
        }
        return true;
    }

    private record SplitBytes(byte[] first, byte[] remainder) {}

    private static SplitBytes getScheme(byte[] raw) {
        for (int i = 0; i < raw.length; i++) {
            int c = u(raw[i]);
            if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) {
                continue;
            }
            if ((c >= 0x30 && c <= 0x39) || c == '+' || c == '-' || c == '.') {
                if (i == 0) {
                    return new SplitBytes(new byte[0], raw);
                }
                continue;
            }
            if (c == ':') {
                if (i == 0) {
                    throw new InvalidUrlException();
                }
                return new SplitBytes(Arrays.copyOfRange(raw, 0, i), Arrays.copyOfRange(raw, i + 1, raw.length));
            }
            return new SplitBytes(new byte[0], raw);
        }
        return new SplitBytes(new byte[0], raw);
    }

    private static int indexOf(byte[] a, byte target) {
        for (int i = 0; i < a.length; i++) {
            if (a[i] == target) {
                return i;
            }
        }
        return -1;
    }

    private static int lastIndexOf(byte[] a, byte target) {
        for (int i = a.length - 1; i >= 0; i--) {
            if (a[i] == target) {
                return i;
            }
        }
        return -1;
    }

    private static int indexOfSeq(byte[] a, byte[] seq) {
        outer:
        for (int i = 0; i <= a.length - seq.length; i++) {
            for (int j = 0; j < seq.length; j++) {
                if (a[i + j] != seq[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    private static boolean startsWith(byte[] a, byte[] prefix) {
        if (a.length < prefix.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i++) {
            if (a[i] != prefix[i]) {
                return false;
            }
        }
        return true;
    }

    private static byte[] concat(byte[]... parts) {
        int total = 0;
        for (byte[] p : parts) {
            total += p.length;
        }
        byte[] out = new byte[total];
        int pos = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, pos, p.length);
            pos += p.length;
        }
        return out;
    }

    private static boolean validIpv4(byte[] s) {
        int val = 0;
        int pos = 0;
        int digLen = 0;
        for (int i = 0; i < s.length; i++) {
            int c = u(s[i]);
            if (c >= 0x30 && c <= 0x39) {
                if (digLen == 1 && val == 0) {
                    return false;
                }
                val = val * 10 + (c - 0x30);
                digLen++;
                if (val > 255) {
                    return false;
                }
            } else if (c == '.') {
                if (i == 0 || i == s.length - 1 || u(s[i - 1]) == '.') {
                    return false;
                }
                if (pos == 3) {
                    return false;
                }
                pos++;
                val = 0;
                digLen = 0;
            } else {
                return false;
            }
        }
        return pos == 3;
    }

    private static boolean parseIpv6(byte[] data) {
        byte[] s = data;
        int pct = indexOf(s, (byte) '%');
        if (pct != -1) {
            if (pct + 1 == s.length) {
                return false;
            }
            s = Arrays.copyOfRange(s, 0, pct);
        }
        Integer ellipsis = null;
        if (s.length >= 2 && u(s[0]) == ':' && u(s[1]) == ':') {
            ellipsis = 0;
            s = Arrays.copyOfRange(s, 2, s.length);
            if (s.length == 0) {
                return true;
            }
        }
        int i = 0;
        while (i < 16) {
            int off = 0;
            int acc = 0;
            while (off < s.length) {
                byte c = s[off];
                if (!isHex(c)) {
                    break;
                }
                acc = (acc << 4) + unhex(c);
                if (off > 3 || acc > 0xFFFF) {
                    return false;
                }
                off++;
            }
            if (off == 0) {
                return false;
            }
            if (off < s.length && u(s[off]) == '.') {
                if (ellipsis == null && i != 12) {
                    return false;
                }
                if (i + 4 > 16 || !validIpv4(s)) {
                    return false;
                }
                s = new byte[0];
                i += 4;
                break;
            }
            i += 2;
            s = Arrays.copyOfRange(s, off, s.length);
            if (s.length == 0) {
                break;
            }
            if (u(s[0]) != ':' || s.length == 1) {
                return false;
            }
            s = Arrays.copyOfRange(s, 1, s.length);
            if (u(s[0]) == ':') {
                if (ellipsis != null) {
                    return false;
                }
                ellipsis = i;
                s = Arrays.copyOfRange(s, 1, s.length);
                if (s.length == 0) {
                    break;
                }
            }
        }
        if (s.length > 0) {
            return false;
        }
        return (i < 16) == (ellipsis != null);
    }

    private static boolean isIpv6Literal(byte[] s) {
        for (byte c : s) {
            int b = u(c);
            if (b == '.' || b == '%') {
                return false;
            }
            if (b == ':') {
                return parseIpv6(s);
            }
        }
        return false;
    }

    private static byte[] parseHost(String scheme, byte[] host) {
        int openIdx = lastIndexOf(host, (byte) '[');
        if (openIdx != -1) {
            if (openIdx > 0) {
                throw new InvalidUrlException();
            }
            int closeIdx = lastIndexOf(host, (byte) ']');
            if (closeIdx == -1) {
                throw new InvalidUrlException();
            }
            byte[] colonPort = Arrays.copyOfRange(host, closeIdx + 1, host.length);
            if (!validOptionalPort(colonPort)) {
                throw new InvalidUrlException();
            }
            byte[] port = unescape(colonPort, Mode.HOST);
            byte[] hostname = Arrays.copyOfRange(host, 1, closeIdx);
            int zone = indexOfSeq(hostname, new byte[] {'%', '2', '5'});
            byte[] unescaped;
            if (zone != -1) {
                byte[] a = unescape(Arrays.copyOfRange(hostname, 0, zone), Mode.HOST);
                byte[] b = unescape(Arrays.copyOfRange(hostname, zone, hostname.length), Mode.ZONE);
                unescaped = concat(a, b);
            } else {
                unescaped = unescape(hostname, Mode.HOST);
            }
            if (!isIpv6Literal(unescaped)) {
                throw new InvalidUrlException();
            }
            return concat(new byte[] {'['}, unescaped, new byte[] {']'}, port);
        }

        int first = indexOf(host, (byte) ':');
        if (first != -1) {
            int idx = first;
            int last = lastIndexOf(host, (byte) ':');
            if (last != first && !"http".equals(scheme) && !"https".equals(scheme)) {
                idx = last;
            }
            if (!validOptionalPort(Arrays.copyOfRange(host, idx, host.length))) {
                throw new InvalidUrlException();
            }
        }
        return unescape(host, Mode.HOST);
    }

    private static void parseAuthority(ParsedUrl url, byte[] authority) {
        int at = lastIndexOf(authority, (byte) '@');
        url.host = parseHost(
                url.scheme,
                at != -1 ? Arrays.copyOfRange(authority, at + 1, authority.length) : authority);
        if (at == -1) {
            return;
        }
        byte[] userinfo = Arrays.copyOfRange(authority, 0, at);
        if (!validUserinfo(userinfo)) {
            throw new InvalidUrlException();
        }
        int colon = indexOf(userinfo, (byte) ':');
        if (colon != -1) {
            unescape(Arrays.copyOfRange(userinfo, 0, colon), Mode.USER_PASSWORD);
            unescape(Arrays.copyOfRange(userinfo, colon + 1, userinfo.length), Mode.USER_PASSWORD);
        } else {
            unescape(userinfo, Mode.USER_PASSWORD);
        }
        url.hasUser = true;
    }

    private static ParsedUrl parseReference(byte[] raw) {
        for (byte c : raw) {
            int b = u(c);
            if (b < 0x20 || b == 0x7F) {
                throw new InvalidUrlException();
            }
        }
        ParsedUrl url = new ParsedUrl();
        if (raw.length == 1 && raw[0] == '*') {
            url.path = new byte[] {'*'};
            return url;
        }
        SplitBytes sp = getScheme(raw);
        byte[] rest = sp.remainder();
        url.scheme = new String(sp.first(), StandardCharsets.US_ASCII).toLowerCase(Locale.ROOT);

        int qCount = 0;
        for (byte c : rest) {
            if (u(c) == '?') {
                qCount++;
            }
        }
        if (rest.length > 0 && u(rest[rest.length - 1]) == '?' && qCount == 1) {
            rest = Arrays.copyOfRange(rest, 0, rest.length - 1);
        } else {
            int q = indexOf(rest, (byte) '?');
            if (q != -1) {
                rest = Arrays.copyOfRange(rest, 0, q);
            }
        }

        if (rest.length == 0 || u(rest[0]) != '/') {
            if (!url.scheme.isEmpty()) {
                url.opaqueText = rest.clone();
                return url;
            }
            int slash = indexOf(rest, (byte) '/');
            byte[] seg = slash != -1 ? Arrays.copyOfRange(rest, 0, slash) : rest;
            if (indexOf(seg, (byte) ':') != -1) {
                throw new InvalidUrlException();
            }
        }

        byte[] twoSlash = new byte[] {'/', '/'};
        byte[] threeSlash = new byte[] {'/', '/', '/'};
        if ((!url.scheme.isEmpty() || !startsWith(rest, threeSlash)) && startsWith(rest, twoSlash)) {
            byte[] authority = Arrays.copyOfRange(rest, 2, rest.length);
            rest = new byte[0];
            int slash = indexOf(authority, (byte) '/');
            if (slash != -1) {
                rest = Arrays.copyOfRange(authority, slash, authority.length);
                authority = Arrays.copyOfRange(authority, 0, slash);
            }
            parseAuthority(url, authority);
        } else if (!url.scheme.isEmpty() && rest.length > 0 && u(rest[0]) == '/') {
            url.omitHost = true;
        }

        url.path = unescape(rest, Mode.PATH);
        byte[] escaped = escape(url.path, Mode.PATH);
        url.rawPath = Arrays.equals(rest, escaped) ? new byte[0] : rest.clone();
        return url;
    }

    private static ParsedUrl parse(byte[] raw) {
        int h = indexOf(raw, (byte) '#');
        ParsedUrl url = parseReference(h != -1 ? Arrays.copyOfRange(raw, 0, h) : raw);
        if (h != -1 && h + 1 < raw.length) {
            unescape(Arrays.copyOfRange(raw, h + 1, raw.length), Mode.FRAGMENT);
        }
        return url;
    }

    private static byte[] escapedPath(ParsedUrl url) {
        if (url.rawPath.length > 0 && validEncoded(url.rawPath, Mode.PATH)) {
            try {
                byte[] p = unescape(url.rawPath, Mode.PATH);
                if (Arrays.equals(p, url.path)) {
                    return url.rawPath;
                }
            } catch (InvalidUrlException ignored) {
                // fall through
            }
        }
        if (url.path.length == 1 && url.path[0] == '*') {
            return new byte[] {'*'};
        }
        return escape(url.path, Mode.PATH);
    }

    private static byte[] format(ParsedUrl url) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!url.scheme.isEmpty()) {
            byte[] sb = url.scheme.getBytes(StandardCharsets.US_ASCII);
            out.write(sb, 0, sb.length);
            out.write(':');
        }
        if (url.opaqueText.length > 0) {
            out.write(url.opaqueText, 0, url.opaqueText.length);
            return out.toByteArray();
        }
        if ((!url.scheme.isEmpty() || url.host.length > 0) && !(url.omitHost && url.host.length == 0)) {
            if (url.host.length > 0 || url.path.length > 0) {
                out.write('/');
                out.write('/');
            }
            if (url.host.length > 0) {
                byte[] eh = escape(url.host, Mode.HOST);
                out.write(eh, 0, eh.length);
            }
        }
        byte[] path = escapedPath(url);
        if (path.length > 0 && u(path[0]) != '/' && url.host.length > 0) {
            out.write('/');
        }
        if (out.size() == 0) {
            int slash = indexOf(path, (byte) '/');
            byte[] seg = slash != -1 ? Arrays.copyOfRange(path, 0, slash) : path;
            if (indexOf(seg, (byte) ':') != -1) {
                out.write('.');
                out.write('/');
            }
        }
        out.write(path, 0, path.length);
        return out.toByteArray();
    }

    public static String sanitize(String raw) {
        if (raw == null) {
            return WITHHELD;
        }
        return sanitizeBytes(raw.getBytes(StandardCharsets.UTF_8));
    }

    public static String sanitizeBytes(byte[] raw) {
        boolean schemeless = indexOfSeq(raw, new byte[] {':', '/', '/'}) == -1;
        byte[] data = schemeless ? concat(new byte[] {'/', '/'}, raw) : raw;
        ParsedUrl url;
        try {
            url = parse(data);
        } catch (InvalidUrlException ex) {
            return WITHHELD;
        }
        if (url.host.length == 0) {
            return WITHHELD;
        }
        int ats = 0;
        for (byte c : data) {
            if (u(c) == '@') {
                ats++;
            }
        }
        if (ats > 1 || (ats == 1 && !url.hasUser)) {
            return WITHHELD;
        }
        byte[] formatted = format(url);
        if (indexOf(formatted, (byte) '@') != -1) {
            return WITHHELD;
        }
        if (schemeless && startsWith(formatted, new byte[] {'/', '/'})) {
            return new String(formatted, 2, formatted.length - 2, StandardCharsets.US_ASCII);
        }
        return new String(formatted, StandardCharsets.US_ASCII);
    }
}
