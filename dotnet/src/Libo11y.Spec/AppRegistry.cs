using System.Collections.Frozen;
using System.Text;
using System.Text.RegularExpressions;

namespace Libo11y.Spec;

/// <summary>
/// One attribute an application registry declares: its type, sensitivity class,
/// cardinality budget, enum values and description, as written in the file.
/// </summary>
/// <param name="Type">The semconv attribute type, such as <c>string</c> or <c>int[]</c>.</param>
/// <param name="Sensitivity">The sensitivity class: <c>public</c>, <c>internal</c>, <c>pii</c> or <c>secret</c>.</param>
/// <param name="Cardinality">The cardinality budget: <c>enum</c>, <c>bounded</c> or <c>unbounded</c>.</param>
/// <param name="Values">The allowed values of an <c>enum</c> attribute, in file order, or empty.</param>
/// <param name="Brief">The attribute's short description, or empty.</param>
public sealed record AppRegistryAttribute(
    string Type,
    string Sensitivity,
    string Cardinality,
    IReadOnlyList<string> Values,
    string Brief);

/// <summary>
/// A parsed application registry (SPEC section 5a). Parsing does not apply the
/// policy rules: call <see cref="AppRegistryValidator.Validate(AppRegistry)"/> for those.
/// </summary>
/// <param name="Schema">The registry schema, which must be <see cref="SpecTables.AppRegistrySchema"/>.</param>
/// <param name="Namespace">The one snake_case segment every attribute name starts with.</param>
/// <param name="Attributes">The declared attributes, keyed by attribute name.</param>
public sealed record AppRegistry(
    string Schema,
    string Namespace,
    IReadOnlyDictionary<string, AppRegistryAttribute> Attributes);

/// <summary>
/// One policy rule an application registry breaks.
/// </summary>
/// <param name="RuleId">The rule ID, such as <c>libo11y_app_namespace_invalid</c>.</param>
/// <param name="Attribute">The attribute the rule is about, or <see langword="null"/> for a rule about the registry as a whole.</param>
/// <param name="Detail">What is wrong, in the words the Go validator uses.</param>
public sealed record AppRegistryViolation(
    string RuleId,
    string? Attribute,
    string Detail)
{
    /// <summary>
    /// Formats the violation as <c>RULE_ID: detail</c>, or
    /// <c>RULE_ID: attribute NAME: detail</c> for an attribute rule, the line
    /// <c>libo11y registry check</c> prints after the file name.
    /// </summary>
    /// <returns>The formatted violation.</returns>
    public override string ToString() =>
        Attribute is null
            ? $"{RuleId}: {Detail}"
            : $"{RuleId}: attribute {Attribute}: {Detail}";
}

/// <summary>
/// A validated application registry reduced to what the sensitivity policy
/// applies at runtime: the sensitivity class of each declared key.
/// </summary>
/// <param name="Namespace">The registry's namespace.</param>
/// <param name="Classes">The sensitivity class of each declared attribute name.</param>
/// <param name="Source">Where the registry came from, such as its file path, or <see langword="null"/>.</param>
public sealed record CompiledAppRegistry(
    string Namespace,
    FrozenDictionary<string, Sensitivity> Classes,
    string? Source);

/// <summary>
/// The error an application registry that cannot be parsed raises. Its
/// message starts with <c>parsing application registry:</c>.
/// </summary>
public sealed class AppRegistryParseException : Exception
{
    private static readonly FrozenDictionary<string, string> Messages = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["empty"] = "the file holds no YAML document",
        ["second-document"] = "an application registry holds one YAML document, found a second",
        ["duplicate-key"] = "a mapping repeats a key",
        ["unknown-key"] = "a key the schema does not define",
        ["type"] = "a value of the wrong YAML type",
        ["syntax"] = "the file is not valid YAML",
    }.ToFrozenDictionary(StringComparer.Ordinal);

    /// <summary>
    /// The kind of parse error, the same for every implementation: <c>empty</c>,
    /// <c>second-document</c>, <c>duplicate-key</c>, <c>unknown-key</c>,
    /// <c>type</c> or <c>syntax</c>.
    /// </summary>
    public string Kind { get; }

    internal AppRegistryParseException(string kind, string? detail = null, Exception? inner = null)
        : base($"parsing application registry: {kind}: {detail ?? Messages[kind]}", inner)
    {
        Kind = kind;
    }
}

