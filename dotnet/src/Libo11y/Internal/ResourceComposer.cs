using System.Net;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Libo11y.Spec;
using OpenTelemetry.Resources;

namespace Libo11y.Internal;

internal sealed record ComposedResource(
    ResourceBuilder Builder,
    IReadOnlyDictionary<string, object?> Attributes,
    string ServiceName,
    string Environment,
    string ServiceVersion,
    string InstanceId,
    string SchemaUrl);

internal static class ResourceComposer
{
    public const string UnknownVersion = "0.0.0-unknown";
    private static readonly Regex CgroupIdRe = new(@"\b([0-9a-f]{64})\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string? DetectContainerId()
    {
        try
        {
            if (!File.Exists("/proc/self/cgroup")) return null;
            foreach (string line in File.ReadLines("/proc/self/cgroup"))
            {
                var m = CgroupIdRe.Match(line);
                if (m.Success) return m.Groups[1].Value.ToLowerInvariant();
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    public static ComposedResource Build(
        O11yOptions options,
        IReadOnlyDictionary<string, string> envMap,
        SensitivityPolicy policy,
        ViolationRecorder recorder)
    {
        var envRes = O11yEnvParser.ParsePairs(envMap.TryGetValue("OTEL_RESOURCE_ATTRIBUTES", out string? rawRes) ? rawRes : null);
        var optRes = options.ResourceAttributes;

        string? serviceName = options.ServiceName
            ?? (envMap.TryGetValue("OTEL_SERVICE_NAME", out string? esn) ? esn : null)
            ?? (envRes.TryGetValue("service.name", out string? ersn) ? ersn : null)
            ?? (optRes.TryGetValue("service.name", out object? orsn) ? orsn?.ToString() : null);
        serviceName = (serviceName ?? "").Trim();

        if (serviceName.Length == 0 || serviceName == "unknown_service" || serviceName.StartsWith("unknown_service:", StringComparison.Ordinal))
        {
            if (options.StrictIdentity)
            {
                throw new NoServiceNameException();
            }
            recorder.Record(Signal.Resource, "identity_service_name");
            if (serviceName.Length == 0) serviceName = "unknown_service";
        }

        string? environment = options.Environment
            ?? (envRes.TryGetValue("deployment.environment.name", out string? eenv) ? eenv : null)
            ?? (optRes.TryGetValue("deployment.environment.name", out object? oenv) ? oenv?.ToString() : null);
        environment = (environment ?? "").Trim();

        var allowedEnvs = new HashSet<string>(SpecTables.EnvironmentValues, StringComparer.Ordinal);
        foreach (string extra in options.ExtraEnvironments) allowedEnvs.Add(extra);

        if (environment.Length == 0)
        {
            if (options.StrictIdentity)
            {
                throw new NoEnvironmentException();
            }
            recorder.Record(Signal.Resource, "identity_environment");
        }
        else if (!allowedEnvs.Contains(environment))
        {
            if (options.StrictIdentity)
            {
                throw new InvalidEnvironmentException($"o11y: deployment environment '{environment}' not in the allowed set");
            }
            recorder.Record(Signal.Resource, "identity_environment_invalid");
        }

        string? version = options.Version
            ?? (optRes.TryGetValue("service.version", out object? ov) ? ov?.ToString() : null)
            ?? (envRes.TryGetValue("service.version", out string? ev) ? ev : null)
            ?? (options.BuildInfoEnabled ? options.BuildInfo?.Version : null);
        version = string.IsNullOrWhiteSpace(version) ? UnknownVersion : version.Trim();

        string podUid = (optRes.TryGetValue("k8s.pod.uid", out object? opu) ? opu?.ToString() : null)
                        ?? (envRes.TryGetValue("k8s.pod.uid", out string? epu) ? epu : "") ?? "";
        string podName = (optRes.TryGetValue("k8s.pod.name", out object? opn) ? opn?.ToString() : null)
                         ?? (envRes.TryGetValue("k8s.pod.name", out string? epn) ? epn : "") ?? "";
        string k8sNs = (optRes.TryGetValue("k8s.namespace.name", out object? okns) ? okns?.ToString() : null)
                       ?? (envRes.TryGetValue("k8s.namespace.name", out string? ekns) ? ekns : "") ?? "";

        string instanceId = options.ServiceInstanceId
            ?? (optRes.TryGetValue("service.instance.id", out object? oid) ? oid?.ToString() : null)
            ?? (envRes.TryGetValue("service.instance.id", out string? eid) ? eid : null)
            ?? InstanceId.Derive(podUid, podName, k8sNs)
            ?? InstanceId.Random();

        var attrs = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["telemetry.sdk.name"] = "opentelemetry",
            ["telemetry.sdk.language"] = "dotnet",
            ["telemetry.sdk.version"] = typeof(ResourceBuilder).Assembly.GetName().Version?.ToString() ?? "1.21.0",
            ["telemetry.distro.name"] = "libo11y",
            ["telemetry.distro.version"] = "0.1.0",
            ["process.runtime.name"] = ".NET",
            ["process.runtime.version"] = System.Environment.Version.ToString(),
            ["process.runtime.description"] = RuntimeInformation.FrameworkDescription,
        };

        try
        {
            string host = Dns.GetHostName();
            if (!string.IsNullOrEmpty(host)) attrs["host.name"] = host;
        }
        catch { /* ignore */ }

        string? containerId = DetectContainerId();
        if (!string.IsNullOrEmpty(containerId)) attrs["container.id"] = containerId;

        if (options.BuildInfoEnabled && options.BuildInfo is not null)
        {
            if (!string.IsNullOrEmpty(options.BuildInfo.VcsRevision))
            {
                attrs["vcs.ref.head.revision"] = options.BuildInfo.VcsRevision;
            }
            if (!string.IsNullOrEmpty(options.BuildInfo.BuildTime))
            {
                attrs[SpecAttributes.BuildTime] = options.BuildInfo.BuildTime;
            }
            if (options.BuildInfo.BuildModified.HasValue)
            {
                attrs[SpecAttributes.BuildModified] = options.BuildInfo.BuildModified.Value;
            }
        }

        foreach (var (k, v) in envRes) attrs[k] = v;
        foreach (var (k, v) in optRes) attrs[k] = v;

        attrs["service.name"] = serviceName;
        attrs["service.version"] = version;
        attrs["service.instance.id"] = instanceId;
        if (environment.Length > 0) attrs["deployment.environment.name"] = environment;
        if (!string.IsNullOrWhiteSpace(options.ServiceNamespace)) attrs["service.namespace"] = options.ServiceNamespace;

        var (classified, _) = policy.ClassifyFlat(Signal.Resource, attrs);

        var kvList = new List<KeyValuePair<string, object>>();
        foreach (var (k, v) in classified)
        {
            if (v is not null) kvList.Add(new KeyValuePair<string, object>(k, v));
        }

        // ResourceBuilder.CreateEmpty avoids implicit env resource merging so hermetic mode stays 100% isolated.
        var rb = ResourceBuilder.CreateEmpty().AddAttributes(kvList);
        return new ComposedResource(rb, classified, serviceName, environment, version, instanceId, SpecConstants.SchemaUrl);
    }
}
