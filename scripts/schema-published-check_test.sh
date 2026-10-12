#!/usr/bin/env bash
# Tests for schema-published-check.sh against a loopback HTTP server: the
# check passes only when the served file matches spec/schemas/<version>
# byte for byte.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/schema-published-check.sh"
version="$(sed -n 's|^schema_url: .*/||p' "$root/spec/registry/manifest.yaml")"

work="$(mktemp -d)"
server_pid=""
cleanup() {
	if [[ -n "$server_pid" ]]; then
		kill "$server_pid"
		local status=0
		wait "$server_pid" || status=$?
		# 143 is the server exiting on our SIGTERM.
		if [[ "$status" -ne 0 && "$status" -ne 143 ]]; then
			echo "test server exited with status $status" >&2
		fi
	fi
	rm -rf -- "$work"
}
trap cleanup EXIT

mkdir -p "$work/match/libo11y" "$work/mismatch/libo11y"
cp "$root/spec/schemas/$version" "$work/match/libo11y/$version"
printf 'file_format: 1.1.0\n' > "$work/mismatch/libo11y/$version"

port=18799
python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$work" > "$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do
	if curl -fsS -o /dev/null "http://127.0.0.1:$port/"; then
		break
	fi
	sleep 0.1
done

failures=0
# expect <name> <pass|fail> <url>
expect() {
	local name="$1" want="$2" url="$3"
	local got=pass
	if ! "$script" "$url" > "$work/out" 2>&1; then
		got=fail
	fi
	if [[ "$got" == "$want" ]]; then
		echo "ok   $name"
	else
		echo "FAIL $name: want $want, got $got" >&2
		cat "$work/out" >&2
		failures=$((failures + 1))
	fi
}

base="http://127.0.0.1:$port"
expect "identical file passes" pass "$base/match/libo11y/$version"
expect "different file fails" fail "$base/mismatch/libo11y/$version"
expect "missing file fails" fail "$base/absent/libo11y/$version"

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
