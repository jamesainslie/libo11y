using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Libo11y.Spec;
using Libo11y.Testing;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using Xunit;

namespace Libo11y.Tests;

[CollectionDefinition("GlobalSetup", DisableParallelization = true)]
public sealed class GlobalSetupCollection;

[Collection("GlobalSetup")]
public sealed class CoreTests : IDisposable
{
    public void Dispose() => O11y.ResetGlobalForTesting();

    [Fact]
    public void Init_RefusesMissingOrInvalidIdentity()
    {
        Assert.Throws<NoServiceNameException>(() =>
            O11y.Init(new O11yOptions { Environment = DeploymentEnvironment.Production, Env = O11yEnv.Hermetic }));

        Assert.Throws<NoServiceNameException>(() =>
            O11y.Init(new O11yOptions { ServiceName = "unknown_service", Environment = "production", Env = O11yEnv.Hermetic }));

        Assert.Throws<NoEnvironmentException>(() =>
            O11y.Init(new O11yOptions { ServiceName = "checkout", Env = O11yEnv.Hermetic }));

        Assert.Throws<InvalidEnvironmentException>(() =>
            O11y.Init(new O11yOptions { ServiceName = "checkout", Environment = "qa", Env = O11yEnv.Hermetic }));
    }

    [Fact]
    public void Init_AllowsCustomEnvironmentAndStrictIdentityOptOut()
    {
        using var tel = O11y.Init(new O11yOptions
        {
            ServiceName = "checkout",
            Environment = "canary",
            ExtraEnvironments = ["canary"],
            Env = O11yEnv.Hermetic,
            RuntimeMetrics = false,
        });

        Assert.Equal("canary", tel.ResourceAttributes["deployment.environment.name"]);
        Assert.Equal("0.0.0-unknown", tel.ResourceAttributes["service.version"]);
        Assert.Equal(SpecConstants.SchemaUrl, tel.SchemaUrl);
        Assert.True(tel.Shutdown().IsOk);

        using var rec = new O11yRecorder(o =>
        {
            o.ServiceName = "";
            o.Environment = "";
            o.StrictIdentity = false;
        });
        var metrics = rec.Metrics();
        Assert.Contains(metrics, m => m.Name == SpecMetrics.SchemaViolations);
    }

    [Fact]
    public void Setup_EmitsCanaryAndRejectsDoubleSetupAndBrokenSink()
    {
        var console = new StringWriter();
        using var tel = O11y.Setup(new O11yOptions
        {
            ServiceName = "checkout",
            Environment = "production",
            Env = O11yEnv.Hermetic,
            ConsoleWriter = console,
            RuntimeMetrics = false,
        });

        Assert.Throws<AlreadySetupException>(() =>
            O11y.Setup(new O11yOptions { ServiceName = "checkout", Environment = "production", Env = O11yEnv.Hermetic }));

        string outText = console.ToString();
        Assert.Contains(SpecEvents.TelemetryConfigured, outText);
        Assert.Contains("o11y.config.service.name", outText);
        Assert.True(tel.Shutdown().IsOk);

        // Broken sink rejects canary
        Assert.Throws<CanaryRejectedException>(() =>
            O11y.Setup(new O11yOptions
            {
                ServiceName = "checkout",
                Environment = "production",
                Env = O11yEnv.Hermetic,
                ConsoleEnabled = false,
                RuntimeMetrics = false,
                ExtraLogSinks = [_ => throw new InvalidOperationException("broken sink")],
            }));
    }

    [Fact]
    public void Init_HonorsSdkDisabledAndRejectsUnsupportedExporters()
    {
        var spans = new List<Activity>();
        using var tel = O11y.Init(new O11yOptions
        {
            ServiceName = "disabled-svc",
            Environment = "production",
            Env = new Dictionary<string, string> { ["OTEL_SDK_DISABLED"] = "true" },
            SpanExporter = new InMemoryExporter<Activity>(spans),
            RuntimeMetrics = false,
        });
        using var src = new ActivitySource("disabled-svc");
        using (var act = src.StartActivity("op")) { _ = act; }
        tel.Shutdown();
        Assert.Empty(spans);

        Assert.Throws<UnsupportedProtocolException>(() =>
            O11y.Init(new O11yOptions
            {
                ServiceName = "checkout",
                Environment = "production",
                Env = new Dictionary<string, string> { ["OTEL_METRICS_EXPORTER"] = "prometheus" },
            }));
    }

