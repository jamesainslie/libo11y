package ing.o11y.libo11y.spec;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.yaml.snakeyaml.DumperOptions;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.error.YAMLException;
import org.yaml.snakeyaml.events.AliasEvent;
import org.yaml.snakeyaml.events.DocumentEndEvent;
import org.yaml.snakeyaml.events.DocumentStartEvent;
import org.yaml.snakeyaml.events.Event;
import org.yaml.snakeyaml.events.MappingEndEvent;
import org.yaml.snakeyaml.events.MappingStartEvent;
import org.yaml.snakeyaml.events.ScalarEvent;
import org.yaml.snakeyaml.events.SequenceEndEvent;
import org.yaml.snakeyaml.events.SequenceStartEvent;
import org.yaml.snakeyaml.events.StreamEndEvent;
import org.yaml.snakeyaml.events.StreamStartEvent;
import org.yaml.snakeyaml.parser.Parser;
import org.yaml.snakeyaml.parser.ParserImpl;
import org.yaml.snakeyaml.reader.StreamReader;

final class YamlV3Parser {
    private YamlV3Parser() {}

    static final class SyntaxException extends RuntimeException {
        SyntaxException(String message) {
            super(message);
        }

        SyntaxException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    sealed interface Node permits ScalarNode, SequenceNode, MappingNode, AliasNode {}

    record ScalarNode(String tag, String anchor, String value, boolean quotedOrBlock) implements Node {}

    record SequenceNode(String tag, String anchor, List<Node> items) implements Node {}

    record Pair(Node key, Node value) {}

    record MappingNode(String tag, String anchor, List<Pair> pairs) implements Node {}

    static final class AliasNode implements Node {
        final String targetAnchor;

        AliasNode(String targetAnchor) {
            this.targetAnchor = targetAnchor;
        }
    }

    record Document(Node root, boolean explicitStart, IdentityHashMap<AliasNode, Node> aliases) {}

    record ScalarValue(boolean isNull, String text, boolean isString) {}

    private static final String LONG_TAG_PREFIX = "tag:yaml.org,2002:";
    private static final String TAG_NULL = "!!null";
    private static final String TAG_BOOL = "!!bool";
    private static final String TAG_STR = "!!str";
    private static final String TAG_INT = "!!int";
    private static final String TAG_FLOAT = "!!float";
    private static final String TAG_TIMESTAMP = "!!timestamp";
    private static final String TAG_BINARY = "!!binary";
    private static final String TAG_MERGE = "!!merge";

    private static final int MAX_DEPTH = 10_000;
    private static final double ALIAS_RATIO_LOW = 400_000.0;
    private static final double ALIAS_RATIO_HIGH = 4_000_000.0;

    private static final Set<String> RESOLVABLE_TAGS = Set.of(
            "", TAG_STR, TAG_BOOL, TAG_INT, TAG_FLOAT, TAG_NULL, TAG_TIMESTAMP);

    private static final Set<String> MERGE_TAGS = Set.of("", "!", TAG_MERGE);

    private static final Map<String, String> RESOLVE_MAP = Map.ofEntries(
            Map.entry("true", TAG_BOOL),
            Map.entry("True", TAG_BOOL),
            Map.entry("TRUE", TAG_BOOL),
            Map.entry("false", TAG_BOOL),
            Map.entry("False", TAG_BOOL),
            Map.entry("FALSE", TAG_BOOL),
            Map.entry("", TAG_NULL),
            Map.entry("~", TAG_NULL),
            Map.entry("null", TAG_NULL),
            Map.entry("Null", TAG_NULL),
            Map.entry("NULL", TAG_NULL),
            Map.entry(".nan", TAG_FLOAT),
            Map.entry(".NaN", TAG_FLOAT),
            Map.entry(".NAN", TAG_FLOAT),
            Map.entry(".inf", TAG_FLOAT),
            Map.entry(".Inf", TAG_FLOAT),
            Map.entry(".INF", TAG_FLOAT),
            Map.entry("+.inf", TAG_FLOAT),
            Map.entry("+.Inf", TAG_FLOAT),
            Map.entry("+.INF", TAG_FLOAT),
            Map.entry("-.inf", TAG_FLOAT),
            Map.entry("-.Inf", TAG_FLOAT),
            Map.entry("-.INF", TAG_FLOAT),
            Map.entry("<<", TAG_MERGE));

