#!/usr/bin/env bash
# o11yrum-image-check.sh: build the o11yrum-gateway image for the local
# platform only and check that it is what the release publishes: it prints
# the version it was built with, stays under the size budget, runs as an
# unprivileged numeric user, validates the example configuration, and
# serves /healthz and /readyz from a read-only root filesystem with every
# capability dropped, then exits 0 on SIGTERM. It removes the container and
# the image it made, whatever the outcome.
#
# Usage: o11yrum-image-check.sh   (needs docker with buildx and curl)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version=v0.0.0-check
image="o11yrum-gateway:check-$$"
max_bytes=$((40 << 20))
want_user=65532:65532

work="$(mktemp -d)"
container=""
cleanup() {
	if [[ -n "$container" ]]; then
		docker rm -f "$container" >/dev/null 2>&1 || true
	fi
	docker image rm -f "$image" >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

fail() {
	echo "o11yrum-image-check: $*" >&2
	exit 1
}

docker buildx build --load \
	-f "$root/go/o11yrum/Dockerfile" \
	--build-arg "VERSION=$version" \
	-t "$image" \
	"$root/go"

got="$(docker run --rm "$image" -version)"
[[ "$got" == "$version" ]] || fail "-version printed \"$got\", want $version"

size="$(docker image inspect --format '{{.Size}}' "$image")"
((size < max_bytes)) || fail "the image is $size bytes, over the $max_bytes byte budget"

user="$(docker image inspect --format '{{.Config.User}}' "$image")"
[[ "$user" == "$want_user" ]] || fail "the image runs as \"$user\", want $want_user"

testdata="$root/go/o11yrum/cmd/o11yrum-gateway/testdata"
got="$(docker run --rm --read-only -v "$testdata:/etc/o11yrum:ro" "$image" -check-config -config /etc/o11yrum/gateway.yaml)"
[[ "$got" == ok ]] || fail "-check-config printed \"$got\", want ok"

# A minimal configuration the container user can read, with no sink and
# no exporters, so the gateway starts without reaching anything.
conf="$work/conf"
mkdir "$conf"
cat >"$conf/config.yaml" <<'EOF'
listen: :8080
environment: test
apps:
  - service_name: image-check
    origins: ["https://image-check.example"]
EOF
chmod 0755 "$conf"
chmod 0644 "$conf/config.yaml"

container="$(docker run -d \
	--read-only --cap-drop ALL --security-opt no-new-privileges \
	-e OTEL_TRACES_EXPORTER=none -e OTEL_METRICS_EXPORTER=none -e OTEL_LOGS_EXPORTER=none \
	-v "$conf:/etc/o11yrum:ro" \
	-p 127.0.0.1::8080 \
	"$image")"
addr="$(docker port "$container" 8080/tcp | head -n 1)"
[[ -n "$addr" ]] || fail "the container published no port"

healthy=false
for _ in $(seq 1 50); do
	if curl -fsS -o /dev/null "http://$addr/healthz"; then
		healthy=true
		break
	fi
	sleep 0.2
done
if [[ "$healthy" != true ]]; then
	docker logs "$container" >&2 || true
	fail "/healthz did not answer 200 within 10s"
fi
curl -fsS -o /dev/null "http://$addr/readyz" || fail "/readyz did not answer 200"

docker stop -t 30 "$container" >/dev/null
code="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
if [[ "$code" != 0 ]]; then
	docker logs "$container" >&2 || true
	fail "the gateway exited $code on SIGTERM, want 0"
fi

echo "o11yrum-image-check: OK, $size bytes, user $user, healthy on a read-only root filesystem"
