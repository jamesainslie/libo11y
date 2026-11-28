using System.Diagnostics;
using System.Text.RegularExpressions;
using Libo11y.Internal;
using Libo11y.Spec;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;

namespace Libo11y.AspNetCore;

public sealed class O11yHttpMiddlewareOptions
{
    public Telemetry? Telemetry { get; set; }
    public Func<HttpContext, string?>? RouteResolver { get; set; }
    public bool PublicEndpoint { get; set; }
    public IReadOnlyList<string> IgnorePaths { get; set; } = [];
    public Func<HttpContext, bool>? Filter { get; set; }
    public bool ServerTiming { get; set; }
    public bool CanonicalLine { get; set; }
}

public sealed class O11yHttpMiddleware
{
    public static readonly double[] HttpDurationBuckets =
        [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0];

    private sealed class RouteBox { public string? Route; }

    private static readonly ActivitySource Source = new("libo11y.aspnetcore", O11y.Version);
    private static readonly AsyncLocal<RouteBox?> RouteOverride = new();

    private readonly RequestDelegate _next;
    private readonly O11yHttpMiddlewareOptions _options;
    private readonly O11yHistogram<double>? _durationHist;

    public O11yHttpMiddleware(RequestDelegate next, O11yHttpMiddlewareOptions? options = null)
    {
        _next = next;
        _options = options ?? new O11yHttpMiddlewareOptions();
        if (_options.Telemetry is not null)
        {
            var meter = _options.Telemetry.CreateMeter("libo11y.aspnetcore", O11y.Version);
            _durationHist = meter.CreateHistogram<double>(
                "http.server.request.duration",
                unit: "s",
                description: "Duration of HTTP server requests.");
        }
    }

    public static void SetRoute(string route)
    {
        if (RouteOverride.Value is { } box) box.Route = route;
    }

    public static bool MatchGlob(string pattern, string path)
    {
        var regex = "^" + Regex.Escape(pattern)
            .Replace(@"\*", "[^/]*")
            .Replace(@"\?", "[^/]") + "$";
        return Regex.IsMatch(path, regex, RegexOptions.CultureInvariant);
    }

