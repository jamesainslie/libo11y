#!/usr/bin/env bash
# ts-release-check.sh: build and pack the @libo11y/* packages the way a
# release would, then install the tarballs into a throwaway consumer
# outside the repository and import them under Node and under Bun.
#
# Usage: ts-release-check.sh [VERSION]   (default v0.0.0; `make
# release-check` passes TS_RELEASE_VERSION). Every package must already
# be at VERSION. The packages stay at 0.0.0 until a release commit moves
# them, here and TS_RELEASE_VERSION in the Makefile, together.
# Needs a clean working tree, bun, node and npm. npm install reaches the
# registry for the packages' third-party dependencies.
set -euo pipefail

version="${1:-v0.0.0}"
plain="${version#v}"

repo_root="$(git rev-parse --show-toplevel)"
if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
	echo "ts-release-check: commit or stash changes first; the check packs HEAD" >&2
	exit 1
fi
ts="$repo_root/ts"

tmp="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
	echo "ts-release-check: $*" >&2
	exit 1
}

for manifest in "$ts"/packages/*/package.json; do
	got="$(jq -r .version "$manifest")"
	[[ "$got" == "$plain" ]] || fail "${manifest#"$repo_root/"} is at version $got, want $plain"
done

pack_flags=()
if [[ "$plain" == "0.0.0" ]]; then
	pack_flags+=(--allow-unreleased)
fi

(
	cd "$ts"
	bun install --frozen-lockfile
	bun run build
	# The guarded expansion keeps set -u happy on bash 3.2 when the array is empty.
	bun scripts/release.ts pack "$tmp/packs" ${pack_flags[@]+"${pack_flags[@]}"}
)

shopt -s nullglob
tarballs=("$tmp"/packs/*.tgz)
shopt -u nullglob
((${#tarballs[@]} > 0)) || fail "pack wrote no tarballs"

has_bin=false
for tarball in "${tarballs[@]}"; do
	name="$(basename "$tarball")"
	manifest="$(tar -xOf "$tarball" package/package.json)"
	if grep -q 'workspace:' <<<"$manifest"; then
		fail "$name: package.json still has a workspace: range"
	fi
	listing="$(tar -tf "$tarball")"
	# Every string under exports and bin names a file the tarball must hold.
	while IFS= read -r target; do
		[[ -n "$target" ]] || continue
		grep -qxF "package/${target#./}" <<<"$listing" || fail "$name: $target is not in the tarball"
	done < <(jq -r '[.exports, .bin] | .. | strings' <<<"$manifest")
	if [[ "$(jq -r '.bin // empty | length' <<<"$manifest")" != "" ]]; then
		has_bin=true
	fi
	echo "ts-release-check: $name ok"
done

consumer="$tmp/consumer"
mkdir -p "$consumer"
printf '{ "name": "libo11y-consumer", "private": true, "type": "module" }\n' >"$consumer/package.json"
(
	cd "$consumer"
	npm install --no-audit --no-fund --ignore-scripts --loglevel=error "${tarballs[@]}"

	smoke='import { SPEC_VERSION } from "@libo11y/spec"; console.log(SPEC_VERSION);'
	node_version="$(node --input-type=module -e "$smoke")"
	bun_version="$(bun -e "$smoke")"
	[[ -n "$node_version" ]] || fail "node import printed no SPEC_VERSION"
	[[ "$node_version" == "$bun_version" ]] || fail "node printed $node_version, bun printed $bun_version"
	echo "ts-release-check: import @libo11y/spec ok under node and bun (spec $node_version)"

	yaml_smoke='import { parseAppRegistry } from "@libo11y/spec/yaml"; console.log(parseAppRegistry("schema: x\nnamespace: lor\n").namespace);'
	[[ "$(node --input-type=module -e "$yaml_smoke")" == lor ]] || fail "node could not parse with @libo11y/spec/yaml"
	[[ "$(bun -e "$yaml_smoke")" == lor ]] || fail "bun could not parse with @libo11y/spec/yaml"
	echo "ts-release-check: import @libo11y/spec/yaml ok under node and bun"

	core_smoke='import { O11yError } from "@libo11y/core"; import { createTestPlatform } from "@libo11y/core/testing"; const p = createTestPlatform({ contextManager: () => ({}) }); p.writeConsoleLine(new O11yError("EXPORTER", "x").code); console.log(p.lines[0]);'
	[[ "$(node --input-type=module -e "$core_smoke")" == EXPORTER ]] || fail "node could not import @libo11y/core"
	[[ "$(bun -e "$core_smoke")" == EXPORTER ]] || fail "bun could not import @libo11y/core"
	echo "ts-release-check: import @libo11y/core and @libo11y/core/testing ok under node and bun"

	test_smoke='import { createRecorder, startOtlpSink } from "@libo11y/test"; const s = await startOtlpSink(); await fetch(s.url + "/v1/logs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await s.waitFor("logs", 1, 5000); await s.close(); const r = await createRecorder(); r.telemetry.logger.info("recorded"); console.log(r.logs()[0]?.body); await r.shutdown();'
	[[ "$(node --input-type=module -e "$test_smoke")" == recorded ]] || fail "node could not import @libo11y/test"
	[[ "$(bun -e "$test_smoke")" == recorded ]] || fail "bun could not import @libo11y/test"
	echo "ts-release-check: import @libo11y/test ok under node and bun"

	server_smoke='import { createTelemetry } from "@libo11y/server"; const t = await createTelemetry({ serviceName: "smoke", environment: "test", hermetic: true, console: false, runtimeMetrics: false }); console.log(t.resource.attributes["process.runtime.name"]); await t.shutdown();'
	[[ "$(node --input-type=module -e "$server_smoke")" == nodejs ]] || fail "node could not import @libo11y/server"
	[[ "$(bun -e "$server_smoke")" == bun ]] || fail "bun could not import @libo11y/server"
	echo "ts-release-check: import @libo11y/server ok under node and bun"

	serve_smoke='import { instrumentFetch, instrumentServe } from "@libo11y/server"; const f = instrumentFetch(async () => new Response("up")); const h = instrumentServe(async () => f("http://upstream.test/")); console.log(await (await h(new Request("http://svc.test/"))).text());'
	[[ "$(node --input-type=module -e "$serve_smoke")" == up ]] || fail "node could not run instrumentServe and instrumentFetch"
	[[ "$(bun -e "$serve_smoke")" == up ]] || fail "bun could not run instrumentServe and instrumentFetch"
	echo "ts-release-check: instrumentServe and instrumentFetch ok under node and bun"

	# The published declarations must typecheck for a nodenext consumer.
	cat >check.ts <<'TS'
import { type AppRegistry, compileAppRegistry, SPEC_VERSION, validateAppRegistry } from "@libo11y/spec";
import { AppRegistryParseError, parseAppRegistry, parseAppRegistryBytes } from "@libo11y/spec/yaml";
import { O11yError, type TelemetryOptions } from "@libo11y/core";
import { createTestPlatform } from "@libo11y/core/testing";
import { createRecorder, type OtlpSink, type RecorderOptions, startOtlpSink } from "@libo11y/test";
import {
  createTelemetry,
  type FetchOptions,
  instrumentFetch,
  instrumentServe,
  loadAppRegistry,
  type ServeOptions,
  setup,
  type ShutdownOnSignalsOptions,
  shutdownOnSignals,
} from "@libo11y/server";

const reg: AppRegistry = parseAppRegistry("schema: x\nnamespace: lor\n");
const result = validateAppRegistry(reg);
const kind: string = new AppRegistryParseError("syntax").kind;
const version: string = SPEC_VERSION;
const options: TelemetryOptions = { serviceName: "svc", registry: reg };
const recorderOptions: RecorderOptions = { serviceName: "svc" };
const sinkUrl = (sink: OtlpSink): string => sink.url;
const signalOptions: ShutdownOnSignalsOptions = { signals: ["SIGTERM"], timeoutMillis: 1000 };
const serveOptions: ServeOptions = { route: () => "/", serverTiming: true, ignorePaths: ["/healthz"] };
const handler: (req: Request) => Promise<Response> = instrumentServe(async () => new Response("ok"), serveOptions);
const fetchOptions: FetchOptions = { peerService: "upstream", propagate: (url) => url.hostname !== "example.com" };
const traced: typeof fetch = instrumentFetch(fetch, fetchOptions);
export const checked: readonly unknown[] = [
  result.ok,
  kind,
  version,
  compileAppRegistry,
  parseAppRegistryBytes,
  options,
  O11yError,
  createTestPlatform,
  createRecorder,
  recorderOptions,
  startOtlpSink,
  sinkUrl,
  createTelemetry,
  loadAppRegistry,
  setup,
  shutdownOnSignals,
  signalOptions,
  handler,
  traced,
];
TS
	# A server consumer has its runtime's types, which declare fetch, Request, Response and URL.
	# The workspace's pinned @types/node stands in for them.
	cat >tsconfig.json <<JSON
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "lib": ["es2023"],
    "strict": true,
    "noEmit": true,
    "typeRoots": ["$ts/node_modules/@types"],
    "types": ["node"]
  },
  "files": ["check.ts"]
}
JSON
	"$ts/node_modules/.bin/tsc" -p tsconfig.json
	echo "ts-release-check: the declarations typecheck for a nodenext consumer"

	if [[ "$has_bin" == true ]]; then
		valid="$repo_root/conformance/appregistry/valid.yaml"
		npx --no-install libo11y registry check "$valid"
		bun node_modules/.bin/libo11y registry check "$valid"
		echo "ts-release-check: libo11y registry check ok under node and bun"
	fi
)

echo "ts-release-check: packages at $version pack and install cleanly"