/// <summary>
/// The error <see cref="AppRegistryValidator.Compile(AppRegistry, string?)"/> raises
/// for a registry that breaks one or more policy rules.
/// </summary>
public sealed class AppRegistryValidationException : Exception
{
    /// <summary>Every rule the registry breaks, in the order the validator reports them.</summary>
    public IReadOnlyList<AppRegistryViolation> Violations { get; }

    /// <summary>
    /// Creates the error for <paramref name="violations"/>. Its message lists
    /// every violation, separated by semicolons.
    /// </summary>
    /// <param name="violations">The rules the registry breaks.</param>
    public AppRegistryValidationException(IReadOnlyList<AppRegistryViolation> violations)
        : base("invalid application registry: " + string.Join("; ", violations.Select(v => v.ToString())))
    {
        Violations = violations;
    }
}

/// <summary>
/// Parses, validates and compiles application attribute registries (SPEC
/// section 5a), with the same results and messages as the Go reference
/// implementation in <c>go/internal/appregistry</c>.
/// </summary>
public static class AppRegistryValidator
{
    private static readonly HashSet<string> RegistryFields = ["schema", "namespace", "attributes"];
    private static readonly HashSet<string> AttributeFields = ["type", "sensitivity", "cardinality", "values", "brief"];
    private static readonly HashSet<string> AttributeTypes =
        ["string", "boolean", "int", "double", "string[]", "boolean[]", "int[]", "double[]"];
    private static readonly HashSet<string> Sensitivities = ["public", "internal", "pii", "secret"];
    private static readonly HashSet<string> Cardinalities = ["enum", "bounded", "unbounded"];