    private static final Pattern YAML_STYLE_FLOAT_RE = Pattern.compile(
            "^[-+]?(\\.[0-9]+|[0-9]+(\\.[0-9]*)?)([eE][-+]?[0-9]+)?$");

    private static final Pattern DOT_FLOAT_RE = Pattern.compile(
            "^\\.[0-9]+([eE][-+]?[0-9]+)?$");

    private static final Pattern BASE64_RE = Pattern.compile(
            "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$");

    private static final Pattern[] TIMESTAMP_RES = new Pattern[] {
        Pattern.compile("^(\\d{4})-(\\d\\d?)-(\\d\\d?)T(\\d\\d?):(\\d\\d?):(\\d\\d?)(?:[.,]\\d+)?(Z|[+-](\\d\\d):(\\d\\d))$"),
        Pattern.compile("^(\\d{4})-(\\d\\d?)-(\\d\\d?)t(\\d\\d?):(\\d\\d?):(\\d\\d?)(?:[.,]\\d+)?(Z|[+-](\\d\\d):(\\d\\d))$"),
        Pattern.compile("^(\\d{4})-(\\d\\d?)-(\\d\\d?) (\\d\\d?):(\\d\\d?):(\\d\\d?)(?:[.,]\\d+)?$"),
        Pattern.compile("^(\\d{4})-(\\d\\d?)-(\\d\\d?)$"),
    };

    static String decodeInput(byte[] raw) {
        Charset charset;
        int offset;
        if (raw.length >= 2 && (raw[0] & 0xFF) == 0xFF && (raw[1] & 0xFF) == 0xFE) {
            charset = StandardCharsets.UTF_16LE;
            offset = 2;
        } else if (raw.length >= 2 && (raw[0] & 0xFF) == 0xFE && (raw[1] & 0xFF) == 0xFF) {
            charset = StandardCharsets.UTF_16BE;
            offset = 2;
        } else if (raw.length >= 3
                && (raw[0] & 0xFF) == 0xEF
                && (raw[1] & 0xFF) == 0xBB
                && (raw[2] & 0xFF) == 0xBF) {
            charset = StandardCharsets.UTF_8;
            offset = 3;
        } else {
            charset = StandardCharsets.UTF_8;
            offset = 0;
        }

        String text;
        try {
            CharsetDecoder decoder = charset.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            text = decoder.decode(ByteBuffer.wrap(raw, offset, raw.length - offset)).toString();
        } catch (CharacterCodingException ex) {
            throw new SyntaxException("invalid UTF input", ex);
        }

        checkCharacters(text);
        return text;
    }

