using System.Diagnostics;
using Libo11y.Testing;
using Xunit;

namespace Libo11y.Tests;

[CollectionDefinition("OTLP process environment", DisableParallelization = true)]
public sealed class OtlpProcessEnvironmentCollection { }

[Collection("OTLP process environment")]
public sealed class OtlpConfigurationTests
{
    [Theory]
    [InlineData(null, "/collector/v1/traces")]
    [InlineData("/dedicated/v1/traces?key=test", "/dedicated/v1/traces")]
    public void HttpEndpoint_AppendsTheSignalPathToTheGeneralEndpointOnly(string? signalPath, string expectedPath)
    {
        using var receiver = new OtlpHttpReceiver();
        var env = TraceEnvironment($"{receiver.Endpoint}/collector/?key=test");
        if (signalPath is not null) env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = receiver.Endpoint + signalPath;

        using var telemetry = O11y.Init(TraceOptions("otlp-endpoint", env));
        ExportSpan(telemetry, "otlp-endpoint");

        Assert.Equal(expectedPath, Assert.Single(receiver.TraceRequests).Path);
    }

    [Theory]
    [InlineData("collector:4317", null, null, "https://collector:4317/")]
    [InlineData("collector:4317", "true", null, "http://collector:4317/")]
    [InlineData("collector:4317", "true", "false", "https://collector:4317/")]
    [InlineData("https://collector:4317", "true", null, "https://collector:4317/")]
    public void GrpcEndpoint_UsesTlsUnlessConfiguredForCleartext(
        string endpoint, string? insecure, string? tracesInsecure, string expectedEndpoint)
    {
        var env = TraceEnvironment(endpoint);
        env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "grpc";
        if (insecure is not null) env["OTEL_EXPORTER_OTLP_INSECURE"] = insecure;
        if (tracesInsecure is not null) env["OTEL_EXPORTER_OTLP_TRACES_INSECURE"] = tracesInsecure;
        using var telemetry = O11y.Init(TraceOptions("otlp-grpc", env));

        Assert.Equal(expectedEndpoint, telemetry.EffectiveConfig()["traces.endpoint"]);
    }

    [Fact]
    public void InvalidEndpoint_ReportsTheEnvironmentVariableWithoutCredentials()
    {
        var env = TraceEnvironment("http://user:private-token@[incomplete");

        var error = Assert.Throws<InvalidOptionException>(() => O11y.Init(TraceOptions("otlp-invalid", env)));
        Assert.Contains("OTEL_EXPORTER_OTLP_ENDPOINT", error.Message);
        Assert.DoesNotContain("private-token", error.ToString());
    }

    [Fact]
    public void Headers_DecodeEscapesOnceAndLetSignalHeadersOverrideGeneralHeaders()
    {
        using var receiver = new OtlpHttpReceiver();
        var env = TraceEnvironment(receiver.Endpoint);
        env["OTEL_EXPORTER_OTLP_HEADERS"] = "x-general=value,X-Routing=general";
        env["OTEL_EXPORTER_OTLP_TRACES_HEADERS"] = "x-routing=one%2Ctwo%3Dthree%2525";

        using var telemetry = O11y.Init(TraceOptions("otlp-headers", env));
        ExportSpan(telemetry, "otlp-headers");

        var request = Assert.Single(receiver.TraceRequests);
        Assert.Equal("value", request.Headers["x-general"]);
        Assert.Equal("one,two=three%25", request.Headers["x-routing"]);
        Assert.DoesNotContain("two", request.Headers.Keys);
    }

    [Fact]
    public void Headers_IgnoreAmbientHeadersWhenUsingAnExplicitEnvironment()
    {
        const string variable = "OTEL_EXPORTER_OTLP_HEADERS";
        string? original = System.Environment.GetEnvironmentVariable(variable);
        try
        {
            System.Environment.SetEnvironmentVariable(variable, "x-ambient=unexpected");
            using var receiver = new OtlpHttpReceiver();
            var env = TraceEnvironment(receiver.Endpoint);
            using var telemetry = O11y.Init(TraceOptions("otlp-isolated-headers", env));
            ExportSpan(telemetry, "otlp-isolated-headers");

            Assert.False(Assert.Single(receiver.TraceRequests).Headers.ContainsKey("x-ambient"));
        }
        finally
        {
            System.Environment.SetEnvironmentVariable(variable, original);
        }
    }

    private static Dictionary<string, string> TraceEnvironment(string endpoint) => new()
    {
        ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint,
        ["OTEL_METRICS_EXPORTER"] = "none",
        ["OTEL_LOGS_EXPORTER"] = "none",
    };

    private static O11yOptions TraceOptions(string serviceName, Dictionary<string, string> env) => new()
    {
        ServiceName = serviceName,
        Environment = "test",
        Env = env,
        ConsoleEnabled = false,
        RuntimeMetrics = false,
    };

    private static void ExportSpan(Telemetry telemetry, string sourceName)
    {
        using var source = new ActivitySource(sourceName);
        source.StartActivity("exported")?.Dispose();
        Assert.True(telemetry.ForceFlush());
    }
}
