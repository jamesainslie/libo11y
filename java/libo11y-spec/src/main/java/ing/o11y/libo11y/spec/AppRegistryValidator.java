package ing.o11y.libo11y.spec;

import ing.o11y.libo11y.spec.generated.SpecTables;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import java.util.function.Function;
import java.util.regex.Pattern;

/** Strict YAML application attribute registry parser and validator matching libo11y conformance. */
public final class AppRegistryValidator {
    private AppRegistryValidator() {}

    public record AppRegistryAttribute(
            String type,
            String sensitivity,
            String cardinality,
            List<String> values,
            String brief) {}

    public record AppRegistry(
            String schema,
            String namespace,
            Map<String, AppRegistryAttribute> attributes) {}

    public record AppRegistryViolation(
            String ruleId,
            String attribute,
            String detail) {
        @Override
        public String toString() {
            return attribute == null
                    ? ruleId + ": " + detail
                    : ruleId + ": attribute " + attribute + ": " + detail;
        }
    }

    public record CompiledAppRegistry(
            String namespace,
            Map<String, SpecTables.Sensitivity> classes,
            String source) {}

    public static final class AppRegistryParseException extends RuntimeException {
        private static final Map<String, String> MESSAGES = Map.of(
                "empty", "the file holds no YAML document",
                "second-document", "an application registry holds one YAML document, found a second",
                "duplicate-key", "a mapping repeats a key",
                "unknown-key", "a key the schema does not define",
                "type", "a value of the wrong YAML type",
                "syntax", "the file is not valid YAML");

        private final String kind;

        public AppRegistryParseException(String kind) {
            this(kind, null, null);
        }

        public AppRegistryParseException(String kind, String detail, Throwable cause) {
            super("parsing application registry: " + kind + ": " + (detail != null ? detail : MESSAGES.get(kind)), cause);
            this.kind = kind;
        }

        public String kind() {
            return kind;
        }
    }

    public static final class AppRegistryValidationException extends RuntimeException {
        private final List<AppRegistryViolation> violations;

        public AppRegistryValidationException(List<AppRegistryViolation> violations) {
            super("invalid application registry: "
                    + String.join("; ", violations.stream().map(AppRegistryViolation::toString).toList()));
            this.violations = List.copyOf(violations);
        }

        public List<AppRegistryViolation> violations() {
            return violations;
        }
    }

    private static final Set<String> REGISTRY_FIELDS = Set.of("schema", "namespace", "attributes");
    private static final Set<String> ATTRIBUTE_FIELDS = Set.of("type", "sensitivity", "cardinality", "values", "brief");
    private static final Set<String> ATTRIBUTE_TYPES = Set.of(
            "string", "boolean", "int", "double", "string[]", "boolean[]", "int[]", "double[]");
    private static final Set<String> SENSITIVITIES = Set.of("public", "internal", "pii", "secret");
    private static final Set<String> CARDINALITIES = Set.of("enum", "bounded", "unbounded");

    private static final Pattern NAMESPACE_RE = Pattern.compile("^[a-z][a-z0-9]*(_[a-z0-9]+)*$");
    private static final Pattern NAME_RE = Pattern.compile("^[a-z][a-z0-9]*(_[a-z0-9]+)*(\\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$");

    private static boolean isGoWhitespace(char c) {
        return switch (c) {
            case '\t', '\n', '\u000B', '\f', '\r', ' ', '\u0085', '\u00A0', '\u1680',
                    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006',
                    '\u2007', '\u2008', '\u2009', '\u200A', '\u2028', '\u2029', '\u202F',
                    '\u205F', '\u3000' -> true;
            default -> false;
        };
    }

