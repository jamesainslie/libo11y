#!/usr/bin/env bash
# ruby-release-check.sh: validate the libo11y gem as an external consumer
# installs and runs it.
#
# Usage: ruby-release-check.sh [VERSION] [--out DIR] [--from-rubygems]
#
# Defaults:
#   VERSION  v0.2.0 (leading v is optional; `make ruby-release-check` passes
#            $(RUBY_RELEASE_VERSION)). A semver prerelease such as
#            0.2.0-rc.1 is the gem version 0.2.0.pre.rc.1.
#
# Without --from-rubygems:
#   Verifies ruby/lib/libo11y/version.rb carries VERSION and
#   ruby/CHANGELOG.md has release notes for it, builds the gem with
#   `gem build --strict`, verifies it ships the Ruby sources under lib/,
#   exe/libo11y, LICENSE, README.md and CHANGELOG.md and no other file,
#   installs it into a throwaway gem home, and runs the consumer smoke test
#   below.
#
# With --out DIR:
#   Also copies the gem it validated to DIR with a SHA256SUMS file. The
#   release workflow publishes those two files.
#
# With --from-rubygems (the release workflow's rubygems-smoke job):
#   Installs libo11y at VERSION from RubyGems.org instead of building it.
#
# The consumer smoke test runs outside the repository. With only the gem's
# declared dependencies installed it records a span, a metric and a
# correlated log through Libo11y::Testing::Recorder. Then it installs
# webrick, which only the in-process OTLP receiver needs, and exports all
# three signals over OTLP/HTTP to Libo11y::Testing::OtlpHttpReceiver. Last
# it runs the installed `libo11y registry check`. Needs ruby and gem.
set -euo pipefail

version="v0.2.0"
version_set=false
from_rubygems=false
out=""

usage() {
	echo "usage: ruby-release-check.sh [VERSION] [--out DIR] [--from-rubygems]" >&2
}

while (($# > 0)); do
	case "$1" in
	--from-rubygems)
		from_rubygems=true
		shift
		;;
	--out)
		if [[ $# -lt 2 || -z "$2" ]]; then
			usage
			exit 2
		fi
		out="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		echo "ruby-release-check: unknown option: $1" >&2
		exit 2
		;;
	*)
		if [[ "$version_set" == true ]]; then
			usage
			exit 2
		fi
		version="$1"
		version_set=true
		shift
		;;
	esac
done

fail() {
	echo "ruby-release-check: $*" >&2
	exit 1
}

plain="${version#v}"
[[ -n "$plain" ]] || fail "version must not be empty"
if [[ "$from_rubygems" == true && -n "$out" ]]; then
	echo "ruby-release-check: --out and --from-rubygems do not combine" >&2
	exit 2
fi
command -v ruby >/dev/null || fail "ruby is not on PATH"
command -v gem >/dev/null || fail "gem is not on PATH"

# The version as RubyGems prints it: 0.2.0-rc.1 becomes 0.2.0.pre.rc.1.
gem_version="$(ruby -e 'puts Gem::Version.new(ARGV.fetch(0))' "$plain")" || fail "$plain is not a gem version"

tmp="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp"
}
trap cleanup EXIT

gems="$tmp/gems"
# Installs into the throwaway gem home only. --norc keeps a developer's
# ~/.gemrc out of the result.
gem_install() {
	gem install --norc --no-document --install-dir "$gems" --bindir "$gems/bin" "$@" >"$tmp/gem-install.log" 2>&1 || {
		cat "$tmp/gem-install.log" >&2
		fail "gem install $* failed"
	}
}

if [[ "$from_rubygems" == true ]]; then
	gem_install libo11y --version "$gem_version"
	echo "ruby-release-check: installed libo11y $gem_version from RubyGems.org"
else
	repo_root="$(git rev-parse --show-toplevel)"
	got="$(sed -nE 's/^[[:space:]]*VERSION[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$repo_root/ruby/lib/libo11y/version.rb" | head -n 1)"
	[[ -n "$got" ]] || fail "ruby/lib/libo11y/version.rb sets no VERSION"
	got_gem="$(ruby -e 'puts Gem::Version.new(ARGV.fetch(0))' "$got")" || fail "ruby/lib/libo11y/version.rb: $got is not a gem version"
	[[ "$got_gem" == "$gem_version" ]] || fail "ruby/lib/libo11y/version.rb is at version $got, want $plain"

	"$repo_root/scripts/release-notes.sh" "$plain" "$repo_root/ruby/CHANGELOG.md" >/dev/null
	echo "ruby-release-check: ruby/lib/libo11y/version.rb and ruby/CHANGELOG.md match $plain"

	gem_file="$tmp/libo11y-$gem_version.gem"
	# --strict turns every gemspec warning into a failure.
	(cd "$repo_root/ruby" && gem build --norc --strict --output "$gem_file" libo11y.gemspec) >"$tmp/gem-build.log" 2>&1 || {
		cat "$tmp/gem-build.log" >&2
		fail "gem build failed"
	}

	ruby -rrubygems/package - "$gem_file" "$gem_version" <<'RUBY'
gem_file, want_version = ARGV
package = Gem::Package.new(gem_file)
spec = package.spec
abort "gem is version #{spec.version}, want #{want_version}" unless spec.version == Gem::Version.new(want_version)

files = package.contents
%w[lib/libo11y.rb lib/libo11y/version.rb lib/libo11y/testing.rb exe/libo11y LICENSE README.md CHANGELOG.md].each do |want|
  abort "gem is missing #{want}" unless files.include?(want)
