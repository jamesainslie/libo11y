using Libo11y.Spec;

if (args.Length < 3 || args[0] != "registry" || args[1] != "check")
{
    Console.Error.WriteLine("usage: libo11y registry check FILE...");
    return 2;
}

int exitCode = 0;
foreach (string file in args.Skip(2))
{
    try
    {
        byte[] raw = File.ReadAllBytes(file);
        var reg = AppRegistryValidator.ParseBytes(raw);
        var violations = AppRegistryValidator.Validate(reg);
        if (violations.Count == 0)
        {
            string noun = reg.Attributes.Count == 1 ? "attribute" : "attributes";
            Console.WriteLine($"{file}: ok ({reg.Attributes.Count} {noun} in namespace {reg.Namespace})");
        }
        else
        {
            foreach (var v in violations)
            {
                Console.WriteLine($"{file}: {v}");
            }
            exitCode = Math.Max(exitCode, 1);
        }
    }
    catch (AppRegistryParseException ex)
    {
        Console.Error.WriteLine($"{file}: {ex.Message}");
        exitCode = 2;
    }
    catch (IOException ex)
    {
        Console.Error.WriteLine($"{file}: {ex.Message}");
        exitCode = 2;
    }
}

return exitCode;