    // Go's regexp anchors $ at the end of the text, but .NET's $ also matches
    // before a final newline, so every pattern ends in \z instead.
    private static readonly Regex NamespaceRe = new(@"^[a-z][a-z0-9]*(_[a-z0-9]+)*\z", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex NameRe = new(@"^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+\z", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly char[] GoWhitespaceChars =
    [
        '\t', '\n', '\v', '\f', '\r', ' ', '\u0085', '\u00A0', '\u1680',
        '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006',
        '\u2007', '\u2008', '\u2009', '\u200A', '\u2028', '\u2029', '\u202F',
        '\u205F', '\u3000',
    ];

    private static string GoTrimSpace(string s) => s.Trim(GoWhitespaceChars);

    private static int CompareUtf8(string a, string b)
    {
        var ba = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return ba.AsSpan().SequenceCompareTo(bb);
    }

    private sealed class Decoder(Dictionary<YamlV3Alias, YamlV3Node> aliases)
    {
        private readonly HashSet<YamlV3Alias> _expanding = new(ReferenceEqualityComparer.Instance);
        private int _decodes;
        private int _aliasDecodes;
        private int _aliasDepth;
        private bool _duplicate;
        private bool _unknown;
        private bool _wrongType;

        public void Count()
        {
            _decodes++;
            if (_aliasDepth > 0)
            {
                _aliasDecodes++;
            }
            if (_aliasDecodes > 100 && _decodes > 1000 &&
                ((double)_aliasDecodes / _decodes) > YamlV3Parser.AllowedAliasRatio(_decodes))
            {
                throw new YamlV3SyntaxException("document contains excessive aliasing");
            }
        }

        public string? Problem()
        {
            if (_duplicate) return "duplicate-key";
            if (_unknown) return "unknown-key";
            if (_wrongType) return "type";
            return null;
        }

        private T DecodeNode<T>(YamlV3Node raw, Func<YamlV3Node, T> fn)
        {
            Count();
            if (raw is not YamlV3Alias alias)
            {
                return fn(raw);
            }
            if (!_expanding.Add(alias))
            {
                throw new YamlV3SyntaxException($"anchor '{alias.TargetAnchor}' value contains itself");
            }
            var target = aliases[alias];
            _aliasDepth++;
            try
            {
                return DecodeNode(target, fn);
            }
            finally
            {
                _aliasDepth--;
                _expanding.Remove(alias);
            }
        }

        private static ScalarValue Resolve(YamlV3Scalar s) =>
            YamlV3Parser.ResolveScalar(s.Tag, s.Value, s.QuotedOrBlock);

        private bool NullOrWrongScalar(YamlV3Node node)
        {
            if (node is not YamlV3Scalar s) return false;
            if (!Resolve(s).IsNull) _wrongType = true;
            return true;
        }

        private static string NodeIdentity(YamlV3Node node) => node switch
        {
            YamlV3Scalar s => "scalar:" + s.Value,
            YamlV3Alias a => "alias:" + a.TargetAnchor,
            YamlV3Mapping => "map:",
            _ => "seq:",
        };

        private bool HasDuplicates(YamlV3Mapping mp)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (k, _) in mp.Pairs)
            {
                if (!seen.Add(NodeIdentity(k)))
                {
                    _duplicate = true;
                    return true;
                }
            }
            return false;
        }

        private string? DecodeString(YamlV3Node raw) =>
            DecodeNode(raw, node =>
            {
                if (node is YamlV3Scalar s)
                {
                    var v = Resolve(s);
                    return v.IsNull ? null : v.Text;
                }
                if (!(node is YamlV3Mapping mp && HasDuplicates(mp)))
                {
                    _wrongType = true;
                }
                return null;
            });

        private List<string>? DecodeStrings(YamlV3Node raw) =>
            DecodeNode(raw, node =>
            {
                if (NullOrWrongScalar(node)) return null;
                if (node is not YamlV3Sequence seq)
                {
                    if (!(node is YamlV3Mapping mp && HasDuplicates(mp)))
                    {
                        _wrongType = true;
                    }
                    return null;
                }
                var list = new List<string>();
                foreach (var item in seq.Items)
                {
                    var s = DecodeString(item);
                    if (s is not null) list.Add(s);
                }
                return list;
            });

        private void DecodeMapping(YamlV3Node raw, Action<string, YamlV3Node> onKey, HashSet<string>? merged = null)
        {
            DecodeNode(raw, node =>
            {
                if (NullOrWrongScalar(node)) return 0;
                if (node is not YamlV3Mapping mp)
                {
                    _wrongType = true;
                    return 0;
                }
                if (HasDuplicates(mp)) return 0;

                YamlV3Node? mergeNode = null;
                bool hasMerge = false;
                foreach (var (k, v) in mp.Pairs)
                {
                    if (YamlV3Parser.IsMergeKey(k))
                    {
                        mergeNode = v;
                        hasMerge = true;
                        continue;
                    }
                    var name = DecodeString(k);
                    if (name is null) continue;
                    if (merged is not null && !merged.Add(name))
                    {
                        continue;
                    }
                    onKey(name, v);
                }
                if (hasMerge && mergeNode is not null)
                {
                    Merge(mp, mergeNode, onKey, merged);
                }
                return 0;
            });
        }

        private void Merge(YamlV3Mapping parent, YamlV3Node source, Action<string, YamlV3Node> onKey, HashSet<string>? merged)
        {
            var keys = merged ?? new HashSet<string>(StringComparer.Ordinal);
            if (merged is null)
            {
                foreach (var (k, _) in parent.Pairs)
                {
                    var ks = DecodeNode(k, n =>
                    {
                        if (n is not YamlV3Scalar s) return null;
                        var v = Resolve(s);
                        return !v.IsNull && v.IsString ? v.Text : null;
                    });
                    if (ks is not null) keys.Add(ks);
                }
            }

            bool IsMap(YamlV3Node n)
            {
                var target = n is YamlV3Alias a ? aliases[a] : n;
                return target is YamlV3Mapping;
            }

            if (source is YamlV3Sequence seq)
            {
                foreach (var item in seq.Items)
                {
                    if (!IsMap(item))
                    {
                        throw new YamlV3SyntaxException("map merge requires map or sequence of maps as the value");
                    }
                    DecodeMapping(item, onKey, keys);
                }
                return;
            }
            if (!IsMap(source))
            {
                throw new YamlV3SyntaxException("map merge requires map or sequence of maps as the value");
            }
            DecodeMapping(source, onKey, keys);
        }

        private void DecodeStruct(YamlV3Node raw, HashSet<string> fields, Action<string, YamlV3Node> onField)
        {
            var done = new HashSet<string>(StringComparer.Ordinal);
            DecodeMapping(raw, (name, val) =>
            {
                if (!fields.Contains(name))
                {
                    _unknown = true;
                    return;
                }
                if (!done.Add(name))
                {
                    _wrongType = true;
                    return;
                }
                onField(name, val);
            });
        }

        private AppRegistryAttribute DecodeAttribute(YamlV3Node raw)
        {
            string type = "";
            string sensitivity = "";
            string cardinality = "";
            IReadOnlyList<string> values = Array.Empty<string>();
            string brief = "";

            DecodeStruct(raw, AttributeFields, (fieldName, val) =>
            {
                if (fieldName == "values")
                {
                    var parsed = DecodeStrings(val);
                    if (parsed is not null) values = parsed;
                    return;
                }
                var s = DecodeString(val);
                if (s is null) return;
                switch (fieldName)
                {
                    case "type": type = s; break;
                    case "sensitivity": sensitivity = s; break;
                    case "cardinality": cardinality = s; break;
                    case "brief": brief = s; break;
                }
            });

            return new AppRegistryAttribute(type, sensitivity, cardinality, values, brief);
        }

        private Dictionary<string, AppRegistryAttribute> DecodeAttributes(YamlV3Node raw)
        {
            var outMap = new Dictionary<string, AppRegistryAttribute>(StringComparer.Ordinal);
            DecodeMapping(raw, (name, val) =>
            {
                outMap[name] = DecodeAttribute(val);
            });
            return outMap;
        }

        public AppRegistry DecodeRegistry(YamlV3Node raw)
        {
            string schema = "";
            string ns = "";
            var attributes = new Dictionary<string, AppRegistryAttribute>(StringComparer.Ordinal);

            DecodeStruct(raw, RegistryFields, (fieldName, val) =>
            {
                if (fieldName == "attributes")
                {
                    attributes = DecodeAttributes(val);
                    return;
                }
                var s = DecodeString(val);
                if (s is null) return;
                if (fieldName == "schema") schema = s;
                else ns = s;
            });

            return new AppRegistry(schema, ns, attributes);
        }
    }

