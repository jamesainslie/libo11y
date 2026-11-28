#!/usr/bin/env bash
# Tests for ruby-gem-plan.sh against a fake curl that answers the
# RubyGems.org versions API from fixtures, so no test reaches the network.
# Needs jq.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/ruby-gem-plan.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# The fake curl reads $FAKE_STATUS and $FAKE_BODY. It writes the body to the
# file after -o, prints the status, and records the URL it was asked for.
# FAKE_STATUS=unreachable makes it fail the way curl does without a network.
mkdir -p "$work/bin"
cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while (($# > 0)); do
	case "$1" in
	-o)
		out="$2"
		shift 2
		;;
	-w | -A | --max-time)
		shift 2
		;;
	-*)
		shift
		;;
	*)
		url="$1"
		shift
		;;
	esac
done
echo "$url" >"$FAKE_URL_LOG"
if [[ "$FAKE_STATUS" == unreachable ]]; then
	echo "curl: (6) Could not resolve host" >&2
	exit 6
fi
printf '%s' "$FAKE_BODY" >"$out"
printf '%s' "$FAKE_STATUS"
EOF
chmod +x "$work/bin/curl"

versions='[{"number":"0.2.0.pre.rc.1","platform":"ruby"},{"number":"0.1.0","platform":"ruby"}]'

# expect_plan <name> <want> <status> <body> <args...>
expect_plan() {
	local name="$1" want="$2" status="$3" body="$4"
	shift 4
	local got
	if ! got="$(PATH="$work/bin:$PATH" FAKE_STATUS="$status" FAKE_BODY="$body" FAKE_URL_LOG="$work/url" "$script" "$@" 2>"$work/err")"; then
		fail "$name: exited non-zero"
		cat "$work/err" >&2
		return
	fi
	if [[ "$got" != "$want" ]]; then
		fail "$name: printed \"$got\", want \"$want\""
		return
	fi
	echo "ok   $name"
}

# expect_failure <name> <exit status> <stderr substring> <status> <body> <args...>
expect_failure() {
	local name="$1" want_status="$2" want_err="$3" status="$4" body="$5"
	shift 5
	local got=0
	PATH="$work/bin:$PATH" FAKE_STATUS="$status" FAKE_BODY="$body" FAKE_URL_LOG="$work/url" "$script" "$@" >"$work/out" 2>"$work/err" || got=$?
	if [[ "$got" -ne "$want_status" ]]; then
		fail "$name: exited $got, want $want_status"
		cat "$work/out" "$work/err" >&2
		return
	fi
	if [[ -s "$work/out" ]]; then
		fail "$name: wrote to stdout"
		cat "$work/out" >&2
		return
	fi
	if ! grep -qF -- "$want_err" "$work/err"; then
		fail "$name: stderr lacks \"$want_err\""
		cat "$work/err" >&2
		return
	fi
	echo "ok   $name"
}

expect_plan "a gem RubyGems.org does not have is new" new 404 "This rubygem could not be found." libo11y 0.1.0
expect_plan "a version RubyGems.org does not have publishes" publish 200 "$versions" libo11y 0.2.0
expect_plan "a version RubyGems.org has is present" present 200 "$versions" libo11y 0.1.0
expect_plan "a prerelease RubyGems.org has is present" present 200 "$versions" libo11y 0.2.0.pre.rc.1
expect_plan "a version that only prefixes a published one publishes" publish 200 "$versions" libo11y 0.1
expect_plan "a gem with no versions publishes" publish 200 "[]" libo11y 0.1.0

expect_plan "asks the versions API for the gem" new 404 "" libo11y 0.1.0
if [[ "$(cat "$work/url")" != "https://rubygems.org/api/v1/versions/libo11y.json" ]]; then
	fail "asked $(cat "$work/url"), want the RubyGems.org versions API"
fi

expect_failure "fails when the registry is unreachable" 1 "could not reach" unreachable "" libo11y 0.1.0
expect_failure "fails on a server error" 1 "answered HTTP 503" 503 "" libo11y 0.1.0
expect_failure "fails on a body that is not a version list" 1 "did not answer with a JSON list" 200 "<html>" libo11y 0.1.0
expect_failure "fails on a JSON object in place of the version list" 1 "did not answer with a JSON list" 200 '{"unexpected":{"number":"0.1.0"}}' libo11y 0.1.0
expect_failure "fails on a version record without a number" 1 "did not answer with a JSON list" 200 '[{"platform":"ruby"}]' libo11y 0.1.0
expect_failure "refuses no argument" 2 "usage" 200 "[]"
expect_failure "refuses a missing version" 2 "usage" 200 "[]" libo11y
expect_failure "refuses an empty version" 2 "usage" 200 "[]" libo11y ""

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
