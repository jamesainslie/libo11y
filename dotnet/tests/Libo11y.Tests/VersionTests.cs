using System.Reflection;
using Xunit;

namespace Libo11y.Tests;

public sealed class VersionTests
{
    [Fact]
    public void Version_IsTheAssemblyVersionWithoutBuildMetadata()
    {
        string informational = typeof(O11y).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()!
            .InformationalVersion;

        Assert.Equal(informational.Split('+')[0], O11y.Version);
        Assert.DoesNotContain("+", O11y.Version);
        Assert.Matches(@"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$", O11y.Version);
    }

    [Fact]
    public void Resource_ReportsTheLibraryVersionAsTheDistroVersion()
    {
        using var tel = O11y.Init(new O11yOptions
        {
            ServiceName = "checkout",
            Environment = "test",
            Env = O11yEnv.Hermetic,
            RuntimeMetrics = false,
            ConsoleEnabled = false,
        });

        Assert.Equal(O11y.Version, tel.ResourceAttributes["telemetry.distro.version"]);
    }
}