    /// <summary>
    /// Parses registry YAML strictly: an unknown key, a repeated key, a value of
    /// the wrong type, a second YAML document and an empty document are errors.
    /// Parsing does not apply the policy rules.
    /// </summary>
    /// <param name="text">The registry file's text.</param>
    /// <returns>The parsed registry.</returns>
    /// <exception cref="AppRegistryParseException">The text is not a registry document.</exception>
    public static AppRegistry Parse(string text)
    {
        try
        {
            var docs = YamlV3Parser.ParseDocuments(text);
            if (docs.Count == 0)
            {
                throw new AppRegistryParseException("empty");
            }
            var first = docs[0];
            var decoder = new Decoder(first.Aliases);
            decoder.Count();
            var reg = decoder.DecodeRegistry(first.Root);
            var problem = decoder.Problem();
            if (problem is not null)
            {
                throw new AppRegistryParseException(problem);
            }
            if (docs.Count > 1)
            {
                throw new AppRegistryParseException("second-document");
            }
            return reg;
        }
        catch (YamlV3SyntaxException ex)
        {
            throw new AppRegistryParseException("syntax", ex.Message, ex);
        }
    }

    /// <summary>
    /// Decodes registry file bytes (UTF-8, or UTF-16 with a byte order mark) and
    /// parses them like <see cref="Parse(string)"/>.
    /// </summary>
    /// <param name="raw">The registry file's bytes.</param>
    /// <returns>The parsed registry.</returns>
    /// <exception cref="AppRegistryParseException">The bytes are not valid text or not a registry document.</exception>
    public static AppRegistry ParseBytes(ReadOnlySpan<byte> raw)
    {
        try
        {
            string text = YamlV3Parser.DecodeInput(raw);
            return Parse(text);
        }
        catch (YamlV3SyntaxException ex)
        {
            throw new AppRegistryParseException("syntax", ex.Message, ex);
        }
    }

