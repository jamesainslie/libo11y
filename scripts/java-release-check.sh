#!/usr/bin/env bash
# java-release-check.sh: validate the libo11y Java reactor at VERSION the way
# a consumer receives it. It checks every POM and java/CHANGELOG.md, builds
# the release artifacts (jars with sources and javadoc) into a Maven
# repository layout in a temporary directory, checks that layout, and then
# builds and runs a throwaway consumer project against it: all three signals
# through an in-process OTLP/HTTP receiver, and the `libo11y registry check`
# command.
#
# Usage: java-release-check.sh [VERSION] [--dist DIR [--central-bundle FILE]]
#   VERSION defaults to v0.1.0 (the leading v is optional).
#   --dist DIR writes the release assets into DIR after the checks pass:
#     the six jars, libo11y-java-vVERSION-maven-repository.tar.gz (the
#     repository layout, which Maven or Gradle reads as a file:// repository)
#     and SHA256SUMS. The release workflow uploads exactly these files.
#   --central-bundle FILE also writes the bundle the Central Publisher Portal
#     accepts. Maven Central only takes signed files, so this needs the
#     signing key below.
#
# Environment:
#   MAVEN_GPG_PRIVATE_KEY  an ASCII-armored OpenPGP private key. When set, every
#                         artifact in the repository layout gets a detached
#                         .asc signature, and each signature is verified.
#   MAVEN_GPG_PASSPHRASE   that key's passphrase (may be empty).
#   JAVA_RELEASE_MVN      the Maven command (default: mvn).
#
# Needs a JDK 21 or later, Maven 3.9 or later and network access to Maven
# Central for the dependencies. It never installs into the local Maven
# repository, and the consumer resolves the libo11y artifacts only from the
# layout it just built.
set -euo pipefail

fail() {
	echo "java-release-check: $*" >&2
	exit 1
}

usage() {
	echo "usage: java-release-check.sh [VERSION] [--dist DIR [--central-bundle FILE]]" >&2
	exit 2
}

