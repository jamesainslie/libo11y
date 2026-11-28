using System.Diagnostics;
using Libo11y.Internal;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;

namespace Libo11y.AspNetCore;

/// <summary>
/// Instrumented HttpClient DelegatingHandler that injects W3C headers, strips URL credentials,
/// and records http.client.request.duration with exemplars.
/// </summary>
public sealed class O11yHttpMessageHandler : DelegatingHandler
{
    private static readonly ActivitySource Source = new("libo11y.http", "0.1.0");

    private readonly Telemetry? _telemetry;
    private readonly Func<Uri, bool>? _propagateFilter;
    private readonly string? _peerService;
    private readonly O11yHistogram<double>? _durationHist;

    public O11yHttpMessageHandler(
        Telemetry? telemetry = null,
        Func<Uri, bool>? propagateFilter = null,
        string? peerService = null,
        HttpMessageHandler? innerHandler = null)
        : base(innerHandler ?? new HttpClientHandler())
    {
        _telemetry = telemetry;
        _propagateFilter = propagateFilter;
        _peerService = peerService;
        if (_telemetry is not null)
        {
            var meter = _telemetry.CreateMeter("libo11y.http", "0.1.0");
            _durationHist = meter.CreateHistogram<double>(
                "http.client.request.duration",
                unit: "s",
                description: "Duration of HTTP client requests.");
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string method = request.Method.Method.ToUpperInvariant();
        Uri? uri = request.RequestUri;
        string sanitizedUrl = uri is null ? "" : StripCredentials(uri);

        var sw = Stopwatch.StartNew();
        using var activity = Source.StartActivity(method, ActivityKind.Client);
        activity?.SetTag("http.request.method", method);
        if (uri is not null)
        {
            activity?.SetTag("url.full", sanitizedUrl);
            activity?.SetTag("server.address", uri.Host);
            activity?.SetTag("server.port", uri.Port);
        }
        if (!string.IsNullOrEmpty(_peerService))
        {
            activity?.SetTag("peer.service", _peerService);
        }

        if (uri is null || _propagateFilter is null || _propagateFilter(uri))
        {
            var prop = _telemetry?.Propagator ?? Propagators.DefaultTextMapPropagator;
            var ctx = new PropagationContext(activity?.Context ?? Activity.Current?.Context ?? default, Baggage.Current);
            prop.Inject(ctx, request.Headers, static (headers, k, v) => headers.TryAddWithoutValidation(k, v));
        }

        int? status = null;
        Exception? error = null;
        try
        {
            var resp = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            status = (int)resp.StatusCode;
            activity?.SetTag("http.response.status_code", status.Value);
            if (status.Value >= 400)
            {
                activity?.SetStatus(ActivityStatusCode.Error, $"HTTP {status.Value}");
                activity?.SetTag("error.type", status.Value.ToString());
            }
            return resp;
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
            if (_durationHist is not null)
            {
                var tags = new List<KeyValuePair<string, object?>>
                {
                    new("http.request.method", method),
                };
                if (uri is not null)
                {
                    tags.Add(new("server.address", uri.Host));
                    tags.Add(new("server.port", uri.Port));
                }
                if (status.HasValue) tags.Add(new("http.response.status_code", status.Value));
                if (error is not null || (status.HasValue && status.Value >= 400))
                {
                    tags.Add(new("error.type", error is not null ? (error.GetType().FullName ?? error.GetType().Name) : status!.Value.ToString()));
                }
                _durationHist.Record(sw.Elapsed.TotalSeconds, [.. tags]);
            }
        }
    }

    public static string StripCredentials(Uri uri)
    {
        var b = new UriBuilder(uri) { UserName = "", Password = "" };
        return b.Uri.AbsoluteUri;
    }
}
