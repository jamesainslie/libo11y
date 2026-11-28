using System.Diagnostics;
using System.Text;
using Libo11y.Testing;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Libo11y.Tests;

public sealed class WireTests
{
    [Fact]
    public void Recorder_VerifiesThreeWayReconciliationTriangle()
    {
        using var rec = new O11yRecorder(o =>
        {
            o.ActivitySources = ["checkout"];
            o.Meters = ["checkout"];
        });

        using var src = new ActivitySource("checkout");
        var meter = rec.Telemetry.CreateMeter("checkout");
        var hist = meter.CreateHistogram<double>("checkout.duration", unit: "s");

        using (src.StartActivity("POST /checkout"))
        {
            rec.Telemetry.Log(LogLevel.Information, "order placed", new Dictionary<string, object?> { ["order.id"] = "ord-1" });
            hist.Record(0.125, new KeyValuePair<string, object?>("region", "us-west"));
        }

        rec.AssertConforms();
        rec.AssertTriangle();
    }

    [Fact]
    public void OtlpHttpExporter_ShipsAllThreeSignalsAndRedactsSecretsOverWire()
    {
        using var receiver = new OtlpHttpReceiver();
        using var tel = O11y.Init(new O11yOptions
        {
            ServiceName = "wire-service",
            Environment = "staging",
            Version = "2.0.0",
            Env = new Dictionary<string, string>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = receiver.Endpoint,
                ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-api-key=wire-test-key",
                ["OTEL_BSP_SCHEDULE_DELAY"] = "100",
                ["OTEL_BLRP_SCHEDULE_DELAY"] = "100",
                ["OTEL_METRIC_EXPORT_INTERVAL"] = "100",
            },
            ActivitySources = ["wire.src"],
            Meters = ["wire.meter"],
            ConsoleEnabled = false,
            RuntimeMetrics = true,
        });

        using var src = new ActivitySource("wire.src");
        var meter = tel.CreateMeter("wire.meter");
        var counter = meter.CreateCounter<long>("wire.requests");

        using (var span = src.StartActivity("wire.op"))
        {
            span?.SetTag("http.request.header.authorization", "Bearer top-secret-token");
            span?.SetTag("safe.tag", "visible-span-value");
            tel.Log(LogLevel.Information, "wire log", new Dictionary<string, object?>
            {
                ["http.request.header.cookie"] = "sid=supersecretcookie",
                ["ok"] = "visible-log-value",
            });
            counter.Add(1,
                new KeyValuePair<string, object?>("http.request.header.authorization", "Bearer top-secret-token"),
                new KeyValuePair<string, object?>("ok", "visible-metric-value"));
        }

        var report = tel.Shutdown(TimeSpan.FromSeconds(5));
        Assert.True(report.IsOk);

        Assert.NotEmpty(receiver.TraceRequests);
        Assert.NotEmpty(receiver.MetricRequests);
        Assert.NotEmpty(receiver.LogRequests);

        // Verify raw wire payloads contain safe values and never contain leaked secret values
        string traceWire = Encoding.Latin1.GetString(receiver.TraceRequests.SelectMany(r => r.Body).ToArray());
        Assert.Contains("visible-span-value", traceWire);
        Assert.DoesNotContain("top-secret-token", traceWire);

        string logWire = Encoding.Latin1.GetString(receiver.LogRequests.SelectMany(r => r.Body).ToArray());
        Assert.Contains("visible-log-value", logWire);
        Assert.DoesNotContain("supersecretcookie", logWire);

        string metricWire = Encoding.Latin1.GetString(receiver.MetricRequests.SelectMany(r => r.Body).ToArray());
        Assert.Contains("wire.requests", metricWire);
        Assert.DoesNotContain("top-secret-token", metricWire);
    }
}