    /// <summary>
    /// Applies the policy rules and returns every violation: the rules about the
    /// registry as a whole first, then each attribute in byte order of its name.
    /// </summary>
    /// <param name="reg">The registry to check.</param>
    /// <returns>The violations, or an empty list for a valid registry.</returns>
    public static IReadOnlyList<AppRegistryViolation> Validate(AppRegistry reg)
    {
        var violations = new List<AppRegistryViolation>();
        void Fail(string rule, string? attr, string detail) =>
            violations.Add(new AppRegistryViolation(rule, attr, detail));

        if (reg.Schema != SpecTables.AppRegistrySchema)
        {
            Fail(
                "libo11y_app_schema_unknown",
                null,
                $"schema {GoQuote.Quote(reg.Schema)}, want {GoQuote.Quote(SpecTables.AppRegistrySchema)}");
        }
        if (!NamespaceRe.IsMatch(reg.Namespace))
        {
            Fail(
                "libo11y_app_namespace_invalid",
                null,
                $"namespace {GoQuote.Quote(reg.Namespace)} is not one snake_case segment");
        }
        else if (SpecTables.AppReservedNamespaces.Contains(reg.Namespace))
        {
            Fail(
                "libo11y_app_namespace_reserved",
                null,
                $"namespace {GoQuote.Quote(reg.Namespace)} belongs to libo11y, OpenTelemetry, or semconv");
        }

        var names = reg.Attributes.Keys.ToList();
        names.Sort(CompareUtf8);
        if (names.Count == 0)
        {
            Fail("libo11y_app_attributes_empty", null, "the registry declares no attributes");
        }

        foreach (string name in names)
        {
            var a = reg.Attributes[name];
            if (!name.StartsWith(reg.Namespace + ".", StringComparison.Ordinal))
            {
                Fail("libo11y_app_attr_outside_namespace", name, $"not under the {reg.Namespace} namespace");
            }
            if (!NameRe.IsMatch(name))
            {
                Fail("libo11y_attr_naming", name, "not a dotted snake_case name with at least two segments");
            }
            if (!AttributeTypes.Contains(a.Type))
            {
                Fail("libo11y_app_type_unknown", name, $"type {GoQuote.Quote(a.Type)}");
            }

            if (string.IsNullOrEmpty(a.Sensitivity))
            {
                Fail("libo11y_sensitivity_missing", name, "no sensitivity class");
            }
            else if (!Sensitivities.Contains(a.Sensitivity))
            {
                Fail("libo11y_sensitivity_unknown", name, $"sensitivity {GoQuote.Quote(a.Sensitivity)}");
            }

            if (string.IsNullOrEmpty(a.Cardinality))
            {
                Fail("libo11y_cardinality_missing", name, "no cardinality budget");
            }
            else if (!Cardinalities.Contains(a.Cardinality))
            {
                Fail("libo11y_cardinality_unknown", name, $"cardinality {GoQuote.Quote(a.Cardinality)}");
            }

            if (a.Cardinality == "enum" && a.Values.Count == 0)
            {
                Fail("libo11y_app_enum_values_missing", name, "an enum declares its values");
            }
            else if (a.Cardinality != "enum" && a.Values.Count > 0)
            {
                Fail("libo11y_app_values_without_enum", name, "values need cardinality enum");
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (string v in a.Values)
            {
                string trimmed = GoTrimSpace(v);
                if (v != trimmed)
                {
                    Fail("libo11y_enum_value_whitespace", name, $"value {GoQuote.Quote(v)}");
                }
                if (!seen.Add(trimmed))
                {
                    Fail("libo11y_enum_duplicate_value", name, $"value {GoQuote.Quote(v)}");
                }
            }
        }

        return violations;
    }

    /// <summary>
    /// Validates <paramref name="reg"/> and reduces it to the sensitivity class of each key.
    /// </summary>
    /// <param name="reg">The registry to compile.</param>
    /// <param name="source">Where the registry came from, kept for diagnostics.</param>
    /// <returns>The compiled registry.</returns>
    /// <exception cref="AppRegistryValidationException">The registry breaks a policy rule.</exception>
    public static CompiledAppRegistry Compile(AppRegistry reg, string? source = null)
    {
        var violations = Validate(reg);
        if (violations.Count > 0)
        {
            throw new AppRegistryValidationException(violations);
        }

        var classes = new Dictionary<string, Sensitivity>(StringComparer.Ordinal);
        foreach (var (name, attr) in reg.Attributes)
        {
            classes[name] = attr.Sensitivity switch
            {
                "public" => Sensitivity.Public,
                "internal" => Sensitivity.Internal,
                "pii" => Sensitivity.Pii,
                "secret" => Sensitivity.Secret,
                _ => throw new InvalidOperationException($"unknown sensitivity {attr.Sensitivity}"),
            };
        }
        return new CompiledAppRegistry(reg.Namespace, classes.ToFrozenDictionary(), source);
    }

    /// <summary>
    /// Reads, parses and compiles the registry file at <paramref name="path"/>.
    /// </summary>
    /// <param name="path">The registry file's path.</param>
    /// <returns>The compiled registry, with <paramref name="path"/> as its source.</returns>
    /// <exception cref="IOException">The file cannot be read.</exception>
    /// <exception cref="UnauthorizedAccessException">The file cannot be opened for reading.</exception>
    /// <exception cref="AppRegistryParseException">The file is not a registry document.</exception>
    /// <exception cref="AppRegistryValidationException">The registry breaks a policy rule.</exception>
    public static CompiledAppRegistry LoadFile(string path)
    {
        byte[] raw = File.ReadAllBytes(path);
        return Compile(ParseBytes(raw), path);
    }
}