version="v0.1.0"
dist=""
central_bundle=""
positional=0
while [[ $# -gt 0 ]]; do
	case "$1" in
	--dist)
		[[ $# -ge 2 && -n "$2" ]] || usage
		dist="$2"
		shift 2
		;;
	--central-bundle)
		[[ $# -ge 2 && -n "$2" ]] || usage
		central_bundle="$2"
		shift 2
		;;
	-*)
		usage
		;;
	*)
		[[ "$positional" -eq 0 && -n "$1" ]] || usage
		version="$1"
		positional=1
		shift
		;;
	esac
done
plain="${version#v}"
[[ -n "$plain" ]] || fail "version must not be empty"
if [[ -n "$central_bundle" && -z "$dist" ]]; then
	usage
fi
if [[ -n "$central_bundle" && -z "${MAVEN_GPG_PRIVATE_KEY:-}" ]]; then
	fail "--central-bundle needs MAVEN_GPG_PRIVATE_KEY, because Maven Central only accepts signed files"
fi

mvn_cmd="${JAVA_RELEASE_MVN:-mvn}"
for tool in "$mvn_cmd" java jar; do
	command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done

repo_root="$(git rev-parse --show-toplevel)"
java_dir="$repo_root/java"

# first_version FILE: the first <version> element, which is the project's own
# version in the parent and BOM POMs and the parent reference in a module POM.
first_version() {
	sed -nE 's/^[[:space:]]*<version>([^<]+)<\/version>.*/\1/p' "$1" | head -n 1
}

modules=()
while IFS= read -r module; do
	modules+=("$module")
done < <(sed -nE 's/^[[:space:]]*<module>([^<]+)<\/module>.*/\1/p' "$java_dir/pom.xml")
[[ "${#modules[@]}" -gt 0 ]] || fail "java/pom.xml lists no modules"

got="$(first_version "$java_dir/pom.xml")"
[[ "$got" == "$plain" ]] || fail "java/pom.xml is at version ${got:-unset}, want $plain"
for module in "${modules[@]}"; do
	pom="$java_dir/$module/pom.xml"
	[[ -f "$pom" ]] || fail "java/$module/pom.xml does not exist"
	got="$(first_version "$pom")"
	[[ "$got" == "$plain" ]] || fail "java/$module/pom.xml is at version ${got:-unset}, want $plain"
done

"$repo_root/scripts/release-notes.sh" "$plain" "$java_dir/CHANGELOG.md" >/dev/null
echo "java-release-check: every POM and java/CHANGELOG.md match $plain"

tmp="$(mktemp -d)"
cleanup() {
	rm -rf -- "$tmp"
}
trap cleanup EXIT

# Each Maven run below gets a fresh local repository of its own, so the
# script writes nothing into the usual one and the consumer can only get the
# libo11y artifacts from the layout built here. Third-party dependencies are
# still read from the usual local repository, as a read-only tail, unless it
# holds ing.o11y artifacts that could shadow the ones under test.
usual_repo="${HOME:-}/.m2/repository"
tail_args=()
if [[ -d "$usual_repo" && ! -e "$usual_repo/ing/o11y" ]]; then
	tail_args=("-Dmaven.repo.local.tail=$usual_repo")
fi

# Build the artifacts into a Maven repository layout. The tests ran in
# `make java-check`; this is the packaging.
stage="$tmp/repository"
"$mvn_cmd" -B -ntp -q -f "$java_dir/pom.xml" -Prelease -DskipTests \
	"-Dmaven.repo.local=$tmp/m2-build" "${tail_args[@]}" -Dmaven.install.skip=true \
	-DaltDeploymentRepository="libo11y-stage::file://$stage" \
	deploy
group_dir="$stage/ing/o11y"
[[ -d "$group_dir" ]] || fail "the build wrote no ing.o11y artifacts"

# require_pom_elements POM ELEMENT...: the POM file itself declares each one.
require_pom_elements() {
	local pom="$1" element
	shift
	for element in "$@"; do
		grep -qE "<${element}[ >]" "$pom" || fail "${pom#"$stage"/} lacks <$element>, which Maven Central requires"
	done
}

jar_modules=()
check_artifact() {
	local artifact="$1" source_pom="$2"
	local dir="$group_dir/$artifact/$plain"
	local base="$dir/$artifact-$plain"
	[[ -f "$base.pom" ]] || fail "missing $artifact-$plain.pom"
	require_pom_elements "$base.pom" name description
	if grep -q '<packaging>pom</packaging>' "$source_pom"; then
		return
	fi
	jar_modules+=("$artifact")
	local suffix
	for suffix in .jar -sources.jar -javadoc.jar; do
		[[ -s "$base$suffix" ]] || fail "missing $artifact-$plain$suffix"
	done
	local listing
	listing="$(jar tf "$base.jar")"
	if grep -qE '(^|/)conformance/' <<<"$listing"; then
		fail "$artifact-$plain.jar contains conformance fixtures"
	fi
	local manifest
	manifest="$(unzip_entry "$base.jar" META-INF/MANIFEST.MF | tr -d '\r')"
	grep -qxF "Implementation-Version: $plain" <<<"$manifest" ||
		fail "$artifact-$plain.jar has no Implementation-Version: $plain in its manifest"
}

# unzip_entry ARCHIVE ENTRY: print one entry, using the JDK so the script
# needs no unzip.
unzip_entry() {
	local archive="$1" entry="$2" out="$tmp/extract"
	rm -rf -- "$out"
	mkdir -p "$out"
	(cd "$out" && jar xf "$archive" "$entry")
	cat "$out/$entry"
}

check_artifact libo11y-parent "$java_dir/pom.xml"
require_pom_elements "$group_dir/libo11y-parent/$plain/libo11y-parent-$plain.pom" url licenses developers scm
for module in "${modules[@]}"; do
	check_artifact "$module" "$java_dir/$module/pom.xml"
done
# The BOM has no parent, so it carries the project metadata itself.
require_pom_elements "$group_dir/libo11y-bom/$plain/libo11y-bom-$plain.pom" url licenses developers scm
[[ "${#jar_modules[@]}" -gt 0 ]] || fail "the reactor built no jars"
echo "java-release-check: ${#jar_modules[@]} jars with sources and javadoc, and every POM, are in the repository layout"

# Build and run a consumer outside the repository.
consumer="$tmp/consumer"
mkdir -p "$consumer/src/main/java"

cat >"$consumer/pom.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <groupId>example.consumer</groupId>
    <artifactId>libo11y-consumer</artifactId>
    <version>1.0.0</version>
    <properties>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>
    <repositories>
        <repository>
            <id>libo11y-stage</id>
            <url>file://$stage</url>
        </repository>
    </repositories>
    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>ing.o11y</groupId>
                <artifactId>libo11y-bom</artifactId>
                <version>$plain</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>ing.o11y</groupId>
            <artifactId>libo11y</artifactId>
        </dependency>
        <dependency>
            <groupId>ing.o11y</groupId>
            <artifactId>libo11y-test</artifactId>
        </dependency>
        <dependency>
            <groupId>ing.o11y</groupId>
            <artifactId>libo11y-cli</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.14.0</version>
            </plugin>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-dependency-plugin</artifactId>
                <version>3.11.0</version>
            </plugin>
        </plugins>
    </build>
</project>
EOF

cat >"$consumer/src/main/java/Consumer.java" <<'EOF'
import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.ShutdownReport;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.test.OtlpHttpReceiver;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import java.util.Map;

public final class Consumer {
    private Consumer() {}

    public static void main(String[] args) throws Exception {
        String want = args[0];
        String got = O11y.class.getPackage().getImplementationVersion();
        if (!want.equals(got)) {
            throw new IllegalStateException("version mismatch: got " + got + ", want " + want);
        }

        try (OtlpHttpReceiver receiver = OtlpHttpReceiver.start()) {
            Telemetry telemetry = O11y.init(O11yOptions.builder()
                    .serviceName("release-consumer")
                    .serviceVersion("1.0.0")
                    .environment("production")
                    .consoleEnabled(false)
                    .runtimeMetrics(false)
                    .env(Map.of(
                            "OTEL_EXPORTER_OTLP_ENDPOINT", receiver.endpoint(),
                            "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"))
                    .build());

            Span span = telemetry.tracer("release-consumer").spanBuilder("consumer.smoke").startSpan();
            try (Scope ignored = span.makeCurrent()) {
                telemetry.logger().info("consumer smoke", Map.of("order.id", "ord-1"));
                telemetry.meter("release-consumer")
                        .counterBuilder("consumer.smoke.runs")
                        .setUnit("{run}")
                        .build()
                        .add(1L, Attributes.of(AttributeKey.stringKey("payment.method"), "card"));
            } finally {
                span.end();
            }

            ShutdownReport report = telemetry.shutdown();
            if (!report.isOk()) {
                throw new IllegalStateException("shutdown reported " + report.errors());
            }
            for (String path : new String[] {"/v1/traces", "/v1/metrics", "/v1/logs"}) {
                if (receiver.requestsForPath(path).isEmpty()) {
                    throw new IllegalStateException("the receiver got no request on " + path);
                }
            }
        }
    }
}
EOF

(
	cd "$consumer"
	"$mvn_cmd" -B -ntp -q "-Dmaven.repo.local=$tmp/m2" "${tail_args[@]}" \
		compile dependency:build-classpath -Dmdep.outputFile="$consumer/classpath.txt"
)
classpath="$consumer/target/classes:$(cat "$consumer/classpath.txt")"

# The consumer must have resolved libo11y from the layout, at this version.
grep -q "/ing/o11y/libo11y/$plain/libo11y-$plain.jar" "$consumer/classpath.txt" ||
	fail "the consumer did not resolve ing.o11y:libo11y:$plain"
[[ -f "$tmp/m2/ing/o11y/libo11y/$plain/libo11y-$plain.jar" ]] ||
	fail "the consumer resolved libo11y from somewhere other than the repository layout"

(cd "$tmp" && java -cp "$classpath" Consumer "$plain")
echo "java-release-check: a consumer exported traces, metrics and logs over OTLP/HTTP"

cat >"$tmp/registry.yaml" <<'EOF'
schema: libo11y.app-registry/v1
namespace: smoke
attributes:
  smoke.order.id: {type: string, sensitivity: internal, cardinality: unbounded}
EOF
good_out="$(cd "$tmp" && java -cp "$classpath" ing.o11y.libo11y.cli.Main registry check registry.yaml)"
[[ "$good_out" == "registry.yaml: ok (1 attribute in namespace smoke)" ]] ||
	fail "libo11y registry check printed \"$good_out\" for a valid registry"
cat >"$tmp/bad-registry.yaml" <<'EOF'
schema: libo11y.app-registry/v1
namespace: smoke
attributes:
  other.order.id: {type: string, sensitivity: internal, cardinality: unbounded}
EOF
bad_status=0
(cd "$tmp" && java -cp "$classpath" ing.o11y.libo11y.cli.Main registry check bad-registry.yaml >"$tmp/bad.out" 2>&1) || bad_status=$?
if [[ "$bad_status" -ne 1 ]]; then
	cat "$tmp/bad.out" >&2
	fail "libo11y registry check exited $bad_status for an attribute outside its namespace, want 1"
fi
grep -qF "bad-registry.yaml: libo11y_app_attr_outside_namespace: attribute other.order.id" "$tmp/bad.out" ||
	fail "libo11y registry check did not name the attribute outside its namespace"
echo "java-release-check: libo11y registry check accepts a valid registry and refuses an invalid one"

if [[ -z "$dist" ]]; then
	exit 0
fi

# The release assets. maven-metadata.xml files describe a repository, not a
# release, so the published layout leaves them out.
find "$stage" -name 'maven-metadata.xml*' -type f -delete

if [[ -n "${MAVEN_GPG_PRIVATE_KEY:-}" ]]; then
	command -v gpg >/dev/null || fail "gpg is not on PATH"
	GNUPGHOME="$tmp/gnupg"
	export GNUPGHOME
	mkdir -m 700 "$GNUPGHOME"
	gpg --batch --quiet --import <<<"$MAVEN_GPG_PRIVATE_KEY"
	signed=0
	while IFS= read -r -d '' file; do
		gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 \
			--armor --detach-sign --output "$file.asc" "$file" 3<<<"${MAVEN_GPG_PASSPHRASE:-}"
		gpg --batch --quiet --verify "$file.asc" "$file" 2>"$tmp/gpg-verify.log" || {
			cat "$tmp/gpg-verify.log" >&2
			fail "the signature of ${file#"$stage"/} does not verify"
		}
		signed=$((signed + 1))
	done < <(find "$stage" -type f ! -name '*.md5' ! -name '*.sha1' ! -name '*.asc' -print0)
	echo "java-release-check: signed and verified $signed files"
else
	echo "java-release-check: MAVEN_GPG_PRIVATE_KEY is not set, so the artifacts are unsigned" >&2
fi

mkdir -p "$dist"
dist="$(cd "$dist" && pwd)"
bundle_name="libo11y-java-v$plain-maven-repository"
bundle_dir="$tmp/$bundle_name"
mkdir -p "$bundle_dir"
cp -R "$stage/ing" "$bundle_dir/ing"
cp "$repo_root/LICENSE" "$java_dir/README.md" "$java_dir/CHANGELOG.md" "$bundle_dir/"
tar -C "$tmp" -czf "$dist/$bundle_name.tar.gz" "$bundle_name"

assets=("$bundle_name.tar.gz")
for artifact in "${jar_modules[@]}"; do
	cp "$group_dir/$artifact/$plain/$artifact-$plain.jar" "$dist/"
	assets+=("$artifact-$plain.jar")
done
(cd "$dist" && sha256sum "${assets[@]}" >SHA256SUMS)
echo "java-release-check: wrote ${#assets[@]} release assets and SHA256SUMS to $dist"

if [[ -n "$central_bundle" ]]; then
	mkdir -p "$(dirname "$central_bundle")"
	central_bundle="$(cd "$(dirname "$central_bundle")" && pwd)/$(basename "$central_bundle")"
	rm -f -- "$central_bundle"
	# jar writes a plain zip with -M (no manifest), so no zip tool is needed.
	(cd "$stage" && jar cMf "$central_bundle" ing)
	echo "java-release-check: wrote the Central Publisher Portal bundle to $central_bundle"
fi
