using System.Reflection;
using OpenTelemetry.Resources;
using Xunit;

namespace Libo11y.Tests;

public sealed class ResourceAndConfigTests
{
    [Theory]
    [InlineData("  ", "attribute-resource", "staging", "2.0.0", "attribute-namespace", "attribute-instance")]
    [InlineData("option-resource", "option-resource", "production", "3.0.0", "option-namespace", "option-instance")]
    public void ResourceIdentity_ResolvesCodeOptionsBeforeEnvironment(
        string serviceName, string expectedName, string expectedEnvironment, string expectedVersion,
        string expectedNamespace, string expectedInstance)
    {
        bool hasOptions = serviceName == "option-resource";
        using var telemetry = O11y.Init(new O11yOptions
        {
            ServiceName = serviceName,
            Environment = hasOptions ? "production" : "  ",
            Version = hasOptions ? "3.0.0" : "  ",
            ServiceNamespace = hasOptions ? "option-namespace" : "  ",
            ServiceInstanceId = hasOptions ? "option-instance" : "  ",
            ConsoleEnabled = false,
            ResourceAttributes = new Dictionary<string, object?>
            {
                ["service.name"] = "attribute-resource",
                ["deployment.environment.name"] = "staging",
                ["service.version"] = "2.0.0",
                ["service.namespace"] = "attribute-namespace",
                ["service.instance.id"] = "attribute-instance",
            },
            Env = new Dictionary<string, string>
            {
                ["OTEL_SDK_DISABLED"] = "true",
                ["OTEL_SERVICE_NAME"] = "env-resource",
                ["OTEL_RESOURCE_ATTRIBUTES"] = "service.name=env-attribute-resource,deployment.environment.name=test,"
                    + "service.version=1.0.0,service.namespace=env-namespace,service.instance.id=env-instance",
            },
        });

        Assert.Equal(expectedName, telemetry.ResourceAttributes["service.name"]);
        Assert.Equal(expectedEnvironment, telemetry.ResourceAttributes["deployment.environment.name"]);
        Assert.Equal(expectedVersion, telemetry.ResourceAttributes["service.version"]);
        Assert.Equal(expectedNamespace, telemetry.ResourceAttributes["service.namespace"]);
        Assert.Equal(expectedInstance, telemetry.ResourceAttributes["service.instance.id"]);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("0.0.0-unknown", false)]
    public void ResourceIdentity_ReportsOnlyAnActualVersionFallback(string? version, bool fallback)
    {
        using var telemetry = O11y.Init(new O11yOptions
        {
            ServiceName = "version-resource",
            Environment = "test",
            Version = version,
            Env = O11yEnv.Hermetic,
            ConsoleEnabled = false,
            RuntimeMetrics = false,
        });

        Assert.Equal("0.0.0-unknown", telemetry.ResourceAttributes["service.version"]);
        Assert.Equal(fallback, telemetry.EffectiveConfig().ContainsKey("service_version_fallback"));
        if (fallback) Assert.Equal("true", telemetry.EffectiveConfig()["service_version_fallback"]);
    }

    [Fact]
    public void ResourceIdentity_ReportsTheInstalledOpenTelemetrySdkVersion()
    {
        using var telemetry = O11y.Init(new O11yOptions
        {
            ServiceName = "sdk-resource",
            Environment = "test",
            Env = O11yEnv.Hermetic,
            ConsoleEnabled = false,
            RuntimeMetrics = false,
        });

        string expectedVersion = typeof(ResourceBuilder).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion.Split('+')[0];
        Assert.Equal(expectedVersion, telemetry.ResourceAttributes["telemetry.sdk.version"]);
    }
}
