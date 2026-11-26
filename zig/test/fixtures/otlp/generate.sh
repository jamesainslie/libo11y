#!/usr/bin/env bash
# generate.sh: encode the text-format OTLP requests in this directory into
# the binary fixtures the Zig decode test reads, with protoc rather than
# the Zig bindings, so the test checks the bindings against an
# independent encoder.
#
# Usage: generate.sh PROTOC PROTO_ROOT
#
# PROTOC is protoc 36.2. PROTO_ROOT is a checkout of
# open-telemetry/opentelemetry-proto v1.11.0, the release the Zig
# bindings were generated from.
set -euo pipefail

(($# == 2)) || {
	echo "usage: generate.sh PROTOC PROTO_ROOT" >&2
	exit 2
}
protoc="$1"
proto_root="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

encode() {
	local signal="$1" message="$2"
	"$protoc" -I "$proto_root" \
		--encode="opentelemetry.proto.collector.$signal.v1.$message" \
		"opentelemetry/proto/collector/$signal/v1/${signal}_service.proto" \
		<"$here/$signal.txtpb" >"$here/$signal.binpb"
}

encode trace ExportTraceServiceRequest
encode metrics ExportMetricsServiceRequest
encode logs ExportLogsServiceRequest
