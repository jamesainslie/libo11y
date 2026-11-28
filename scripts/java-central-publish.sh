#!/usr/bin/env bash
# java-central-publish.sh: publish the libo11y Java artifacts to Maven
# Central through the Central Publisher Portal. It uploads the signed bundle
# that `java-release-check.sh --central-bundle` wrote, asks for automatic
# publishing, and waits until the Portal reports the deployment published.
#
# Usage: java-central-publish.sh [--validate-only] VERSION BUNDLE
#   VERSION  the version in the bundle (the leading v is optional).
#   BUNDLE   the bundle zip.
#   --validate-only  upload for manual publishing, wait until the Portal has
#                    validated the bundle, and then drop the deployment.
#                    Nothing is published. Use it to check a bundle against
#                    the Portal's rules before the first release of a
#                    change to the packaging.
#
# Environment:
#   MAVEN_CENTRAL_USERNAME, MAVEN_CENTRAL_PASSWORD
#       a Central Portal user token (central.sonatype.com, Account, Generate
#       User Token). Required.
#   JAVA_CENTRAL_POLL_SECONDS  seconds between status checks (default 15).
#   JAVA_CENTRAL_MAX_POLLS     status checks before giving up (default 120,
#                              which is 30 minutes).
#
# Maven Central never replaces a published version, so a rerun is safe: when
# Central already serves this version, the script says so and exits 0
# without uploading. Exits 1 when the upload or the deployment fails, and 2
# on a usage error.
set -euo pipefail

fail() {
	echo "java-central-publish: $*" >&2
	exit 1
}

validate_only=false
if [[ "${1:-}" == "--validate-only" ]]; then
	validate_only=true
	shift
fi
if [[ $# -ne 2 || -z "$1" || -z "$2" ]]; then
	echo "usage: java-central-publish.sh [--validate-only] VERSION BUNDLE" >&2
	exit 2
fi
plain="${1#v}"
bundle="$2"
if [[ ! -f "$bundle" ]]; then
	echo "java-central-publish: $bundle does not exist" >&2
	exit 2
fi
if [[ -z "${MAVEN_CENTRAL_USERNAME:-}" || -z "${MAVEN_CENTRAL_PASSWORD:-}" ]]; then
	echo "java-central-publish: MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD must hold a Central Portal user token" >&2
	exit 2
fi
poll_seconds="${JAVA_CENTRAL_POLL_SECONDS:-15}"
max_polls="${JAVA_CENTRAL_MAX_POLLS:-120}"

portal="https://central.sonatype.com/api/v1/publisher"
pom_url="https://repo1.maven.org/maven2/ing/o11y/libo11y/$plain/libo11y-$plain.pom"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

# Only a 404 means the version is free. Any other answer than 200 leaves the
# question open, and uploading on a guess could fail halfway.
code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$pom_url")" ||
	fail "could not ask Maven Central whether $plain exists"
case "$code" in
200)
	echo "java-central-publish: Maven Central already serves ing.o11y:libo11y:$plain; nothing to publish"
	exit 0
	;;
404) ;;
*)
	fail "Maven Central answered HTTP $code for $pom_url; not uploading"
	;;
esac

# The token goes to curl in a header file, never on the command line, where
# other processes on the machine could read it.
header="$work/header"
(
	umask 077
	printf 'Authorization: Bearer %s\n' \
		"$(printf '%s:%s' "$MAVEN_CENTRAL_USERNAME" "$MAVEN_CENTRAL_PASSWORD" | base64 | tr -d '\n')" >"$header"
)

publishing_type=AUTOMATIC
if [[ "$validate_only" == true ]]; then
	publishing_type=USER_MANAGED
fi

# drop_deployment ID: remove a deployment that was only uploaded to be
# validated. The Portal accepts this for a validated or failed deployment.
drop_deployment() {
	curl --silent --show-error --fail-with-body --request DELETE \
		--header "@$header" "$portal/deployment/$1" >/dev/null ||
		fail "could not drop deployment $1; drop it at https://central.sonatype.com/publishing/deployments"
	echo "java-central-publish: dropped deployment $1"
}

upload_status=0
deployment="$(curl --silent --show-error --fail-with-body --request POST \
	--header "@$header" --form "bundle=@$bundle" \
	"$portal/upload?name=libo11y-java-$plain&publishingType=$publishing_type")" || upload_status=$?
if [[ "$upload_status" -ne 0 ]]; then
	echo "$deployment" >&2
	fail "the upload failed (curl exit $upload_status)"
fi
deployment="$(tr -d '[:space:]' <<<"$deployment")"
[[ -n "$deployment" ]] || fail "the Portal returned no deployment ID"
echo "java-central-publish: uploaded deployment $deployment"

state=""
for ((poll = 1; poll <= max_polls; poll++)); do
	body="$(curl --silent --show-error --fail-with-body --request POST \
		--header "@$header" "$portal/status?id=$deployment")" ||
		fail "could not read the status of deployment $deployment"
	state="$(sed -nE 's/.*"deploymentState"[[:space:]]*:[[:space:]]*"([A-Z_]+)".*/\1/p' <<<"$body" | head -n 1)"
	case "$state" in
	PUBLISHED)
		echo "java-central-publish: deployment $deployment is published"
		exit 0
		;;
	FAILED)
		echo "$body" >&2
		if [[ "$validate_only" == true ]]; then
			drop_deployment "$deployment"
		fi
		fail "deployment $deployment failed"
		;;
	VALIDATED)
		if [[ "$validate_only" == true ]]; then
			echo "java-central-publish: deployment $deployment passed validation"
			drop_deployment "$deployment"
			exit 0
		fi
		;;
	PENDING | VALIDATING | PUBLISHING) ;;
	*)
		echo "$body" >&2
		fail "deployment $deployment reported an unknown state"
		;;
	esac
	if [[ "$poll" -lt "$max_polls" ]]; then
		sleep "$poll_seconds"
	fi
done
fail "deployment $deployment is still $state after $max_polls checks; see https://central.sonatype.com/publishing/deployments"
