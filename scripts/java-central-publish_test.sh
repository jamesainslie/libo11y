#!/usr/bin/env bash
# Tests for java-central-publish.sh against a fake curl: it skips a version
# Maven Central already serves, uploads the bundle with the token in a header
# file, polls the deployment until it is published, and fails on a failed
# deployment, a timeout, a refused upload or an unreadable registry answer.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/java-central-publish.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# The fake curl answers by URL from files in $FAKE_CURL_DIR:
#   exists-code     the HTTP status of the Maven Central lookup
#   upload-status   the exit status of the upload (default 0)
#   upload-body     the upload's response body
#   status-bodies   one status response per line, consumed in order; the
#                   last line repeats
# It appends each call's arguments to calls.log, copies a header file it is
# given to header.txt, and appends the URL of a deployment request (the drop)
# to dropped.log.
mkdir "$work/bin"
cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_CURL_DIR"
printf '%s\n' "$*" >>"$dir/calls.log"
url="${!#}"
prev=""
for arg in "$@"; do
	if [[ "$prev" == "--header" && "$arg" == @* ]]; then
		cp "${arg#@}" "$dir/header.txt"
	fi
	prev="$arg"
done
case "$url" in
*/maven2/*)
	cat "$dir/exists-code"
	;;
*/upload\?*)
	if [[ -f "$dir/upload-body" ]]; then
		cat "$dir/upload-body"
	fi
	if [[ -f "$dir/upload-status" ]]; then
		exit "$(cat "$dir/upload-status")"
	fi
	;;
*/status\?*)
	count=0
	if [[ -f "$dir/status-count" ]]; then
		count="$(cat "$dir/status-count")"
	fi
	count=$((count + 1))
	echo "$count" >"$dir/status-count"
	total="$(wc -l <"$dir/status-bodies")"
	line="$count"
	if [[ "$line" -gt "$total" ]]; then
		line="$total"
	fi
	sed -n "${line}p" "$dir/status-bodies"
	;;
