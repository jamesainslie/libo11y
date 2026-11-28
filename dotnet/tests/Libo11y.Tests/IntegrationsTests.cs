using System.Diagnostics;
using System.Net;
using Libo11y.AspNetCore;
using Libo11y.Db;
using Libo11y.Testing;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Libo11y.Tests;

public sealed class IntegrationsTests
{
    [Fact]
    public async Task AspNetCoreMiddleware_RecordsSemconvSpanMetricsServerTimingAndCanonicalLine()
    {
        using var rec = new O11yRecorder(o =>
        {
            o.ActivitySources = ["libo11y.aspnetcore"];
            o.Meters = ["libo11y.aspnetcore"];
        });

        var mw = new O11yHttpMiddleware(
            async ctx =>
            {
                O11yHttpMiddleware.SetRoute("/orders/{id}");
                O11y.CurrentRecord?.Set("order.id", "ord-99");
                rec.Telemetry.Log(LogLevel.Information, "handling order");
                ctx.Response.StatusCode = 200;
                await ctx.Response.WriteAsync("ok");
            },
            new O11yHttpMiddlewareOptions
            {
                Telemetry = rec.Telemetry,
                IgnorePaths = ["/healthz"],
                ServerTiming = true,
                CanonicalLine = true,
            });

        // Ignored path emits no span
        var ignoredCtx = new DefaultHttpContext();
        ignoredCtx.Request.Method = "GET";
        ignoredCtx.Request.Path = "/healthz";
        await mw.InvokeAsync(ignoredCtx);
        Assert.Empty(rec.Spans());

        // Active path emits correlated span, log, canonical line, metric + exemplar
        var httpCtx = new DefaultHttpContext();
        httpCtx.Request.Method = "GET";
        httpCtx.Request.Path = "/orders/99";
        httpCtx.Request.Scheme = "http";
        httpCtx.Request.Host = new HostString("localhost", 8080);
        await mw.InvokeAsync(httpCtx);

        var span = Assert.Single(rec.Spans());
        Assert.Equal("GET /orders/{id}", span.DisplayName);
        Assert.Equal("/orders/{id}", span.GetTagItem("http.route"));
        Assert.Equal(200, span.GetTagItem("http.response.status_code"));

        rec.AssertConforms();
        rec.AssertTriangle();
    }

    private sealed class StubHttpHandler(Action<HttpRequestMessage> onRequest) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            onRequest(request);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    [Fact]
    public async Task HttpMessageHandler_InjectsTraceparentAndStripsCredentials()
    {
        using var rec = new O11yRecorder(o =>
        {
            o.ActivitySources = ["libo11y.http"];
            o.Meters = ["libo11y.http"];
        });

        string? capturedTp = null;
        var handler = new O11yHttpMessageHandler(
            telemetry: rec.Telemetry,
            peerService: "inventory",
            innerHandler: new StubHttpHandler(req =>
            {
                if (req.Headers.TryGetValues("traceparent", out var vals))
                {
                    capturedTp = vals.FirstOrDefault();
                }
            }));

        using var client = new HttpClient(handler);
        var resp = await client.GetAsync("http://user:pass@127.0.0.1:8080/ping");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.NotNull(capturedTp);
        Assert.StartsWith("00-", capturedTp);

        var span = Assert.Single(rec.Spans());
        string fullUrl = span.GetTagItem("url.full")?.ToString() ?? "";
        Assert.DoesNotContain("user:pass", fullUrl);
        Assert.Equal("inventory", span.GetTagItem("peer.service"));
    }

    [Fact]
    public void DbClient_GatesSpanOnParentAndSanitizesSql()
    {
        using var rec = new O11yRecorder(o =>
        {
            o.ActivitySources = ["db.parent", "libo11y.db"];
            o.Meters = ["libo11y.db"];
        });

        var db = new O11yDbClient("postgresql", dbNamespace: "orders", telemetry: rec.Telemetry);

        // No parent -> no span, metric recorded
        db.Execute("SELECT * FROM users WHERE email = 'alice@example.com' AND id = 42", () => 1);
        Assert.Empty(rec.Spans());

        // Under parent -> span emitted with sanitized SQL
        using var parentSrc = new ActivitySource("db.parent");
        using (parentSrc.StartActivity("http.get"))
        {
            db.Execute("SELECT * FROM users WHERE email = 'alice@example.com' AND id = 42 -- comment", () => 1);
        }

        var dbSpan = rec.Spans().Single(s => s.DisplayName == "SELECT orders");
        Assert.Equal("SELECT * FROM users WHERE email = ? AND id = ?", dbSpan.GetTagItem("db.query.text"));
        Assert.Contains(rec.Metrics(), m => m.Name == "db.client.operation.duration");
    }
}
