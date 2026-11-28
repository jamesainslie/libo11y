#!/usr/bin/env bash
# dotnet-release-check.sh: validate the libo11y .NET packages at VERSION.
#
# Without --from-nuget it checks dotnet/Directory.Build.props and
# dotnet/CHANGELOG.md, packs every Libo11y.* package from the checkout, and
# restores a throwaway consumer from those packages. The consumer checks
# O11y.Version, loads every library assembly, and exports a span, a metric
# and a log record to an in-process OTLP/HTTP receiver. The script then
# installs the Libo11y.Cli tool package and runs `libo11y registry check`.
# Third-party dependencies restore from nuget.org.
#
# With --from-nuget it packs nothing: the consumer and the tool restore
# every package from nuget.org, for the release workflow's smoke job.
#
# Usage: dotnet-release-check.sh [VERSION] [--out DIR | --from-nuget]
#   VERSION defaults to v0.1.0 (the leading v is optional).
#   --out DIR     keep the checked packages (.nupkg and .snupkg) and their
#                 SHA256SUMS in DIR, so a release publishes what was checked.
#   --from-nuget  check the published packages instead of the checkout.
#
# DOTNET_MAXCPU caps the MSBuild node count (default 4).
set -euo pipefail

version="v0.1.0"
out=""
from_nuget=false
while [[ $# -gt 0 ]]; do
	case "$1" in
	--out)
		if [[ $# -lt 2 || -z "$2" ]]; then
			echo "dotnet-release-check: --out needs a directory" >&2
			exit 2
		fi
		out="$2"
		shift 2
		;;
	--from-nuget)
		from_nuget=true
		shift
		;;
	-*)
		echo "usage: dotnet-release-check.sh [VERSION] [--out DIR | --from-nuget]" >&2
		exit 2
		;;
	*)
		version="$1"
		shift
		;;
	esac
done
if [[ "$from_nuget" == true && -n "$out" ]]; then
	echo "dotnet-release-check: --out and --from-nuget exclude each other" >&2
	exit 2
fi
plain="${version#v}"
if [[ -z "$plain" ]]; then
	echo "dotnet-release-check: version must not be empty" >&2
	exit 2
fi

fail() {
	echo "dotnet-release-check: $*" >&2
	exit 1
}

# Every package of one release, libraries first, then the tool.
libraries=(Libo11y.Spec Libo11y Libo11y.AspNetCore Libo11y.Db Libo11y.Testing)
tool=Libo11y.Cli

export DOTNET_NOLOGO=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1
maxcpu="${DOTNET_MAXCPU:-4}"

# An installed tool starts through an apphost, which finds the runtime in
# DOTNET_ROOT or a system-wide install. A dotnet from a version manager or
# the Nix store is neither, so point DOTNET_ROOT at the runtime dotnet uses.
if [[ -z "${DOTNET_ROOT:-}" ]]; then
	runtime_root="$(dotnet --list-runtimes | sed -nE 's|^Microsoft\.NETCore\.App [^ ]+ \[(.*)/shared/Microsoft\.NETCore\.App\]$|\1|p' | tail -n 1)"
	if [[ -n "$runtime_root" ]]; then
		export DOTNET_ROOT="$runtime_root"
	fi
fi

tmp="$(mktemp -d)"
cleanup() {
	rm -rf -- "$tmp"
}
trap cleanup EXIT

# An isolated package cache: a package packed here must never be served
# later from the user's global cache under the same version.
export NUGET_PACKAGES="$tmp/packages"
feed="$tmp/feed"
mkdir -p "$feed"