*/deployment/*)
	echo "$url" >>"$dir/dropped.log"
	;;
*)
	echo "fake curl: unexpected URL $url" >&2
	exit 3
	;;
esac
EOF
chmod +x "$work/bin/curl"

bundle="$work/central-bundle.zip"
printf 'not a real bundle\n' >"$bundle"

# run_case <name>: runs the script with the fake curl in a fresh state
# directory prepared by the caller in $state. Sets $status, and the output
# lands in $state/out and $state/err.
new_state() {
	state="$work/state-$1"
	mkdir "$state"
}
run_script() {
	status=0
	PATH="$work/bin:$PATH" FAKE_CURL_DIR="$state" \
		JAVA_CENTRAL_POLL_SECONDS=0 JAVA_CENTRAL_MAX_POLLS=5 \
		"$@" >"$state/out" 2>"$state/err" || status=$?
}
expect_status() {
	local name="$1" want="$2"
	if [[ "$status" -ne "$want" ]]; then
		fail "$name: exited $status, want $want"
		cat "$state/out" "$state/err" >&2
		return 1
	fi
}
expect_err() {
	local name="$1" want="$2"
	if ! grep -qF -- "$want" "$state/err" "$state/out"; then
		fail "$name: output lacks \"$want\""
		cat "$state/out" "$state/err" >&2
		return 1
	fi
}
calls() {
	if [[ -f "$state/calls.log" ]]; then
		grep -c -- "$1" "$state/calls.log" || true
	else
		echo 0
	fi
}

name="skips a version Maven Central already serves"
new_state skip
echo 200 >"$state/exists-code"
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$bundle"
if expect_status "$name" 0 && expect_err "$name" "already serves"; then
	if [[ "$(calls /upload)" -ne 0 ]]; then
		fail "$name: uploaded anyway"
	else
		echo "ok   $name"
	fi
fi

name="uploads and waits until the deployment is published"
new_state publish
echo 404 >"$state/exists-code"
echo "28570f16-da32-4c14-bd2e-c1acc0782365" >"$state/upload-body"
cat >"$state/status-bodies" <<'EOF'
{"deploymentId":"28570f16-da32-4c14-bd2e-c1acc0782365","deploymentState":"VALIDATING"}
{"deploymentId":"28570f16-da32-4c14-bd2e-c1acc0782365","deploymentState":"PUBLISHING"}
{"deploymentId":"28570f16-da32-4c14-bd2e-c1acc0782365","deploymentState":"PUBLISHED"}
EOF
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$bundle"
if expect_status "$name" 0 && expect_err "$name" "published"; then
	want_header="Authorization: Bearer $(printf 'user:secret-token' | base64 | tr -d '\n')"
	if [[ "$(cat "$state/header.txt")" != "$want_header" ]]; then
		fail "$name: wrong Authorization header"
	elif grep -qF -e "secret-token" -e "$(printf 'user:secret-token' | base64 | tr -d '\n')" "$state/calls.log"; then
		fail "$name: the token reached curl's arguments"
	elif ! grep -qF "publishingType=AUTOMATIC" "$state/calls.log"; then
		fail "$name: the upload did not ask for automatic publishing"
	elif ! grep -qF "bundle=@$bundle" "$state/calls.log"; then
		fail "$name: the upload did not send the bundle"
	elif [[ "$(cat "$state/status-count")" -ne 3 ]]; then
		fail "$name: polled $(cat "$state/status-count") times, want 3"
	else
		echo "ok   $name"
	fi
fi

name="fails when the deployment fails validation"
new_state failed
echo 404 >"$state/exists-code"
echo "id-1" >"$state/upload-body"
cat >"$state/status-bodies" <<'EOF'
{"deploymentId":"id-1","deploymentState":"VALIDATING"}
{"deploymentId":"id-1","deploymentState":"FAILED","errors":{"pkg:maven/ing.o11y/libo11y@0.1.0":["Missing signature for file: libo11y-0.1.0.jar"]}}
EOF
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$bundle"
if expect_status "$name" 1 && expect_err "$name" "Missing signature for file"; then
	echo "ok   $name"
fi

name="fails when the deployment never finishes"
new_state timeout
echo 404 >"$state/exists-code"
echo "id-2" >"$state/upload-body"
echo '{"deploymentId":"id-2","deploymentState":"PUBLISHING"}' >"$state/status-bodies"
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$bundle"
if expect_status "$name" 1 && expect_err "$name" "still PUBLISHING"; then
	if [[ "$(cat "$state/status-count")" -ne 5 ]]; then
		fail "$name: polled $(cat "$state/status-count") times, want 5"
	else
		echo "ok   $name"
	fi
fi

name="fails when the upload is refused"
new_state refused
echo 404 >"$state/exists-code"
echo "Unauthorized" >"$state/upload-body"
echo 22 >"$state/upload-status"
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$bundle"
if expect_status "$name" 1 && expect_err "$name" "upload failed"; then
	if [[ "$(calls /status)" -ne 0 ]]; then
		fail "$name: polled after a refused upload"
	else
		echo "ok   $name"
	fi
fi

name="does not upload when the Maven Central lookup is inconclusive"
new_state inconclusive
echo 503 >"$state/exists-code"
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$bundle"
if expect_status "$name" 1 && expect_err "$name" "HTTP 503"; then
	if [[ "$(calls /upload)" -ne 0 ]]; then
		fail "$name: uploaded anyway"
	else
		echo "ok   $name"
	fi
fi

name="validate-only uploads for manual publishing, waits for validation and drops the deployment"
new_state validate
echo 404 >"$state/exists-code"
echo "id-3" >"$state/upload-body"
cat >"$state/status-bodies" <<'EOF'
{"deploymentId":"id-3","deploymentState":"PENDING"}
{"deploymentId":"id-3","deploymentState":"VALIDATED"}
EOF
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" --validate-only v0.1.0 "$bundle"
if expect_status "$name" 0 && expect_err "$name" "passed validation"; then
	if ! grep -qF "publishingType=USER_MANAGED" "$state/calls.log"; then
		fail "$name: the upload did not ask for manual publishing"
	elif grep -qF "publishingType=AUTOMATIC" "$state/calls.log"; then
		fail "$name: the upload asked for automatic publishing"
	elif ! grep -qF "/deployment/id-3" "$state/dropped.log"; then
		fail "$name: the deployment was not dropped"
	elif ! grep -qF -- "--request DELETE" "$state/calls.log"; then
		fail "$name: the drop was not a DELETE"
	else
		echo "ok   $name"
	fi
fi

name="validate-only fails on a failed validation and still drops the deployment"
new_state validatefail
echo 404 >"$state/exists-code"
echo "id-4" >"$state/upload-body"
echo '{"deploymentId":"id-4","deploymentState":"FAILED","errors":{"x":["Javadocs must be provided"]}}' >"$state/status-bodies"
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" --validate-only v0.1.0 "$bundle"
if expect_status "$name" 1 && expect_err "$name" "Javadocs must be provided"; then
	if ! grep -qF "/deployment/id-4" "$state/dropped.log"; then
		fail "$name: the failed deployment was not dropped"
	else
		echo "ok   $name"
	fi
fi

name="a publishing run never drops its deployment"
new_state nodrop
echo 404 >"$state/exists-code"
echo "id-5" >"$state/upload-body"
echo '{"deploymentId":"id-5","deploymentState":"PUBLISHED"}' >"$state/status-bodies"
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$bundle"
if expect_status "$name" 0; then
	if [[ -f "$state/dropped.log" ]]; then
		fail "$name: a published deployment was dropped"
	else
		echo "ok   $name"
	fi
fi

name="refuses to run without the token"
new_state notoken
echo 404 >"$state/exists-code"
run_script env -u MAVEN_CENTRAL_USERNAME -u MAVEN_CENTRAL_PASSWORD "$script" v0.1.0 "$bundle"
if expect_status "$name" 2 && expect_err "$name" "MAVEN_CENTRAL_USERNAME"; then
	echo "ok   $name"
fi

name="refuses a missing bundle"
new_state nobundle
echo 404 >"$state/exists-code"
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0 "$work/absent.zip"
if expect_status "$name" 2 && expect_err "$name" "does not exist"; then
	echo "ok   $name"
fi

name="refuses the wrong number of arguments"
new_state usage
run_script env MAVEN_CENTRAL_USERNAME=user MAVEN_CENTRAL_PASSWORD=secret-token "$script" v0.1.0
if expect_status "$name" 2 && expect_err "$name" "usage"; then
	echo "ok   $name"
fi

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