    [Fact]
    public void SensitivityPolicy_ClassifiesResourceSpansLogsAndMetrics()
    {
        Assert.Throws<PiiHashKeyException>(() =>
            O11y.Init(new O11yOptions
            {
                ServiceName = "checkout",
                Environment = "test",
                Env = O11yEnv.Hermetic,
                PiiMode = PiiMode.Hash,
                PiiHashKey = Encoding.UTF8.GetBytes("short"),
            }));

        string appYaml = """
            schema: libo11y.app-registry/v1
            namespace: acme
            attributes:
              acme.user.email: {type: string, sensitivity: pii, cardinality: unbounded}
              acme.api.token:  {type: string, sensitivity: secret, cardinality: unbounded}
              acme.tier:       {type: string, sensitivity: public, cardinality: bounded}
            """;

        byte[] key = Encoding.UTF8.GetBytes("0123456789abcdef0123456789abcdef");

        using var rec = new O11yRecorder(o =>
        {
            o.PiiMode = PiiMode.Hash;
            o.PiiHashKey = key;
            o.AppRegistries = [appYaml];
            o.ActivitySources = ["acme.test"];
            o.Meters = ["acme.test"];
            o.ResourceAttributes["acme.api.token"] = "res-secret";
            o.ResourceAttributes["acme.user.email"] = "res@example.com";
            o.ResourceAttributes["acme.tier"] = "gold";
        });

        Assert.DoesNotContain("acme.api.token", rec.Telemetry.ResourceAttributes.Keys);
        Assert.StartsWith("hmac-sha256:", rec.Telemetry.ResourceAttributes["acme.user.email"]?.ToString());
        Assert.Equal("gold", rec.Telemetry.ResourceAttributes["acme.tier"]);

        using var src = new ActivitySource("acme.test");
        var meter = rec.Telemetry.CreateMeter("acme.test");
        var counter = meter.CreateCounter<long>("acme.orders");

        using (var span = src.StartActivity("order.create"))
        {
            span?.SetTag("acme.api.token", "tok");
            span?.SetTag("acme.user.email", "alice@example.com");
            span?.SetTag("acme.tier", "gold");

            rec.Telemetry.Log(LogLevel.Information, "order created", new Dictionary<string, object?>
            {
                ["acme.api.token"] = "tok",
                ["acme.user.email"] = "alice@example.com",
                ["acme.tier"] = "gold",
            });

            counter.Add(1,
                new KeyValuePair<string, object?>("acme.api.token", "tok"),
                new KeyValuePair<string, object?>("acme.user.email", "alice@example.com"),
                new KeyValuePair<string, object?>("acme.tier", "gold"));
        }

        var finishedSpan = Assert.Single(rec.Spans());
        var spanTags = finishedSpan.TagObjects.ToDictionary(kv => kv.Key, kv => kv.Value);
        Assert.DoesNotContain("acme.api.token", spanTags.Keys);
        Assert.StartsWith("hmac-sha256:", spanTags["acme.user.email"]?.ToString());
        Assert.Equal("gold", spanTags["acme.tier"]);

        var logRec = Assert.Single(rec.SinkRecords);
        Assert.DoesNotContain("acme.api.token", logRec.Attributes.Keys);
        Assert.StartsWith("hmac-sha256:", logRec.Attributes["acme.user.email"]?.ToString());
        Assert.Equal("gold", logRec.Attributes["acme.tier"]);

        // Metrics drop PII even in Hash mode
        var orderMetric = rec.Metrics().Single(m => m.Name == "acme.orders");
        foreach (ref readonly var mp in orderMetric.GetMetricPoints())
        {
            var tags = new Dictionary<string, object?>();
            foreach (var tag in mp.Tags) tags[tag.Key] = tag.Value;
            Assert.DoesNotContain("acme.api.token", tags.Keys);
            Assert.DoesNotContain("acme.user.email", tags.Keys);
            Assert.Equal("gold", tags["acme.tier"]);
        }

        rec.AssertConforms();
    }

    private sealed class PaymentPayload
    {
        public int Id { get; init; }
        [O11yRedact("mask")] public string Ssn { get; init; } = "";
        [O11yRedact("secret")] public string Token { get; init; } = "";
        [O11yRedact("omit")] public string Internal { get; init; } = "";
    }