    public async Task InvokeAsync(HttpContext context)
    {
        string rawPath = context.Request.Path.Value ?? "/";
        string decodedPath;
        try { decodedPath = Uri.UnescapeDataString(rawPath); } catch { decodedPath = rawPath; }

        if (IsIgnored(decodedPath, context))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        string method = context.Request.Method.ToUpperInvariant();
        string scheme = string.IsNullOrEmpty(context.Request.Scheme) ? "http" : context.Request.Scheme;

        var prop = _options.Telemetry?.Propagator ?? Propagators.DefaultTextMapPropagator;
        var extracted = prop.Extract(default, context.Request.Headers, static (headers, key) =>
            headers.TryGetValue(key, out var vals) ? vals.Where(static v => v is not null).Cast<string>() : []);

        ActivityContext parentCtx = extracted.ActivityContext;
        ActivityLink[]? links = null;
        if (_options.PublicEndpoint)
        {
            if (extracted.ActivityContext.TraceId != default)
            {
                links = [new ActivityLink(extracted.ActivityContext)];
            }
            parentCtx = default;
        }

        var prevBaggage = Baggage.Current;
        Baggage.Current = extracted.Baggage;

        string? initialRoute = ResolveRoute(context);
        string spanName = string.IsNullOrEmpty(initialRoute) ? method : $"{method} {initialRoute}";

        var prevRoute = RouteOverride.Value;
        var routeBox = new RouteBox();
        RouteOverride.Value = routeBox;

        var sw = Stopwatch.StartNew();
        Exception? error = null;
        int statusCode = 500;

        using var activity = Source.StartActivity(spanName, ActivityKind.Server, parentCtx, links: links);
        activity?.SetTag("http.request.method", method);
        activity?.SetTag("url.path", rawPath);
        activity?.SetTag("url.scheme", scheme);
        if (!string.IsNullOrEmpty(initialRoute)) activity?.SetTag("http.route", initialRoute);
        if (context.Request.Host.HasValue)
        {
            activity?.SetTag("server.address", context.Request.Host.Host);
            if (context.Request.Host.Port.HasValue)
            {
                activity?.SetTag("server.port", context.Request.Host.Port.Value);
            }
        }

        if (_options.ServerTiming && activity is not null)
        {
            context.Response.OnStarting(() =>
            {
                string flags = activity.Recorded ? "01" : "00";
                string tp = $"00-{activity.TraceId.ToHexString()}-{activity.SpanId.ToHexString()}-{flags}";
                string entry = $"traceparent;desc=\"{tp}\"";
                context.Response.Headers.Append("Server-Timing", entry);
                return Task.CompletedTask;
            });
        }

        using var recScope = O11y.StartRecord(out var rec);
        try
        {
            await _next(context).ConfigureAwait(false);
            statusCode = context.Response.StatusCode;
        }
        catch (Exception ex)
        {
            error = ex;
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.SetTag("error.type", ex.GetType().FullName ?? ex.GetType().Name);
            throw;
        }
        finally
        {
            sw.Stop();
            string? finalRoute = routeBox.Route ?? initialRoute ?? ResolveRoute(context);
            if (activity is not null)
            {
                if (!string.IsNullOrEmpty(finalRoute))
                {
                    activity.SetTag("http.route", finalRoute);
                    activity.DisplayName = $"{method} {finalRoute}";
                }
                activity.SetTag("http.response.status_code", statusCode);
                if (statusCode >= 500 && error is null)
                {
                    activity.SetStatus(ActivityStatusCode.Error, $"HTTP {statusCode}");
                    activity.SetTag("error.type", statusCode.ToString());
                }
            }

            double durationSec = sw.Elapsed.TotalSeconds;
            if (_durationHist is not null)
            {
                var tags = new List<KeyValuePair<string, object?>>
                {
                    new("http.request.method", method),
                    new("http.response.status_code", statusCode),
                    new("url.scheme", scheme),
                };
                if (!string.IsNullOrEmpty(finalRoute)) tags.Add(new("http.route", finalRoute));
                if (error is not null || statusCode >= 500)
                {
                    tags.Add(new("error.type", error is not null ? (error.GetType().FullName ?? error.GetType().Name) : statusCode.ToString()));
                }
                _durationHist.Record(durationSec, [.. tags]);
            }

            if (_options.CanonicalLine && _options.Telemetry is not null)
            {
                var summary = rec.Snapshot();
                summary["http.request.method"] = method;
                summary["http.response.status_code"] = statusCode;
                summary["url.path"] = rawPath;
                summary[SpecAttributes.Duration] = durationSec;
                summary[SpecAttributes.Outcome] = (error is not null || statusCode >= 500) ? Outcome.Failure : Outcome.Success;
                if (!string.IsNullOrEmpty(finalRoute)) summary["http.route"] = finalRoute;
                if (error is not null) summary["error.type"] = error.GetType().FullName ?? error.GetType().Name;
                _options.Telemetry.Event(SpecEvents.RequestSummary, summary);
            }

            RouteOverride.Value = prevRoute;
            Baggage.Current = prevBaggage;
        }
    }

    private bool IsIgnored(string decodedPath, HttpContext context)
    {
        foreach (string pat in _options.IgnorePaths)
        {
            if (MatchGlob(pat, decodedPath)) return true;
        }
        if (_options.Filter is not null && !_options.Filter(context)) return true;
        return false;
    }

    private string? ResolveRoute(HttpContext context)
    {
        if (_options.RouteResolver is not null)
        {
            string? r = _options.RouteResolver(context);
            if (!string.IsNullOrEmpty(r)) return r;
        }
        if (context.GetEndpoint() is RouteEndpoint ep)
        {
            return ep.RoutePattern.RawText;
        }
        return null;
    }
}

public static class O11yApplicationBuilderExtensions
{
    public static IApplicationBuilder UseO11y(this IApplicationBuilder app, O11yHttpMiddlewareOptions? options = null) =>
        app.UseMiddleware<O11yHttpMiddleware>(options ?? new O11yHttpMiddlewareOptions());
}
