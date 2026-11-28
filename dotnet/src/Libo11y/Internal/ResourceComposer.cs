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
    bool ServiceVersionFallback,
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
        string? Explicit(string key) => optRes.GetValueOrDefault(key)?.ToString();

        string serviceName = FirstNonBlank(options.ServiceName, Explicit("service.name"),
            envMap.GetValueOrDefault("OTEL_SERVICE_NAME"), envRes.GetValueOrDefault("service.name")) ?? "";

        if (serviceName.Length == 0 || serviceName == "unknown_service" || serviceName.StartsWith("unknown_service:", StringComparison.Ordinal))
        {
            if (options.StrictIdentity)
            {
                throw new NoServiceNameException();
            }
            recorder.Record(Signal.Resource, "identity_service_name");
            if (serviceName.Length == 0) serviceName = "unknown_service";
        }

        string environment = FirstNonBlank(options.Environment, Explicit("deployment.environment.name"),
            envRes.GetValueOrDefault("deployment.environment.name")) ?? "";

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

        string? resolvedVersion = FirstNonBlank(options.Version, Explicit("service.version"),
            envRes.GetValueOrDefault("service.version"), options.BuildInfoEnabled ? options.BuildInfo?.Version : null);
        string version = resolvedVersion ?? UnknownVersion;
        string? serviceNamespace = FirstNonBlank(options.ServiceNamespace, Explicit("service.namespace"),
            envRes.GetValueOrDefault("service.namespace"));

        string podUid = FirstNonBlank(Explicit("k8s.pod.uid"), envRes.GetValueOrDefault("k8s.pod.uid")) ?? "";
        string podName = FirstNonBlank(Explicit("k8s.pod.name"), envRes.GetValueOrDefault("k8s.pod.name")) ?? "";
        string k8sNs = FirstNonBlank(Explicit("k8s.namespace.name"), envRes.GetValueOrDefault("k8s.namespace.name")) ?? "";

        string instanceId = FirstNonBlank(options.ServiceInstanceId, Explicit("service.instance.id"),
            envRes.GetValueOrDefault("service.instance.id"))
            ?? InstanceId.Derive(podUid, podName, k8sNs)
            ?? InstanceId.Random();

        var attrs = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["telemetry.distro.name"] = "libo11y",
            ["telemetry.distro.version"] = O11y.Version,
            ["process.runtime.name"] = ".NET",
            ["process.runtime.version"] = System.Environment.Version.ToString(),
            ["process.runtime.description"] = RuntimeInformation.FrameworkDescription,
        };
        var sdkResource = ResourceBuilder.CreateEmpty().AddTelemetrySdk().Build();
        foreach (var (key, value) in sdkResource.Attributes) attrs[key] = value;

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
        else attrs.Remove("deployment.environment.name");
        if (serviceNamespace is not null) attrs["service.namespace"] = serviceNamespace;
        else attrs.Remove("service.namespace");

        var (classified, _) = policy.ClassifyFlat(Signal.Resource, attrs);

        var kvList = new List<KeyValuePair<string, object>>();
        foreach (var (k, v) in classified)
        {
            if (v is not null) kvList.Add(new KeyValuePair<string, object>(k, v));
        }

        // ResourceBuilder.CreateEmpty avoids implicit env resource merging so hermetic mode stays 100% isolated.
        var rb = ResourceBuilder.CreateEmpty().AddAttributes(kvList, SpecConstants.SchemaUrl);
        return new ComposedResource(rb, classified, serviceName, environment, version, resolvedVersion is null,
            instanceId, SpecConstants.SchemaUrl);
    }

    private static string? FirstNonBlank(params string?[] values)
    {
        foreach (string? value in values)
        {
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }
        return null;
    }
}
