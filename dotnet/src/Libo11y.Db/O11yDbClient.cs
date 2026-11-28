using System.Diagnostics;
using Libo11y.Internal;

namespace Libo11y.Db;

/// <summary>
/// Database client instrumentation with parent-gated client spans, SQL literal sanitization,
/// and db.client.operation.duration histogram with exemplars.
/// </summary>
public sealed class O11yDbClient
{
    private static readonly ActivitySource Source = new("libo11y.db", O11y.Version);

    private readonly string _dbSystem;
    private readonly string? _dbNamespace;
    private readonly string? _serverAddress;
    private readonly int? _serverPort;
    private readonly O11yHistogram<double>? _durationHist;

    public O11yDbClient(
        string dbSystem,
        string? dbNamespace = null,
        string? serverAddress = null,
        int? serverPort = null,
        Telemetry? telemetry = null)
    {
        _dbSystem = dbSystem;
        _dbNamespace = dbNamespace;
        _serverAddress = serverAddress;
        _serverPort = serverPort;
        if (telemetry is not null)
        {
            var meter = telemetry.CreateMeter("libo11y.db", O11y.Version);
            _durationHist = meter.CreateHistogram<double>(
                "db.client.operation.duration",
                unit: "s",
                description: "Duration of database client operations.");
        }
    }

    public T Execute<T>(string sql, Func<T> action, string? operation = null)
    {
        string op = operation ?? SqlSanitizer.ExtractOperation(sql);
        string? sanitized = SqlSanitizer.Sanitize(sql, _dbSystem);

        var metricTags = new List<KeyValuePair<string, object?>>
        {
            new("db.system.name", _dbSystem),
            new("db.operation.name", op),
        };
        if (!string.IsNullOrEmpty(_dbNamespace)) metricTags.Add(new("db.namespace", _dbNamespace));
        if (!string.IsNullOrEmpty(_serverAddress)) metricTags.Add(new("server.address", _serverAddress));
        if (_serverPort.HasValue) metricTags.Add(new("server.port", _serverPort.Value));

        var sw = Stopwatch.StartNew();
        bool hasParent = Activity.Current is not null && Activity.Current.TraceId != default;

        if (!hasParent)
        {
            try
            {
                return action();
            }
            catch (Exception ex)
            {
                metricTags.Add(new("error.type", ex.GetType().FullName ?? ex.GetType().Name));
                throw;
            }
            finally
            {
                sw.Stop();
                _durationHist?.Record(sw.Elapsed.TotalSeconds, [.. metricTags]);
            }
        }

        string spanName = string.IsNullOrEmpty(_dbNamespace) ? op : $"{op} {_dbNamespace}";
        using var activity = Source.StartActivity(spanName, ActivityKind.Client);
        if (activity is not null)
        {
            foreach (var (k, v) in metricTags) activity.SetTag(k, v);
            if (!string.IsNullOrEmpty(sanitized)) activity.SetTag("db.query.text", sanitized);
        }

        try
        {
            return action();
        }
        catch (Exception ex)
        {
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.SetTag("error.type", ex.GetType().FullName ?? ex.GetType().Name);
            metricTags.Add(new("error.type", ex.GetType().FullName ?? ex.GetType().Name));
            throw;
        }
        finally
        {
            sw.Stop();
            _durationHist?.Record(sw.Elapsed.TotalSeconds, [.. metricTags]);
        }
    }
}