    static void checkCharacters(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= text.length() || !Character.isLowSurrogate(text.charAt(i + 1))) {
                    throw new SyntaxException(String.format("control characters are not allowed: U+%04X", (int) c));
                }
                i++;
                continue;
            }
            if (Character.isLowSurrogate(c)) {
                throw new SyntaxException(String.format("control characters are not allowed: U+%04X", (int) c));
            }
            int cp = c;
            boolean ok = cp == '\t'
                    || cp == '\n'
                    || cp == '\r'
                    || (cp >= 0x20 && cp <= 0x7E)
                    || cp == 0x85
                    || (cp >= 0xA0 && cp <= 0xD7FF)
                    || (cp >= 0xE000 && cp <= 0xFFFD);
            if (!ok) {
                throw new SyntaxException(String.format("control characters are not allowed: U+%04X", cp));
            }
        }
    }

    private static String preprocessDoubleQuotedEscapes(String text) {
        StringBuilder sb = new StringBuilder(text.length());
        int i = 0;
        int len = text.length();
        boolean inSingle = false;
        boolean inDouble = false;
        boolean inComment = false;

        while (i < len) {
            char ch = text.charAt(i);
            if (inComment) {
                sb.append(ch);
                if (ch == '\n' || ch == '\r') {
                    inComment = false;
                }
                i++;
            } else if (inSingle) {
                sb.append(ch);
                if (ch == '\'') {
                    if (i + 1 < len && text.charAt(i + 1) == '\'') {
                        sb.append('\'');
                        i += 2;
                    } else {
                        inSingle = false;
                        i++;
                    }
                } else {
                    i++;
                }
            } else if (inDouble) {
                if (ch == '\\') {
                    if (i + 1 >= len) {
                        throw new SyntaxException("unterminated escape in double-quoted scalar");
                    }
                    char nxt = text.charAt(i + 1);
                    if (nxt == '/') {
                        throw new SyntaxException("found unknown escape character '/'");
                    }
                    if (nxt == '\'') {
                        sb.append('\'');
                        i += 2;
                    } else if (nxt == 'u' && i + 5 < len) {
                        String hex = text.substring(i + 2, i + 6);
                        try {
                            int cp = Integer.parseInt(hex, 16);
                            if (cp >= 0xD800 && cp <= 0xDFFF) {
                                throw new SyntaxException("found invalid Unicode character escape code");
                            }
                        } catch (NumberFormatException ignored) {
                            // let YAML parser reject invalid hex
                        }
                        sb.append(ch).append(nxt);
                        i += 2;
                    } else {
                        sb.append(ch).append(nxt);
                        i += 2;
                    }
                } else {
                    sb.append(ch);
                    if (ch == '"') {
                        inDouble = false;
                    }
                    i++;
                }
            } else {
                if (ch == '#' && (i == 0 || isCommentBoundary(text.charAt(i - 1)))) {
                    inComment = true;
                } else if (ch == '\'') {
                    inSingle = true;
                } else if (ch == '"') {
                    inDouble = true;
                }
                sb.append(ch);
                i++;
            }
        }
        return sb.toString();
    }

    private static final Pattern YAML_DIRECTIVE_RE = Pattern.compile("^%YAML[ \\t]+(\\d+)\\.(\\d+)(?:[ \\t]*(?:#.*)?)?$");

    private static void checkYamlDirectives(String text) {
        // Check %YAML directives at column 0 before document start or after '...'.
        String[] lines = text.split("\\r?\\n", -1);
        boolean inDirectiveZone = true;
        for (String line : lines) {
            if (inDirectiveZone) {
                if (line.startsWith("%YAML")) {
                    Matcher m = YAML_DIRECTIVE_RE.matcher(line);
                    if (!m.matches()) {
                        throw new SyntaxException("found incompatible YAML directive");
                    }
                    int major = Integer.parseInt(m.group(1));
                    int minor = Integer.parseInt(m.group(2));
                    if (major != 1 || minor != 1) {
                        throw new SyntaxException("found incompatible YAML document");
                    }
                } else if (line.startsWith("%TAG") || line.trim().isEmpty() || line.trim().startsWith("#")) {
                    // still in directive header
                } else if (line.equals("---") || line.startsWith("--- ") || line.startsWith("---\t")) {
                    inDirectiveZone = false;
                } else {
                    inDirectiveZone = false;
                }
            } else if (line.equals("...") || line.startsWith("... ") || line.startsWith("...\t")) {
                inDirectiveZone = true;
            }
        }
    }

    private static boolean isCommentBoundary(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r';
    }

    static List<Document> parseDocuments(String text) {
        checkCharacters(text);
        checkYamlDirectives(text);
        String normalized = preprocessDoubleQuotedEscapes(text);
        List<Document> docs = new ArrayList<>();
        try {
            LoaderOptions opts = new LoaderOptions();
            opts.setCodePointLimit(Math.max(normalized.length() + 1024, 3 * 1024 * 1024));
            opts.setNestingDepthLimit(MAX_DEPTH + 10);
            opts.setAllowDuplicateKeys(true);
            opts.setAllowRecursiveKeys(true);

            Parser parser = new ParserImpl(new StreamReader(normalized), opts);
            Event first = parser.getEvent();
            if (!(first instanceof StreamStartEvent)) {
                return docs;
            }
            while (parser.peekEvent() != null) {
                Event ev = parser.getEvent();
                if (ev instanceof StreamEndEvent) {
                    break;
                }
                if (!(ev instanceof DocumentStartEvent docStart)) {
                    throw new SyntaxException("unexpected YAML event " + ev);
                }
                DumperOptions.Version version = docStart.getVersion();
                if (version != null && (version.major() != 1 || version.minor() != 1)) {
                    throw new SyntaxException("found incompatible YAML document");
                }
                Map<String, Node> anchors = new HashMap<>();
                IdentityHashMap<AliasNode, Node> aliases = new IdentityHashMap<>();
                if (parser.peekEvent() == null) {
                    throw new SyntaxException("unexpected end of YAML stream");
                }
                Node root = composeNode(parser, anchors, aliases, 0);
                Event end = parser.getEvent();
                if (!(end instanceof DocumentEndEvent)) {
                    throw new SyntaxException("expected document end, got " + end);
                }
                docs.add(new Document(root, docStart.getExplicit(), aliases));
            }
        } catch (SyntaxException ex) {
            throw ex;
        } catch (YAMLException ex) {
            throw new SyntaxException(ex.getMessage(), ex);
        }
        return docs;
    }

    private static Node composeNode(
            Parser parser,
            Map<String, Node> anchors,
            IdentityHashMap<AliasNode, Node> aliases,
            int depth) {
        if (depth > MAX_DEPTH) {
            throw new SyntaxException("the document nests too deeply");
        }
        Event ev = parser.getEvent();
        if (ev instanceof AliasEvent aliasEv) {
            String name = aliasEv.getAnchor();
            Node target = anchors.get(name);
            if (target == null) {
                throw new SyntaxException("unknown anchor '" + name + "' referenced");
            }
            AliasNode node = new AliasNode(name);
            aliases.put(node, target);
            return node;
        }
        if (ev instanceof ScalarEvent scalarEv) {
            boolean quotedOrBlock = scalarEv.getScalarStyle() != DumperOptions.ScalarStyle.PLAIN;
            String tag = scalarEv.getTag();
            String anchor = scalarEv.getAnchor();
            ScalarNode node = new ScalarNode(tag, anchor, scalarEv.getValue(), quotedOrBlock);
            if (anchor != null) {
                anchors.put(anchor, node);
            }
            return node;
        }
        if (ev instanceof SequenceStartEvent seqStart) {
            String tag = seqStart.getTag();
            String anchor = seqStart.getAnchor();
            List<Node> items = new ArrayList<>();
            SequenceNode seq = new SequenceNode(tag, anchor, items);
            if (anchor != null) {
                anchors.put(anchor, seq);
            }
            while (parser.peekEvent() != null && !(parser.peekEvent() instanceof SequenceEndEvent)) {
                items.add(composeNode(parser, anchors, aliases, depth + 1));
            }
            if (!(parser.getEvent() instanceof SequenceEndEvent)) {
                throw new SyntaxException("unexpected end of sequence");
            }
            return seq;
        }
        if (ev instanceof MappingStartEvent mapStart) {
            String tag = mapStart.getTag();
            String anchor = mapStart.getAnchor();
            List<Pair> pairs = new ArrayList<>();
            MappingNode mp = new MappingNode(tag, anchor, pairs);
            if (anchor != null) {
                anchors.put(anchor, mp);
            }
            while (parser.peekEvent() != null && !(parser.peekEvent() instanceof MappingEndEvent)) {
                Node key = composeNode(parser, anchors, aliases, depth + 1);
                if (parser.peekEvent() == null) {
                    throw new SyntaxException("unexpected end of mapping");
                }
                Node val = composeNode(parser, anchors, aliases, depth + 1);
                pairs.add(new Pair(key, val));
            }
            if (!(parser.getEvent() instanceof MappingEndEvent)) {
                throw new SyntaxException("unexpected end of mapping");
            }
            return mp;
        }
        throw new SyntaxException("unexpected YAML event " + ev);
    }

    static String shortTag(String tag) {
        if (tag == null || tag.isEmpty()) {
            return "";
        }
        if (tag.startsWith(LONG_TAG_PREFIX)) {
            return "!!" + tag.substring(LONG_TAG_PREFIX.length());
        }
        return tag;
    }

    private static char hint(String s) {
        if (s.isEmpty()) {
            return 'N';
        }
        char c = s.charAt(0);
        if (c == '+' || c == '-') {
            return 'S';
        }
        if (c >= '0' && c <= '9') {
            return 'D';
        }
        if ("yYnNtTfFoO~".indexOf(c) >= 0) {
            return 'M';
        }
        return c == '.' ? '.' : '\0';
    }

    private static boolean tryParseUnsignedDigits(String s, int numBase, long[] out) {
        if (s.isEmpty()) {
            return false;
        }
        long result = 0L;
        long ub = Integer.toUnsignedLong(numBase);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            int d;
            if (ch >= '0' && ch <= '9') {
                d = ch - '0';
            } else if (ch >= 'a' && ch <= 'z') {
                d = ch - 'a' + 10;
            } else if (ch >= 'A' && ch <= 'Z') {
                d = ch - 'A' + 10;
            } else {
                return false;
            }
            if (d >= numBase) {
                return false;
            }
            long maxBeforeMul = Long.divideUnsigned(-1L - Integer.toUnsignedLong(d), ub);
            if (Long.compareUnsigned(result, maxBeforeMul) > 0) {
                return false;
            }
            result = result * ub + Integer.toUnsignedLong(d);
        }
        out[0] = result;
        return true;
    }

    private static boolean tryGoParseUInt(String s, int numBase, long[] out) {
        if (s.isEmpty()) {
            return false;
        }
        int b = numBase;
        String digits = s;
        if (numBase == 0) {
            b = 10;
            if (s.charAt(0) == '0') {
                char p = s.length() > 1 ? Character.toLowerCase(s.charAt(1)) : '\0';
                if (s.length() >= 3 && p == 'b') {
                    b = 2;
                    digits = s.substring(2);
                } else if (s.length() >= 3 && p == 'o') {
                    b = 8;
                    digits = s.substring(2);
                } else if (s.length() >= 3 && p == 'x') {
                    b = 16;
                    digits = s.substring(2);
                } else {
                    b = 8;
                    digits = s.substring(1);
                    if (digits.isEmpty() && s.equals("0")) {
                        out[0] = 0L;
                        return true;
                    }
                }
            }
        }
        return tryParseUnsignedDigits(digits, b, out);
    }

    private static boolean tryGoParseInt(String s, int numBase) {
        if (s.isEmpty()) {
            return false;
        }
        boolean negative = s.charAt(0) == '-';
        String body = (s.charAt(0) == '+' || s.charAt(0) == '-') ? s.substring(1) : s;
        long[] out = new long[1];
        if (!tryGoParseUInt(body, numBase, out)) {
            return false;
        }
        long limit = negative ? Long.MIN_VALUE : Long.MAX_VALUE;
        return Long.compareUnsigned(out[0], limit) <= 0;
    }

    private static boolean isFiniteFloat(String s) {
        try {
            double v = Double.parseDouble(s);
            return Double.isFinite(v);
        } catch (NumberFormatException ex) {
            return false;
        }
    }

    private static int daysIn(int month, int year) {
        return switch (month) {
            case 2 -> (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28;
            case 4, 6, 9, 11 -> 30;
            default -> 31;
        };
    }

    private static boolean isTimestamp(String s) {
        if (s.length() < 5
                || s.charAt(0) < '0' || s.charAt(0) > '9'
                || s.charAt(1) < '0' || s.charAt(1) > '9'
                || s.charAt(2) < '0' || s.charAt(2) > '9'
                || s.charAt(3) < '0' || s.charAt(3) > '9'
                || s.charAt(4) != '-') {
            return false;
        }
        for (Pattern re : TIMESTAMP_RES) {
            Matcher m = re.matcher(s);
            if (!m.matches()) {
                continue;
            }
            int year = Integer.parseInt(m.group(1));
            int month = Integer.parseInt(m.group(2));
            int day = Integer.parseInt(m.group(3));
            int hour = m.groupCount() >= 4 && m.group(4) != null ? Integer.parseInt(m.group(4)) : 0;
            int minute = m.groupCount() >= 5 && m.group(5) != null ? Integer.parseInt(m.group(5)) : 0;
            int second = m.groupCount() >= 6 && m.group(6) != null ? Integer.parseInt(m.group(6)) : 0;
            if (month < 1 || month > 12 || day < 1 || day > daysIn(month, year)) {
                continue;
            }
            if (hour > 23 || minute > 59 || second > 59) {
                continue;
            }
            if (m.groupCount() >= 9 && m.group(8) != null && m.group(9) != null) {
                if (Integer.parseInt(m.group(8)) > 24 || Integer.parseInt(m.group(9)) > 60) {
                    continue;
                }
            }
            return true;
        }
        return false;
    }

    private record Classified(String tag, boolean unsigned) {}

    private static Classified classify(String tag, String s) {
        char h = hint(s);
        if (h == '\0' || TAG_STR.equals(tag)) {
            return new Classified(TAG_STR, false);
        }
        String mapped = RESOLVE_MAP.get(s);
        if (mapped != null) {
            return new Classified(mapped, false);
        }
        if (h == '.' && DOT_FLOAT_RE.matcher(s).matches() && isFiniteFloat(s)) {
            return new Classified(TAG_FLOAT, false);
        }
        if (h == 'D' || h == 'S') {
            if ((tag.isEmpty() || TAG_TIMESTAMP.equals(tag)) && isTimestamp(s)) {
                return new Classified(TAG_TIMESTAMP, false);
            }
            String plain = s.replace("_", "");
            long[] out = new long[1];
            if (tryGoParseInt(plain, 0)) {
                return new Classified(TAG_INT, false);
            }
            if (tryGoParseUInt(plain, 0, out)) {
                return new Classified(TAG_INT, true);
            }
            if (YAML_STYLE_FLOAT_RE.matcher(plain).matches() && isFiniteFloat(plain)) {
                return new Classified(TAG_FLOAT, false);
            }
            if (plain.startsWith("0b")) {
                if (tryGoParseInt(plain.substring(2), 2)) {
                    return new Classified(TAG_INT, false);
                }
                if (tryGoParseUInt(plain.substring(2), 2, out)) {
                    return new Classified(TAG_INT, true);
                }
            } else if (plain.startsWith("-0b") && tryGoParseInt("-" + plain.substring(3), 2)) {
                return new Classified(TAG_INT, false);
            }
            if (plain.startsWith("0o")) {
                if (tryGoParseInt(plain.substring(2), 8)) {
                    return new Classified(TAG_INT, false);
                }
                if (tryGoParseUInt(plain.substring(2), 8, out)) {
                    return new Classified(TAG_INT, true);
                }
            } else if (plain.startsWith("-0o") && tryGoParseInt("-" + plain.substring(3), 8)) {
                return new Classified(TAG_INT, false);
            }
        }
        return new Classified(TAG_STR, false);
    }

    private static String decodeBase64(String s) {
        String compact = s.replace("\r", "").replace("\n", "");
        if (!BASE64_RE.matcher(compact).matches()) {
            throw new SyntaxException("!!binary value contains invalid base64 data");
        }
        byte[] raw = Base64.getDecoder().decode(compact);
        return new String(raw, StandardCharsets.UTF_8);
    }

    static ScalarValue resolveScalar(String tag, String value, boolean quotedOrBlock) {
        String shortTag = shortTag(tag);
        if (TAG_STR.equals(shortTag) || ((shortTag.isEmpty() || "!".equals(shortTag)) && quotedOrBlock)) {
            return new ScalarValue(false, value, true);
        }
        if (!RESOLVABLE_TAGS.contains(shortTag)) {
            if (TAG_BINARY.equals(shortTag)) {
                return new ScalarValue(false, decodeBase64(value), true);
            }
            return new ScalarValue(false, value, true);
        }
        Classified c = classify(shortTag, value);
        String resolvedTag = c.tag();
        if (TAG_FLOAT.equals(shortTag) && TAG_INT.equals(resolvedTag) && !c.unsigned()) {
            resolvedTag = TAG_FLOAT;
        }
        if (!shortTag.isEmpty() && !shortTag.equals(resolvedTag)) {
            throw new SyntaxException("cannot decode " + resolvedTag + " `" + value + "` as a " + shortTag);
        }
        if (TAG_NULL.equals(resolvedTag)) {
            return new ScalarValue(true, "", false);
        }
        return new ScalarValue(false, value, TAG_STR.equals(resolvedTag) || TAG_MERGE.equals(resolvedTag));
    }

    static double allowedAliasRatio(int decodes) {
        if (decodes <= ALIAS_RATIO_LOW) {
            return 0.99;
        }
        if (decodes >= ALIAS_RATIO_HIGH) {
            return 0.10;
        }
        return 0.99 - 0.89 * ((decodes - ALIAS_RATIO_LOW) / (ALIAS_RATIO_HIGH - ALIAS_RATIO_LOW));
    }

    static boolean isMergeKey(Node node) {
        return node instanceof ScalarNode s
                && !s.quotedOrBlock()
                && "<<".equals(s.value())
                && MERGE_TAGS.contains(shortTag(s.tag()));
    }
}