    private static String goTrimSpace(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isGoWhitespace(s.charAt(start))) {
            start++;
        }
        while (end > start && isGoWhitespace(s.charAt(end - 1))) {
            end--;
        }
        return s.substring(start, end);
    }

    private static int compareUtf8(String a, String b) {
        byte[] ba = a.getBytes(StandardCharsets.UTF_8);
        byte[] bb = b.getBytes(StandardCharsets.UTF_8);
        return Arrays.compareUnsigned(ba, bb);
    }

    private static final class Decoder {
        private final IdentityHashMap<YamlV3Parser.AliasNode, YamlV3Parser.Node> aliases;
        private final Set<YamlV3Parser.AliasNode> expanding = Collections.newSetFromMap(new IdentityHashMap<>());
        private int decodes;
        private int aliasDecodes;
        private int aliasDepth;
        private boolean duplicate;
        private boolean unknown;
        private boolean wrongType;

        Decoder(IdentityHashMap<YamlV3Parser.AliasNode, YamlV3Parser.Node> aliases) {
            this.aliases = aliases;
        }

        void count() {
            decodes++;
            if (aliasDepth > 0) {
                aliasDecodes++;
            }
            if (aliasDecodes > 100
                    && decodes > 1000
                    && ((double) aliasDecodes / decodes) > YamlV3Parser.allowedAliasRatio(decodes)) {
                throw new YamlV3Parser.SyntaxException("document contains excessive aliasing");
            }
        }

        String problem() {
            if (duplicate) {
                return "duplicate-key";
            }
            if (unknown) {
                return "unknown-key";
            }
            if (wrongType) {
                return "type";
            }
            return null;
        }

        private <T> T decodeNode(YamlV3Parser.Node raw, Function<YamlV3Parser.Node, T> fn) {
            count();
            if (!(raw instanceof YamlV3Parser.AliasNode alias)) {
                return fn.apply(raw);
            }
            if (!expanding.add(alias)) {
                throw new YamlV3Parser.SyntaxException("anchor '" + alias.targetAnchor + "' value contains itself");
            }
            YamlV3Parser.Node target = aliases.get(alias);
            aliasDepth++;
            try {
                return decodeNode(target, fn);
            } finally {
                aliasDepth--;
                expanding.remove(alias);
            }
        }

        private static YamlV3Parser.ScalarValue resolve(YamlV3Parser.ScalarNode s) {
            return YamlV3Parser.resolveScalar(s.tag(), s.value(), s.quotedOrBlock());
        }

        private boolean nullOrWrongScalar(YamlV3Parser.Node node) {
            if (!(node instanceof YamlV3Parser.ScalarNode s)) {
                return false;
            }
            if (!resolve(s).isNull()) {
                wrongType = true;
            }
            return true;
        }

        private static String nodeIdentity(YamlV3Parser.Node node) {
            if (node instanceof YamlV3Parser.ScalarNode s) {
                return "scalar:" + s.value();
            }
            if (node instanceof YamlV3Parser.AliasNode a) {
                return "alias:" + a.targetAnchor;
            }
            if (node instanceof YamlV3Parser.MappingNode) {
                return "map:";
            }
            return "seq:";
        }

        private boolean hasDuplicates(YamlV3Parser.MappingNode mp) {
            Set<String> seen = new HashSet<>();
            for (YamlV3Parser.Pair p : mp.pairs()) {
                if (!seen.add(nodeIdentity(p.key()))) {
                    duplicate = true;
                    return true;
                }
            }
            return false;
        }

        private String decodeString(YamlV3Parser.Node raw) {
            return decodeNode(raw, node -> {
                if (node instanceof YamlV3Parser.ScalarNode s) {
                    YamlV3Parser.ScalarValue v = resolve(s);
                    return v.isNull() ? null : v.text();
                }
                if (!(node instanceof YamlV3Parser.MappingNode mp && hasDuplicates(mp))) {
                    wrongType = true;
                }
                return null;
            });
        }

        private List<String> decodeStrings(YamlV3Parser.Node raw) {
            return decodeNode(raw, node -> {
                if (nullOrWrongScalar(node)) {
                    return null;
                }
                if (!(node instanceof YamlV3Parser.SequenceNode seq)) {
                    if (!(node instanceof YamlV3Parser.MappingNode mp && hasDuplicates(mp))) {
                        wrongType = true;
                    }
                    return null;
                }
                List<String> list = new ArrayList<>();
                for (YamlV3Parser.Node item : seq.items()) {
                    String s = decodeString(item);
                    if (s != null) {
                        list.add(s);
                    }
                }
                return list;
            });
        }

        private void decodeMapping(
                YamlV3Parser.Node raw,
                BiConsumer<String, YamlV3Parser.Node> onKey,
                Set<String> merged) {
            decodeNode(raw, node -> {
                if (nullOrWrongScalar(node)) {
                    return null;
                }
                if (!(node instanceof YamlV3Parser.MappingNode mp)) {
                    wrongType = true;
                    return null;
                }
                if (hasDuplicates(mp)) {
                    return null;
                }
                YamlV3Parser.Node mergeNode = null;
                boolean hasMerge = false;
                for (YamlV3Parser.Pair p : mp.pairs()) {
                    if (YamlV3Parser.isMergeKey(p.key())) {
                        mergeNode = p.value();
                        hasMerge = true;
                        continue;
                    }
                    String name = decodeString(p.key());
                    if (name == null) {
                        continue;
                    }
                    if (merged != null && !merged.add(name)) {
                        continue;
                    }
                    onKey.accept(name, p.value());
                }
                if (hasMerge && mergeNode != null) {
                    merge(mp, mergeNode, onKey, merged);
                }
                return null;
            });
        }

        private boolean isMap(YamlV3Parser.Node n) {
            YamlV3Parser.Node target = (n instanceof YamlV3Parser.AliasNode a) ? aliases.get(a) : n;
            return target instanceof YamlV3Parser.MappingNode;
        }

        private void merge(
                YamlV3Parser.MappingNode parent,
                YamlV3Parser.Node source,
                BiConsumer<String, YamlV3Parser.Node> onKey,
                Set<String> merged) {
            Set<String> keys = merged != null ? merged : new HashSet<>();
            if (merged == null) {
                for (YamlV3Parser.Pair p : parent.pairs()) {
                    String ks = decodeNode(p.key(), n -> {
                        if (!(n instanceof YamlV3Parser.ScalarNode s)) {
                            return null;
                        }
                        YamlV3Parser.ScalarValue v = resolve(s);
                        return !v.isNull() && v.isString() ? v.text() : null;
                    });
                    if (ks != null) {
                        keys.add(ks);
                    }
                }
            }
            if (source instanceof YamlV3Parser.SequenceNode seq) {
                for (YamlV3Parser.Node item : seq.items()) {
                    if (!isMap(item)) {
                        throw new YamlV3Parser.SyntaxException("map merge requires map or sequence of maps as the value");
                    }
                    decodeMapping(item, onKey, keys);
                }
                return;
            }
            if (!isMap(source)) {
                throw new YamlV3Parser.SyntaxException("map merge requires map or sequence of maps as the value");
            }
            decodeMapping(source, onKey, keys);
        }

        private void decodeStruct(
                YamlV3Parser.Node raw,
                Set<String> fields,
                BiConsumer<String, YamlV3Parser.Node> onField) {
            Set<String> done = new HashSet<>();
            decodeMapping(raw, (name, val) -> {
                if (!fields.contains(name)) {
                    unknown = true;
                    return;
                }
                if (!done.add(name)) {
                    wrongType = true;
                    return;
                }
                onField.accept(name, val);
            }, null);
        }

        private AppRegistryAttribute decodeAttribute(YamlV3Parser.Node raw) {
            String[] fields = new String[] {"", "", "", ""}; // type, sensitivity, cardinality, brief
            AtomicReference<List<String>> valuesRef = new AtomicReference<>(List.of());

            decodeStruct(raw, ATTRIBUTE_FIELDS, (fieldName, val) -> {
                if ("values".equals(fieldName)) {
                    List<String> parsed = decodeStrings(val);
                    if (parsed != null) {
                        valuesRef.set(List.copyOf(parsed));
                    }
                    return;
                }
                String s = decodeString(val);
                if (s == null) {
                    return;
                }
                switch (fieldName) {
                    case "type" -> fields[0] = s;
                    case "sensitivity" -> fields[1] = s;
                    case "cardinality" -> fields[2] = s;
                    case "brief" -> fields[3] = s;
                    default -> {}
                }
            });
            return new AppRegistryAttribute(fields[0], fields[1], fields[2], valuesRef.get(), fields[3]);
        }

        private Map<String, AppRegistryAttribute> decodeAttributes(YamlV3Parser.Node raw) {
            Map<String, AppRegistryAttribute> out = new LinkedHashMap<>();
            decodeMapping(raw, (name, val) -> out.put(name, decodeAttribute(val)), null);
            return out;
        }

        AppRegistry decodeRegistry(YamlV3Parser.Node raw) {
            String[] top = new String[] {"", ""}; // schema, namespace
            AtomicReference<Map<String, AppRegistryAttribute>> attrsRef =
                    new AtomicReference<>(new LinkedHashMap<>());

            decodeStruct(raw, REGISTRY_FIELDS, (fieldName, val) -> {
                if ("attributes".equals(fieldName)) {
                    attrsRef.set(decodeAttributes(val));
                    return;
                }
                String s = decodeString(val);
                if (s == null) {
                    return;
                }
                if ("schema".equals(fieldName)) {
                    top[0] = s;
                } else {
                    top[1] = s;
                }
            });
            return new AppRegistry(top[0], top[1], Collections.unmodifiableMap(attrsRef.get()));
        }
    }

    public static AppRegistry parse(String text) {
        try {
            List<YamlV3Parser.Document> docs = YamlV3Parser.parseDocuments(text);
            if (docs.isEmpty()) {
                throw new AppRegistryParseException("empty");
            }
            YamlV3Parser.Document first = docs.get(0);
            Decoder decoder = new Decoder(first.aliases());
            decoder.count();
            AppRegistry reg = decoder.decodeRegistry(first.root());
            String problem = decoder.problem();
            if (problem != null) {
                throw new AppRegistryParseException(problem);
            }
            if (docs.size() > 1) {
                throw new AppRegistryParseException("second-document");
            }
            return reg;
        } catch (YamlV3Parser.SyntaxException ex) {
            throw new AppRegistryParseException("syntax", ex.getMessage(), ex);
        }
    }

    public static AppRegistry parseBytes(byte[] raw) {
        try {
            String text = YamlV3Parser.decodeInput(raw);
            return parse(text);
        } catch (YamlV3Parser.SyntaxException ex) {
            throw new AppRegistryParseException("syntax", ex.getMessage(), ex);
        }
    }

    public static List<AppRegistryViolation> validate(AppRegistry reg) {
        List<AppRegistryViolation> violations = new ArrayList<>();
        if (!SpecTables.APP_REGISTRY_SCHEMA.equals(reg.schema())) {
            violations.add(new AppRegistryViolation(
                    "libo11y_app_schema_unknown",
                    null,
                    "schema " + GoQuote.quote(reg.schema()) + ", want " + GoQuote.quote(SpecTables.APP_REGISTRY_SCHEMA)));
        }
        if (!NAMESPACE_RE.matcher(reg.namespace()).matches()) {
            violations.add(new AppRegistryViolation(
                    "libo11y_app_namespace_invalid",
                    null,
                    "namespace " + GoQuote.quote(reg.namespace()) + " is not one snake_case segment"));
        } else if (SpecTables.APP_RESERVED_NAMESPACES.contains(reg.namespace())) {
            violations.add(new AppRegistryViolation(
                    "libo11y_app_namespace_reserved",
                    null,
                    "namespace " + GoQuote.quote(reg.namespace()) + " belongs to libo11y, OpenTelemetry, or semconv"));
        }

        List<String> names = new ArrayList<>(reg.attributes().keySet());
        names.sort(AppRegistryValidator::compareUtf8);
        if (names.isEmpty()) {
            violations.add(new AppRegistryViolation(
                    "libo11y_app_attributes_empty",
                    null,
                    "the registry declares no attributes"));
        }

        for (String name : names) {
            AppRegistryAttribute a = reg.attributes().get(name);
            if (!name.startsWith(reg.namespace() + ".")) {
                violations.add(new AppRegistryViolation(
                        "libo11y_app_attr_outside_namespace",
                        name,
                        "not under the " + reg.namespace() + " namespace"));
            }
            if (!NAME_RE.matcher(name).matches()) {
                violations.add(new AppRegistryViolation(
                        "libo11y_attr_naming",
                        name,
                        "not a dotted snake_case name with at least two segments"));
            }
            if (!ATTRIBUTE_TYPES.contains(a.type())) {
                violations.add(new AppRegistryViolation(
                        "libo11y_app_type_unknown",
                        name,
                        "type " + GoQuote.quote(a.type())));
            }

            if (a.sensitivity().isEmpty()) {
                violations.add(new AppRegistryViolation(
                        "libo11y_sensitivity_missing",
                        name,
                        "no sensitivity class"));
            } else if (!SENSITIVITIES.contains(a.sensitivity())) {
                violations.add(new AppRegistryViolation(
                        "libo11y_sensitivity_unknown",
                        name,
                        "sensitivity " + GoQuote.quote(a.sensitivity())));
            }

            if (a.cardinality().isEmpty()) {
                violations.add(new AppRegistryViolation(
                        "libo11y_cardinality_missing",
                        name,
                        "no cardinality budget"));
            } else if (!CARDINALITIES.contains(a.cardinality())) {
                violations.add(new AppRegistryViolation(
                        "libo11y_cardinality_unknown",
                        name,
                        "cardinality " + GoQuote.quote(a.cardinality())));
            }

            if ("enum".equals(a.cardinality()) && a.values().isEmpty()) {
                violations.add(new AppRegistryViolation(
                        "libo11y_app_enum_values_missing",
                        name,
                        "an enum declares its values"));
            } else if (!"enum".equals(a.cardinality()) && !a.values().isEmpty()) {
                violations.add(new AppRegistryViolation(
                        "libo11y_app_values_without_enum",
                        name,
                        "values need cardinality enum"));
            }

            Set<String> seen = new HashSet<>();
            for (String v : a.values()) {
                String trimmed = goTrimSpace(v);
                if (!v.equals(trimmed)) {
                    violations.add(new AppRegistryViolation(
                            "libo11y_enum_value_whitespace",
                            name,
                            "value " + GoQuote.quote(v)));
                }
                if (!seen.add(trimmed)) {
                    violations.add(new AppRegistryViolation(
                            "libo11y_enum_duplicate_value",
                            name,
                            "value " + GoQuote.quote(v)));
                }
            }
        }
        return Collections.unmodifiableList(violations);
    }

    public static CompiledAppRegistry compile(AppRegistry reg, String source) {
        List<AppRegistryViolation> violations = validate(reg);
        if (!violations.isEmpty()) {
            throw new AppRegistryValidationException(violations);
        }
        Map<String, SpecTables.Sensitivity> classes = new LinkedHashMap<>();
        for (Map.Entry<String, AppRegistryAttribute> entry : reg.attributes().entrySet()) {
            SpecTables.Sensitivity sens = switch (entry.getValue().sensitivity()) {
                case "public" -> SpecTables.Sensitivity.PUBLIC;
                case "internal" -> SpecTables.Sensitivity.INTERNAL;
                case "pii" -> SpecTables.Sensitivity.PII;
                case "secret" -> SpecTables.Sensitivity.SECRET;
                default -> throw new IllegalStateException("unknown sensitivity " + entry.getValue().sensitivity());
            };
            classes.put(entry.getKey(), sens);
        }
        return new CompiledAppRegistry(reg.namespace(), Collections.unmodifiableMap(classes), source);
    }

    public static CompiledAppRegistry loadFile(Path path) throws IOException {
        byte[] raw = Files.readAllBytes(path);
        return compile(parseBytes(raw), path.toString());
    }
}
