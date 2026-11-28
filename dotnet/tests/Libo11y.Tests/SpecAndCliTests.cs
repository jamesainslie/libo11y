using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Xml.Linq;
using Libo11y.Cli;
using Libo11y.Spec;
using Xunit;

namespace Libo11y.Tests;

public sealed class SpecAndCliTests : IDisposable
{
    private const string Usage = "usage: libo11y registry check FILE...\n";

    private readonly string _dir;

    public SpecAndCliTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "libo11y-spec-cli-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        // Restore read access so the unreadable-file test can clean up.
        if (!OperatingSystem.IsWindows())
        {
            foreach (string file in Directory.EnumerateFiles(_dir, "*", SearchOption.AllDirectories))
            {
                File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
        Directory.Delete(_dir, recursive: true);
    }

    private static string Registry(string ns, string attributes) =>
        $"schema: libo11y.app-registry/v1\nnamespace: {ns}\nattributes:\n{attributes}";

    private static List<string> Violations(string yaml) =>
        AppRegistryValidator.Validate(AppRegistryValidator.Parse(yaml)).Select(v => v.ToString()).ToList();

    private static string Brief(string yaml) =>
        AppRegistryValidator.Parse(yaml).Attributes["demo.a"].Brief;

    private static string AttributeWithBrief(string briefLines) =>
        Registry("demo", "  demo.a:\n    type: string\n    sensitivity: public\n    cardinality: bounded\n" + briefLines);

    // Finding 1: name patterns anchor at the true end of the text, as Go's do.

    [Fact]
    public void Validate_AttributeKeyEndingInNewline_BreaksTheNamingRule()
    {
        string yaml = Registry("demo", "  \"demo.token\\n\": {type: string, sensitivity: public, cardinality: bounded}\n");

        // Go: the key keeps the namespace prefix, so only specrules.ValidName fails.
        Assert.Equal(
            ["libo11y_attr_naming: attribute demo.token\n: not a dotted snake_case name with at least two segments"],
            Violations(yaml));
    }

    [Fact]
    public void Validate_NamespaceEndingInNewline_IsInvalid()
    {
        string yaml = Registry("\"demo\\n\"", "  demo.a: {type: string, sensitivity: public, cardinality: bounded}\n");

        // Go: namespacePattern fails, and demo.a does not start with "demo\n.".
        Assert.Equal(
            [
                "libo11y_app_namespace_invalid: namespace \"demo\\n\" is not one snake_case segment",
                "libo11y_app_attr_outside_namespace: attribute demo.a: not under the demo\n namespace",
            ],
            Violations(yaml));
    }

    [Theory]
    [InlineData("!!float \"1.5\\n\"", "as a !!float")]
    [InlineData("!!timestamp \"2001-12-14\\n\"", "as a !!timestamp")]
    public void Parse_TaggedScalarEndingInNewline_DoesNotResolveToTheTag(string value, string want)
    {
        var ex = Assert.Throws<AppRegistryParseException>(
            () => AppRegistryValidator.Parse(AttributeWithBrief($"    brief: {value}\n")));
        Assert.Equal("syntax", ex.Kind);
        Assert.Contains(want, ex.Message, StringComparison.Ordinal);
    }

    // Finding 2: the escape preprocessor acts only inside double-quoted scalars.

    [Fact]
    public void Parse_LiteralBlockScalar_KeepsQuotesAndBackslashes()
    {
        string yaml = AttributeWithBrief("    brief: |\n      path \"\\/\" here\n");
        Assert.Equal("path \"\\/\" here\n", Brief(yaml));
    }

    [Fact]
    public void Parse_FoldedBlockScalar_KeepsQuotesAndBackslashes()
    {
        string yaml = AttributeWithBrief("    brief: >\n      a \"\\/\"\n      b\n");
        Assert.Equal("a \"\\/\" b\n", Brief(yaml));
    }

    [Fact]
    public void Parse_StrippedBlockScalar_KeepsApostropheAndHash()
    {
        string yaml = AttributeWithBrief("    brief: |-\n      it's \"\\/\" # not a comment\n\n      second 'line'\n");
        Assert.Equal("it's \"\\/\" # not a comment\n\nsecond 'line'", Brief(yaml));
    }

    [Fact]
    public void Parse_BlockScalar_EndsAtTheNextLessIndentedKey()
    {
        string yaml = Registry("demo",
            "  demo.a:\n    brief: |\n      text \"\\/\"\n    type: \"str\\/ing\"\n    sensitivity: public\n    cardinality: bounded\n");
        var ex = Assert.Throws<AppRegistryParseException>(() => AppRegistryValidator.Parse(yaml));
        Assert.Equal("syntax", ex.Kind);
    }

    [Fact]
    public void Parse_BlockScalar_FollowedByAValidDoubleQuotedValue()
    {
        string yaml = Registry("demo",
            "  demo.a:\n    brief: |\n      text \"\\/\"\n    type: \"string\"\n    sensitivity: public\n    cardinality: bounded\n");
        var reg = AppRegistryValidator.Parse(yaml);
        Assert.Equal("text \"\\/\"\n", reg.Attributes["demo.a"].Brief);
        Assert.Equal("string", reg.Attributes["demo.a"].Type);
    }

    [Fact]
    public void Parse_BlockScalarWithCrlfLineEnds_EndsAtTheNextKey()
    {
        string ok = Registry("demo",
            "  demo.a:\n    brief: |\n      text \"\\/\"\n    type: string\n    sensitivity: public\n    cardinality: bounded\n").Replace("\n", "\r\n");
        Assert.Equal("text \"\\/\"\n", AppRegistryValidator.Parse(ok).Attributes["demo.a"].Brief);

        string bad = ok.Replace("type: string", "type: \"str\\/ing\"", StringComparison.Ordinal);
        Assert.Equal("syntax", Assert.Throws<AppRegistryParseException>(() => AppRegistryValidator.Parse(bad)).Kind);
    }

    [Fact]
    public void Parse_PlainScalar_KeepsQuotesAndBackslashes()
    {
        string yaml = AttributeWithBrief("    brief: say \"\\/\" now\n");
        Assert.Equal("say \"\\/\" now", Brief(yaml));
    }

    [Fact]
    public void Parse_MultiLinePlainScalar_ContinuationMayStartWithAQuote()
    {
        string yaml = AttributeWithBrief("    brief: one\n      \"\\/\" two\n");
        Assert.Equal("one \"\\/\" two", Brief(yaml));
    }

    [Fact]
    public void Parse_ApostropheInPlainScalar_DoesNotHideALaterDoubleQuotedEscape()
    {
        string yaml = Registry("demo",
            "  demo.a:\n    brief: don't\n    type: \"str\\/ing\"\n    sensitivity: public\n    cardinality: bounded\n");
        var ex = Assert.Throws<AppRegistryParseException>(() => AppRegistryValidator.Parse(yaml));
        Assert.Equal("syntax", ex.Kind);
        Assert.Contains("unknown escape", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Parse_SingleQuotedScalar_KeepsDoubleQuotesAndBackslashes()
    {
        string yaml = AttributeWithBrief("    brief: 'a \"\\/\" it''s'\n");
        Assert.Equal("a \"\\/\" it's", Brief(yaml));
    }

    [Fact]
    public void Parse_Comment_KeepsQuotesAndBackslashes()
    {
        string yaml = "# a comment with \"\\/\" and it's\n" + AttributeWithBrief("    brief: ok # trailing \"\\/\"\n");
        Assert.Equal("ok", Brief(yaml));
    }

    [Fact]
    public void Parse_DoubleQuotedScalarAfterATag_IsStillChecked()
    {
        string yaml = AttributeWithBrief("    brief: !!str \"a\\/b\"\n");
        var ex = Assert.Throws<AppRegistryParseException>(() => AppRegistryValidator.Parse(yaml));
        Assert.Equal("syntax", ex.Kind);
    }

    [Fact]
    public void Parse_DoubleQuotedScalarInAFlowMapping_IsStillChecked()
    {
        string yaml = Registry("demo", "  demo.a: {type: string, sensitivity: public, cardinality: bounded, brief: \"a\\/b\"}\n");
        var ex = Assert.Throws<AppRegistryParseException>(() => AppRegistryValidator.Parse(yaml));
        Assert.Equal("syntax", ex.Kind);
    }

    [Fact]
    public void Parse_DoubleQuotedEscapedApostrophe_StillDecodes()
    {
        string yaml = AttributeWithBrief("    brief: \"it\\'s # here\"\n");
        Assert.Equal("it's # here", Brief(yaml));
    }

    // Findings 3 and 4: the CLI matches go/cmd/libo11y.

    private (int Status, string Stdout, string Stderr) RunCli(params string[] args)
    {
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        int status = CommandLine.Run(args, stdout, stderr);
        return (status, stdout.ToString(), stderr.ToString());
    }

    private string WriteFile(string name, string content)
    {
        string path = Path.Combine(_dir, name);
        File.WriteAllText(path, content);
        return path;
    }

    private string ValidFile() =>
        WriteFile("valid.yaml", Registry("lor", "  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n"));

    private string TwoAttributeFile() =>
        WriteFile("two.yaml", Registry("lor",
            "  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n" +
            "  lor.retry.count: {type: int, sensitivity: public, cardinality: bounded}\n"));

    private string ViolationFile() =>
        WriteFile("bad.yaml", Registry("lor",
            "  lor.user.id: {type: text, sensitivity: internal, cardinality: unbounded}\n" +
            "  other.key: {type: string, sensitivity: public, cardinality: bounded}\n"));

    private string ParseErrorFile() =>
        WriteFile("broken.yaml", "schema: libo11y.app-registry/v1\nnamespace: lor\nbogus: 1\n");

    [Theory]
    [InlineData("--help")]
    [InlineData("-h")]
    [InlineData("help")]
    public void Cli_Help_PrintsUsageToStdoutAndExitsZero(string flag)
    {
        Assert.Equal((0, Usage, ""), RunCli(flag));
    }

    [Theory]
    [InlineData("")]
    [InlineData("registry")]
    [InlineData("registry check")]
    [InlineData("registry lint x.yaml")]
    [InlineData("--help extra")]
    [InlineData("check registry x.yaml")]
    public void Cli_UsageError_PrintsUsageToStderrAndExitsTwo(string commandLine)
    {
        string[] args = commandLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal((2, "", Usage), RunCli(args));
    }

    [Fact]
    public void Cli_ValidFile_PrintsOkAndExitsZero()
    {
        string one = ValidFile();
        string two = TwoAttributeFile();
        Assert.Equal(
            (0, $"{one}: ok (1 attribute in namespace lor)\n{two}: ok (2 attributes in namespace lor)\n", ""),
            RunCli("registry", "check", one, two));
    }

    [Fact]
    public void Cli_FileWithViolations_PrintsOneLinePerViolationAndExitsOne()
    {
        string bad = ViolationFile();
        Assert.Equal(
            (1,
             $"{bad}: libo11y_app_type_unknown: attribute lor.user.id: type \"text\"\n" +
             $"{bad}: libo11y_app_attr_outside_namespace: attribute other.key: not under the lor namespace\n",
             ""),
            RunCli("registry", "check", bad));
    }

    [Fact]
    public void Cli_ParseError_PrintsOneLineOnStderrAndExitsTwo()
    {
        string broken = ParseErrorFile();
        var (status, stdout, stderr) = RunCli("registry", "check", broken);
        Assert.Equal(2, status);
        Assert.Equal("", stdout);
        Assert.StartsWith($"{broken}: parsing application registry: unknown-key", stderr, StringComparison.Ordinal);
        Assert.EndsWith("\n", stderr, StringComparison.Ordinal);
        Assert.Single(stderr.TrimEnd('\n').Split('\n'));
    }

    [Fact]
    public void Cli_MissingFile_PrintsTheGoReadErrorAndExitsTwo()
    {
        string missing = Path.Combine(_dir, "missing.yaml");
        Assert.Equal((2, "", $"open {missing}: no such file or directory\n"), RunCli("registry", "check", missing));
    }

    [Fact]
    public void Cli_MissingDirectoryInPath_PrintsTheGoReadErrorAndExitsTwo()
    {
        string missing = Path.Combine(_dir, "nope", "missing.yaml");
        Assert.Equal((2, "", $"open {missing}: no such file or directory\n"), RunCli("registry", "check", missing));
    }

    [Fact]
    public void Cli_Directory_PrintsTheGoReadErrorAndExitsTwo()
    {
        Assert.Equal((2, "", $"read {_dir}: is a directory\n"), RunCli("registry", "check", _dir));
    }

    [Fact]
    public void Cli_UnreadableFile_PrintsTheGoReadErrorAndExitsTwo()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }
        string path = ValidFile();
        File.SetUnixFileMode(path, UnixFileMode.None);
        try
        {
            using (File.OpenRead(path))
            {
            }
            // The process can read the file anyway (it runs as root), so
            // there is no permission error to observe.
            return;
        }
        catch (UnauthorizedAccessException)
        {
        }
        Assert.Equal((2, "", $"open {path}: permission denied\n"), RunCli("registry", "check", path));
    }

    [Fact]
    public void Cli_InvalidPath_PrintsOneLineAndExitsTwo()
    {
        Assert.Equal((2, "", "open bad\0path: invalid argument\n"), RunCli("registry", "check", "bad\0path"));
        Assert.Equal((2, "", "open : no such file or directory\n"), RunCli("registry", "check", ""));
    }

    [Fact]
    public void Cli_SeveralFiles_HighestStatusWinsAndEveryFileIsChecked()
    {
        string valid = ValidFile();
        string bad = ViolationFile();
        string missing = Path.Combine(_dir, "missing.yaml");

        var (status, stdout, stderr) = RunCli("registry", "check", valid, bad);
        Assert.Equal(1, status);
        Assert.Equal("", stderr);
        Assert.StartsWith($"{valid}: ok (1 attribute in namespace lor)\n{bad}: libo11y_app_type_unknown", stdout, StringComparison.Ordinal);

        (status, stdout, stderr) = RunCli("registry", "check", missing, bad, valid);
        Assert.Equal(2, status);
        Assert.Equal($"open {missing}: no such file or directory\n", stderr);
        Assert.Contains($"{bad}: libo11y_app_type_unknown", stdout, StringComparison.Ordinal);
        Assert.EndsWith($"{valid}: ok (1 attribute in namespace lor)\n", stdout, StringComparison.Ordinal);

        (status, _, _) = RunCli("registry", "check", bad, valid);
        Assert.Equal(1, status);

        (status, _, stderr) = RunCli("registry", "check", valid, _dir, valid);
        Assert.Equal(2, status);
        Assert.Equal($"read {_dir}: is a directory\n", stderr);
    }

    // Finding 5: generated metadata cannot be mutated through its public type.

    private static readonly Assembly SpecAssembly = typeof(SpecTables).Assembly;

    private static IEnumerable<Type> SpecTypes() =>
        SpecAssembly.GetTypes().Where(t =>
            t.Namespace == "Libo11y.Spec" &&
            t.GetCustomAttribute<CompilerGeneratedAttribute>() is null &&
            !t.Name.Contains('<', StringComparison.Ordinal));

    [Fact]
    public void SpecTypes_ExposeNoMutableStaticState()
    {
        var problems = new List<string>();
        foreach (var type in SpecTypes())
        {
            foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Static))
            {
                string where = $"{type.Name}.{field.Name}";
                if (!field.IsLiteral && !field.IsInitOnly)
                {
                    problems.Add($"{where} is a writable static field");
                }
                if (field.FieldType.IsArray)
                {
                    problems.Add($"{where} has array type {field.FieldType}");
                }
                CheckValue(where, field.GetValue(null), problems, 0);
            }
            foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Static))
            {
                string where = $"{type.Name}.{prop.Name}";
                if (prop.SetMethod is { IsPublic: true })
                {
                    problems.Add($"{where} has a public setter");
                }
                if (prop.PropertyType.IsArray)
                {
                    problems.Add($"{where} has array type {prop.PropertyType}");
                }
                if (!prop.PropertyType.IsByRefLike)
                {
                    CheckValue(where, prop.GetValue(null), problems, 0);
                }
            }
        }
        Assert.True(problems.Count == 0, string.Join("\n", problems.Distinct()));
    }

    [Fact]
    public void GoPrintRanges_IsNotPublic()
    {
        var type = SpecAssembly.GetType("Libo11y.Spec.GoPrintRanges");
        Assert.NotNull(type);
        Assert.False(type.IsPublic);
        var quote = SpecAssembly.GetType("Libo11y.Spec.GoQuote");
        Assert.NotNull(quote);
        Assert.False(quote.IsPublic);
    }

    private static void CheckValue(string where, object? value, List<string> problems, int depth)
    {
        if (value is null || value is string || depth > 6)
        {
            return;
        }
        var type = value.GetType();
        if (type.IsPrimitive || type.IsEnum)
        {
            return;
        }
        if (value is Array)
        {
            problems.Add($"{where} holds an array ({type}) that a caller can cast back and write");
            return;
        }
        if (value is IList list && !list.IsReadOnly)
        {
            problems.Add($"{where} holds a writable list ({type})");
        }
        if (value is IDictionary dict && !dict.IsReadOnly)
        {
            problems.Add($"{where} holds a writable dictionary ({type})");
        }
        foreach (var iface in type.GetInterfaces())
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition() == typeof(ICollection<>))
            {
                bool readOnly = (bool)iface.GetProperty("IsReadOnly")!.GetValue(value)!;
                if (!readOnly)
                {
                    problems.Add($"{where} holds a writable collection ({type})");
                }
            }
        }
        if (value is IEnumerable items)
        {
            foreach (object? item in items)
            {
                object? element = item;
                if (item is not null && item.GetType().IsGenericType &&
                    item.GetType().GetGenericTypeDefinition() == typeof(KeyValuePair<,>))
                {
                    element = item.GetType().GetProperty("Value")!.GetValue(item);
                }
                CheckValue(where + "[]", element, problems, depth + 1);
            }
            return;
        }
        if (type.Namespace == "Libo11y.Spec")
        {
            foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (prop.GetIndexParameters().Length > 0 || prop.Name == "EqualityContract")
                {
                    continue;
                }
                if (prop.SetMethod is { IsPublic: true } setter &&
                    !setter.ReturnParameter.GetRequiredCustomModifiers().Contains(typeof(IsExternalInit)))
                {
                    problems.Add($"{where}.{prop.Name} has a public setter");
                }
                if (prop.PropertyType.IsArray)
                {
                    problems.Add($"{where}.{prop.Name} has array type {prop.PropertyType}");
                }
                CheckValue($"{where}.{prop.Name}", prop.GetValue(value), problems, depth + 1);
            }
        }
    }

    [Fact]
    public void SpecTables_ListsAreImmutableArrays()
    {
        Assert.NotEmpty(SpecTables.RequiredTier0);
        Assert.Contains("service.name", SpecTables.RequiredTier0);
        Assert.Contains("service.name", SpecTables.MetricResourceLabels);
        var summary = SpecTables.Events[SpecEvents.RequestSummary];
        Assert.Contains("o11y.outcome", summary.Required);
        Assert.Throws<NotSupportedException>(() => ((IList<string>)summary.Required).Add("x"));
        Assert.Throws<NotSupportedException>(() => ((IList<string>)SpecTables.RequiredTier0)[0] = "x");
    }

    // Finding 7 and the doc-comment work: every public member is documented.

    private static Dictionary<string, XElement> DocMembers()
    {
        string xml = Path.ChangeExtension(SpecAssembly.Location, ".xml");
        Assert.True(File.Exists(xml), $"{xml} is missing: Libo11y.Spec must generate its XML documentation file");
        return XDocument.Load(xml).Descendants("member")
            .ToDictionary(m => (string)m.Attribute("name")!, m => m, StringComparer.Ordinal);
    }

    private static string Summary(Dictionary<string, XElement> docs, string id) =>
        docs.TryGetValue(id, out var member) ? (member.Element("summary")?.Value ?? "").Trim() : "";

    private static string DocName(Type t) => t.FullName!.Replace('+', '.');

    [Fact]
    public void SpecAssembly_EveryPublicTypeAndMemberHasASummary()
    {
        var docs = DocMembers();
        var missing = new List<string>();
        foreach (var type in SpecAssembly.GetExportedTypes())
        {
            string typeId = "T:" + DocName(type);
            if (Summary(docs, typeId).Length == 0)
            {
                missing.Add(typeId);
            }
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;
            foreach (var member in type.GetMembers(flags))
            {
                string? prefix = member switch
                {
                    FieldInfo f when !f.IsSpecialName => "F:",
                    PropertyInfo p when p.Name != "EqualityContract" => "P:",
                    MethodInfo m when !m.IsSpecialName && !IsRecordMember(type, m) => "M:",
                    ConstructorInfo c when !type.IsAbstract => "M:",
                    _ => null,
                };
                if (prefix is null)
                {
                    continue;
                }
                string name = member is ConstructorInfo ? "#ctor" : member.Name;
                string id = prefix + DocName(type) + "." + name;
                bool found = docs.Keys.Any(k =>
                    (k == id || k.StartsWith(id + "(", StringComparison.Ordinal)) && Summary(docs, k).Length > 0);
                if (!found)
                {
                    missing.Add(id);
                }
            }
        }
        Assert.True(missing.Count == 0, "undocumented:\n" + string.Join("\n", missing.Distinct()));
    }

    private static bool IsRecordMember(Type type, MethodInfo m)
    {
        bool isRecord = type.GetMethod("<Clone>$") is not null || type.GetProperty("EqualityContract", BindingFlags.NonPublic | BindingFlags.Instance) is not null;
        return isRecord && m.Name is "ToString" or "Equals" or "GetHashCode" or "Deconstruct" or "PrintMembers" or "<Clone>$";
    }

    [Fact]
    public void GeneratedConstants_CarryTheRegistryBriefOnOneLine()
    {
        var docs = DocMembers();
        string outcome = Summary(docs, "F:Libo11y.Spec.SpecAttributes.Outcome");
        Assert.NotEqual("", outcome);
        Assert.DoesNotContain('\n', outcome);
        Assert.Contains("Sensitivity: public.", outcome, StringComparison.Ordinal);
        Assert.Contains("Cardinality: enum.", outcome, StringComparison.Ordinal);

        foreach (var cls in new[] { typeof(SpecAttributes), typeof(SpecEvents), typeof(SpecMetrics), typeof(Signal), typeof(DeploymentEnvironment) })
        {
            foreach (var field in cls.GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.IsLiteral))
            {
                string text = Summary(docs, $"F:{cls.FullName}.{field.Name}");
                Assert.True(text.Length > 0, $"{cls.Name}.{field.Name} has no summary");
                Assert.DoesNotContain('\n', text);
            }
        }

        foreach (var field in typeof(SpecAttributes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            string key = (string)field.GetRawConstantValue()!;
            string text = Summary(docs, $"F:Libo11y.Spec.SpecAttributes.{field.Name}");
            if (SpecTables.SensitivityOf.TryGetValue(key, out var cls))
            {
                Assert.Contains($"Sensitivity: {cls.ToString().ToLowerInvariant()}.", text, StringComparison.Ordinal);
            }
            if (SpecTables.CardinalityOf.TryGetValue(key, out var card))
            {
                Assert.Contains($"Cardinality: {card.ToString().ToLowerInvariant()}.", text, StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public void GoQuote_StillQuotesLikeGo()
    {
        // GoQuote is internal now; Validate's details exercise it.
        string yaml = Registry("lor", "  lor.a: {type: \"t\\u0007\\u00e9\", sensitivity: public, cardinality: bounded}\n");
        Assert.Equal(["libo11y_app_type_unknown: attribute lor.a: type \"t\\aé\""], Violations(yaml));
    }
}
