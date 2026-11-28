using System.IO.Compression;
using System.Net;
using System.Net.Sockets;

namespace Libo11y.Testing;

public sealed record CapturedOtlpPayload(string Path, Dictionary<string, string> Headers, byte[] Body);

/// <summary>
/// In-process OTLP/HTTP receiver capturing raw protobuf/JSON requests (with transparent gzip decompression)
/// for wire-level verification in tests.
/// </summary>
public sealed class OtlpHttpReceiver : IDisposable
{
    private readonly HttpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _loopTask;
    private readonly object _lock = new();
    private readonly List<CapturedOtlpPayload> _traces = [];
    private readonly List<CapturedOtlpPayload> _metrics = [];
    private readonly List<CapturedOtlpPayload> _logs = [];

    public int Port { get; }
    public string Endpoint => $"http://127.0.0.1:{Port}";

    public IReadOnlyList<CapturedOtlpPayload> TraceRequests { get { lock (_lock) return [.. _traces]; } }
    public IReadOnlyList<CapturedOtlpPayload> MetricRequests { get { lock (_lock) return [.. _metrics]; } }
    public IReadOnlyList<CapturedOtlpPayload> LogRequests { get { lock (_lock) return [.. _logs]; } }

    public OtlpHttpReceiver()
    {
        Port = ReserveFreePort();
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        _listener.Start();
        _loopTask = Task.Run(() => ServeLoopAsync(_cts.Token));
    }

    private static int ReserveFreePort()
    {
        using var sock = new TcpListener(IPAddress.Loopback, 0);
        sock.Start();
        int port = ((IPEndPoint)sock.LocalEndpoint).Port;
        sock.Stop();
        return port;
    }

    private async Task ServeLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (HttpListenerException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }

            try
            {
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (string? k in ctx.Request.Headers.AllKeys)
                {
                    if (k is not null) headers[k] = ctx.Request.Headers[k] ?? "";
                }

                using var ms = new MemoryStream();
                await ctx.Request.InputStream.CopyToAsync(ms, ct).ConfigureAwait(false);
                byte[] body = ms.ToArray();

                if (headers.TryGetValue("Content-Encoding", out string? enc) &&
                    enc.Contains("gzip", StringComparison.OrdinalIgnoreCase))
                {
                    using var gz = new GZipStream(new MemoryStream(body), CompressionMode.Decompress);
                    using var decompressed = new MemoryStream();
                    await gz.CopyToAsync(decompressed, ct).ConfigureAwait(false);
                    body = decompressed.ToArray();
                }

                string path = ctx.Request.Url?.AbsolutePath ?? "";
                var payload = new CapturedOtlpPayload(path, headers, body);
                lock (_lock)
                {
                    if (path.EndsWith("/v1/traces", StringComparison.Ordinal)) _traces.Add(payload);
                    else if (path.EndsWith("/v1/metrics", StringComparison.Ordinal)) _metrics.Add(payload);
                    else if (path.EndsWith("/v1/logs", StringComparison.Ordinal)) _logs.Add(payload);
                }

                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "application/x-protobuf";
                ctx.Response.Close();
            }
            catch
            {
                try
                {
                    ctx.Response.StatusCode = 500;
                    ctx.Response.Close();
                }
                catch { /* ignore */ }
            }
        }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { /* ignore */ }
        try { _listener.Close(); } catch { /* ignore */ }
        try { _loopTask.Wait(TimeSpan.FromSeconds(2)); } catch { /* ignore */ }
        _cts.Dispose();
    }
}