    [Fact]
    public void CaptureTimeRedaction_AndAttrReplacer_AndCycles()
    {
        var secret = new Secret<string>("top-secret");
        var masked = new Masked<string>("1234-5678");
        Assert.Equal("REDACTED", secret.ToString());
        Assert.Equal("\"REDACTED\"", JsonSerializer.Serialize(secret));
        Assert.Equal("XXXXXXXXX", masked.ToString());

        var payload = new PaymentPayload { Id = 7, Ssn = "1234", Token = "tok", Internal = "hide" };
        var rendered = Assert.IsType<Dictionary<string, object?>>(O11yRedact.Render(payload));
        Assert.Equal(7, rendered["Id"]);
        Assert.Equal("XXXX", rendered["Ssn"]);
        Assert.Equal("REDACTED", rendered["Token"]);
        Assert.DoesNotContain("Internal", rendered.Keys);

        Assert.Throws<ArgumentException>(() => O11yRedact.ParseTag("bogus"));

        // AttrReplacer renaming to a secret key is still dropped by policy
        using var rec = new O11yRecorder(o =>
        {
            o.AttrReplacer = (_, k, v) => k == "alias" ? ("http.request.header.authorization", v) : (k, v);
        });
        var cyclic = new Dictionary<string, object?>();
        cyclic["self"] = cyclic;
        rec.Telemetry.Log(LogLevel.Information, "test", new Dictionary<string, object?>
        {
            ["alias"] = "Bearer secret",
            ["nested"] = cyclic,
            ["ok"] = "1",
        });

        var log = Assert.Single(rec.SinkRecords);
        Assert.DoesNotContain("http.request.header.authorization", log.Attributes.Keys);
        Assert.Equal("1", log.Attributes["ok"]);
        var nested = Assert.IsType<Dictionary<string, object?>>(log.Attributes["nested"]);
        Assert.Equal("truncated", nested["self"]);
    }

    [Fact]
    public void ForceEmit_WideRecords_Detached_Proc_AndIdempotentShutdown()
    {
        using var rec = new O11yRecorder(o =>
        {
            o.ConsoleLevel = LogLevel.Error;
            o.BaggageEgressAllow = k => k == "tenant";
            o.ActivitySources = ["flow.test"];
        });

        rec.Telemetry.Log(LogLevel.Information, "dropped_by_level");
        Assert.Empty(rec.ConsoleRecords());

        using (O11y.ForceEmit())
        {
            rec.Telemetry.Log(LogLevel.Information, "audit_line", new Dictionary<string, object?>
            {
                [SpecAttributes.RecordClass] = RecordClass.Audit,
            });
        }
        Assert.Single(rec.ConsoleRecords());

        using (O11y.StartRecord(out var wide))
        {
            wide.Set("order.id", "ord-1").Add("order.items", 3);
            Assert.Same(wide, O11y.CurrentRecord);
            wide.EmitEvent(rec.Telemetry, SpecEvents.RequestSummary, new Dictionary<string, object?>
            {
                [SpecAttributes.Outcome] = Outcome.Success,
                [SpecAttributes.Duration] = 0.012,
            });
        }
        Assert.Null(O11y.CurrentRecord);

        // Detached + Proc propagation
        using var src = new ActivitySource("flow.test");
        Detached.Carrier carrier;
        Dictionary<string, string> childEnv;
        ActivityTraceId originTraceId;

        Baggage.Current = Baggage.Create(new Dictionary<string, string>
        {
            ["tenant"] = "acme",
            ["secret_bag"] = "dropme",
        });

        using (var origin = src.StartActivity("origin"))
        {
            Assert.NotNull(origin);
            originTraceId = origin!.TraceId;
            carrier = Detached.Capture(rec.Telemetry);
            childEnv = Proc.ChildEnv(new Dictionary<string, string> { ["EXISTING"] = "1" });
        }

        string wire = carrier.MarshalText();
        var restored = Detached.Carrier.UnmarshalText(wire);
        Assert.Contains("tenant=acme", restored.Headers["baggage"]);
        Assert.DoesNotContain("secret_bag", restored.Headers["baggage"]);

        using (var job = Detached.StartLinked(restored, "job.run", src, rec.Telemetry))
        {
            Assert.NotNull(job);
            Assert.Equal("acme", Baggage.Current.GetBaggage("tenant"));
            Assert.Contains(job!.Links, l => l.Context.TraceId == originTraceId);
        }

        Assert.Contains("TRACEPARENT", childEnv.Keys);
        Assert.DoesNotContain("BAGGAGE", childEnv.Keys);
        var extractedCtx = Proc.ExtractEnv(childEnv);
        Assert.Equal(originTraceId, extractedCtx.TraceId);

        // Idempotent shutdown
        var r1 = rec.Shutdown();
        var r2 = rec.Shutdown();
        Assert.Same(r1, r2);
        Assert.True(r1.IsOk);
    }
}