end
stray = files.reject { |f| f.match?(%r{\Alib/[\w/]+\.rb\z}) || %w[exe/libo11y LICENSE README.md CHANGELOG.md].include?(f) }
abort "gem unexpectedly contains #{stray.join(", ")}" unless stray.empty?
abort "gem does not install the libo11y executable" unless spec.executables == ["libo11y"]
RUBY
	echo "ruby-release-check: the gem ships the Ruby sources under lib/, exe/libo11y, LICENSE, README.md and CHANGELOG.md only"

	gem_install "$gem_file"

	if [[ -n "$out" ]]; then
		mkdir -p "$out"
		cp "$gem_file" "$out/"
		(cd "$out" && sha256sum "libo11y-$gem_version.gem" >SHA256SUMS)
		echo "ruby-release-check: wrote $out/libo11y-$gem_version.gem and SHA256SUMS"
	fi
fi

# The consumer sees the throwaway gem home and Ruby's own default gems,
# never the repository or a bundle.
run_consumer() {
	(cd "$tmp" && env -u BUNDLE_GEMFILE -u RUBYOPT -u RUBYLIB GEM_HOME="$gems" GEM_PATH="$gems" "$@")
}

cat >"$tmp/recorder_smoke.rb" <<'RUBY'
# frozen_string_literal: true

require "libo11y"
require "libo11y/testing"

want = Gem::Version.new(ARGV.fetch(0))
got = Gem.loaded_specs.fetch("libo11y").version
abort "installed libo11y is #{got}, want #{want}" unless got == want
abort "Libo11y::VERSION is #{Libo11y::VERSION}, want #{want}" unless Gem::Version.new(Libo11y::VERSION) == want

Libo11y::Testing.start_recorder(service_name: "ruby-release-smoke") do |rec|
  tel = rec.telemetry
  counter = tel.meter("smoke").create_counter("smoke.requests", unit: "{request}")
  tel.tracer("smoke").in_span("smoke-op") do
    tel.logger.info("smoke-log", { "smoke.ok" => true })
    counter.add(1, attributes: { "http.request.method" => "GET" })
  end
  rec.assert_conforms!
  rec.assert_correlated!
  abort "missing smoke-op span: #{rec.spans.map(&:name)}" unless rec.spans.map(&:name) == ["smoke-op"]
  abort "missing smoke.requests metric: #{rec.metrics.map(&:name)}" unless rec.metrics.map(&:name).include?("smoke.requests")
end
RUBY

cat >"$tmp/wire_smoke.rb" <<'RUBY'
# frozen_string_literal: true

require "libo11y"
require "libo11y/testing"

receiver = Libo11y::Testing::OtlpHttpReceiver.new
begin
  tel = Libo11y.init(
    service_name: "ruby-release-smoke",
    version: ARGV.fetch(0),
    environment: "test",
    env: {
      "OTEL_EXPORTER_OTLP_ENDPOINT" => receiver.endpoint,
      "OTEL_EXPORTER_OTLP_PROTOCOL" => "http/protobuf",
      "OTEL_TRACES_EXPORTER" => "otlp",
      "OTEL_METRICS_EXPORTER" => "otlp",
      "OTEL_LOGS_EXPORTER" => "otlp"
    },
    console_enabled: false,
    runtime_metrics: false
  )
  counter = tel.meter("smoke").create_counter("smoke.requests", unit: "{request}")
  trace_id = nil
  span_id = nil
  tel.tracer("smoke").in_span("smoke-op") do |span|
    trace_id = span.context.trace_id
    span_id = span.context.span_id
    tel.logger.info("smoke-log", { "smoke.ok" => true })
    counter.add(1, attributes: { "http.request.method" => "GET" })
  end

  report = tel.shutdown(timeout: 5.0)
  abort "shutdown failed: #{report.errors}" unless report.ok?

  spans = receiver.trace_requests.flat_map(&:resource_spans).flat_map(&:scope_spans).flat_map(&:spans)
  abort "missing smoke-op span: #{spans.map(&:name)}" unless spans.map(&:name).include?("smoke-op")

  metrics = receiver.metric_requests.flat_map(&:resource_metrics).flat_map(&:scope_metrics).flat_map(&:metrics)
  abort "missing smoke.requests metric: #{metrics.map(&:name)}" unless metrics.map(&:name).include?("smoke.requests")

  logs = receiver.log_requests.flat_map(&:resource_logs).flat_map(&:scope_logs).flat_map(&:log_records)
  record = logs.find { |lr| lr.body.string_value == "smoke-log" }
  abort "missing smoke-log record: #{logs.map { |lr| lr.body.string_value }}" if record.nil?
  abort "log record trace and span correlation mismatch" unless record.trace_id == trace_id && record.span_id == span_id
ensure
  receiver.stop
end
RUBY

run_consumer ruby "$tmp/recorder_smoke.rb" "$gem_version"
echo "ruby-release-check: the recorder runs on the gem's declared dependencies alone"

gem_install webrick
run_consumer ruby "$tmp/wire_smoke.rb" "$gem_version"

cat >"$tmp/registry.yaml" <<'EOF'
schema: libo11y.app-registry/v1
namespace: smoke
attributes:
  smoke.order.id: {type: string, sensitivity: internal, cardinality: unbounded}
EOF
run_consumer "$gems/bin/libo11y" registry check "$tmp/registry.yaml" >"$tmp/registry.out" || {
	cat "$tmp/registry.out" >&2
	fail "the installed libo11y registry check failed"
}
grep -qF "ok (1 attribute in namespace smoke)" "$tmp/registry.out" || fail "libo11y registry check printed: $(cat "$tmp/registry.out")"

echo "ruby-release-check: OK, libo11y $gem_version installs, exports a span, a metric and a correlated log, and runs its CLI"