if [[ "$from_nuget" == false ]]; then
	repo_root="$(git rev-parse --show-toplevel)"
	props="$repo_root/dotnet/Directory.Build.props"
	got="$(sed -nE 's|.*<Version>([^<]+)</Version>.*|\1|p' "$props" | head -n 1)"
	[[ "$got" == "$plain" ]] || fail "dotnet/Directory.Build.props is at version ${got:-unset}, want $plain"

	"$repo_root/scripts/release-notes.sh" "$plain" "$repo_root/dotnet/CHANGELOG.md" >/dev/null
	echo "dotnet-release-check: dotnet/Directory.Build.props and dotnet/CHANGELOG.md match $plain"

	dotnet pack "$repo_root/dotnet/Libo11y.sln" --configuration Release \
		--output "$feed" "-maxcpucount:$maxcpu" --disable-build-servers --verbosity quiet

	for id in "${libraries[@]}" "$tool"; do
		[[ -f "$feed/$id.$plain.nupkg" ]] || fail "pack did not produce $id.$plain.nupkg"
		[[ -f "$feed/$id.$plain.snupkg" ]] || fail "pack did not produce the symbol package $id.$plain.snupkg"
	done
	count="$(find "$feed" -maxdepth 1 -name '*.nupkg' | wc -l)"
	want=$((${#libraries[@]} + 1))
	[[ "$count" -eq "$want" ]] || fail "pack produced $count packages, want $want"
	echo "dotnet-release-check: packed $want packages at $plain"
fi

# The consumer restores Libo11y.* from the packed feed only, or from
# nuget.org only with --from-nuget, so neither mode can pass on the other's
# packages.
if [[ "$from_nuget" == true ]]; then
	libo11y_source=nuget.org
else
	libo11y_source=local
fi
consumer="$tmp/consumer"
mkdir -p "$consumer"
cat >"$consumer/nuget.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="$feed" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
    <packageSource key="$libo11y_source">
      <package pattern="Libo11y" />
      <package pattern="Libo11y.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
EOF

{
	cat <<'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
EOF
	for id in "${libraries[@]}"; do
		printf '    <PackageReference Include="%s" Version="[%s]" />\n' "$id" "$plain"
	done
	cat <<'EOF'
  </ItemGroup>
</Project>
EOF
} >"$consumer/Consumer.csproj"

cat >"$consumer/Program.cs" <<'EOF'
using System.Diagnostics;
using System.Text;
using Libo11y;
using Libo11y.Testing;
using Microsoft.Extensions.Logging;

string want = args[0];
if (O11y.Version != want)
{
    Console.Error.WriteLine($"version mismatch: O11y.Version is {O11y.Version}, want {want}");
    return 1;
}

// One type from each library package, so every assembly loads.
Type[] loaded =
[
    typeof(Libo11y.Spec.SpecConstants),
    typeof(Libo11y.AspNetCore.O11yHttpMiddleware),
    typeof(Libo11y.Db.SqlSanitizer),
];

using var receiver = new OtlpHttpReceiver();
var telemetry = O11y.Init(new O11yOptions
{
    ServiceName = "dotnet-release-smoke",
    Environment = "test",
    Env = new Dictionary<string, string>
    {
        ["OTEL_EXPORTER_OTLP_ENDPOINT"] = receiver.Endpoint,
        ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf",
    },
    ActivitySources = ["smoke"],
    Meters = ["smoke"],
    ConsoleEnabled = false,
    RuntimeMetrics = false,
});

using var source = new ActivitySource("smoke");
var counter = telemetry.CreateMeter("smoke").CreateCounter<long>("smoke.requests");
using (source.StartActivity("smoke-op"))
{
    telemetry.Logger.LogInformation("smoke-log");
    counter.Add(1);
}

var report = telemetry.Shutdown(TimeSpan.FromSeconds(5));
if (!report.IsOk)
{
    Console.Error.WriteLine($"shutdown failed: {report}");
    return 1;
}

static bool Carries(IReadOnlyList<CapturedOtlpPayload> requests, string needle) =>
    Encoding.Latin1.GetString(requests.SelectMany(r => r.Body).ToArray()).Contains(needle, StringComparison.Ordinal);

if (!Carries(receiver.TraceRequests, "smoke-op"))
{
    Console.Error.WriteLine("the receiver got no smoke-op span");
    return 1;
}
if (!Carries(receiver.MetricRequests, "smoke.requests"))
{
    Console.Error.WriteLine("the receiver got no smoke.requests metric");
    return 1;
}
if (!Carries(receiver.LogRequests, "smoke-log"))
{
    Console.Error.WriteLine("the receiver got no smoke-log record");
    return 1;
}

Console.WriteLine($"consumer ok: libo11y {O11y.Version}, {loaded.Length + 2} assemblies, span, metric and log exported");
return 0;
EOF

dotnet build "$consumer/Consumer.csproj" --configuration Release \
	"-maxcpucount:$maxcpu" --disable-build-servers --verbosity quiet
dotnet run --project "$consumer/Consumer.csproj" --configuration Release --no-build -- "$plain"

# Each restored library package carries its README, its assembly and its
# license expression.
for id in "${libraries[@]}"; do
	lower="${id,,}"
	extracted="$NUGET_PACKAGES/$lower/$plain"
	[[ -f "$extracted/README.md" ]] || fail "$id $plain has no README.md"
	[[ -f "$extracted/lib/net10.0/$id.dll" ]] || fail "$id $plain has no lib/net10.0/$id.dll"
	grep -qF '<license type="expression">Apache-2.0</license>' "$extracted/$lower.nuspec" ||
		fail "$id $plain does not declare the Apache-2.0 license expression"
done
echo "dotnet-release-check: the library packages carry README.md, the assembly and the license"

# The tool package installs and checks a registry.
tools="$tmp/tools"
dotnet tool install "$tool" --tool-path "$tools" --version "[$plain]" \
	--configfile "$consumer/nuget.config" >/dev/null
cat >"$tmp/registry.yaml" <<'EOF'
schema: libo11y.app-registry/v1
namespace: smoke
attributes:
  smoke.order.id: {type: string, sensitivity: internal, cardinality: unbounded}
EOF
got_line="$("$tools/libo11y" registry check "$tmp/registry.yaml")"
want_line="$tmp/registry.yaml: ok (1 attribute in namespace smoke)"
[[ "$got_line" == "$want_line" ]] || fail "libo11y registry check printed \"$got_line\", want \"$want_line\""
echo "dotnet-release-check: the $tool tool runs libo11y registry check"

if [[ -n "$out" ]]; then
	mkdir -p "$out"
	(
		cd "$feed"
		sha256sum -- *.nupkg *.snupkg >SHA256SUMS
	)
	cp -- "$feed"/*.nupkg "$feed"/*.snupkg "$feed/SHA256SUMS" "$out/"
	echo "dotnet-release-check: wrote the packages and SHA256SUMS to $out"
fi

if [[ "$from_nuget" == true ]]; then
	echo "dotnet-release-check: OK, the Libo11y.* $plain packages on nuget.org install and export all three signals"
else
	echo "dotnet-release-check: OK, the Libo11y.* $plain packages install and export all three signals"
fi
