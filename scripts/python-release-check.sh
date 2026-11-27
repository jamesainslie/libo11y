#!/usr/bin/env bash
# python-release-check.sh: validate the libo11y Python distribution as an
# external consumer installs and runs it.
#
# Usage: python-release-check.sh [VERSION] [--from-pypi]
#
# Defaults:
#   VERSION  v0.1.0 (leading v is optional; `make python-release-check` passes
#            $(PYTHON_RELEASE_VERSION)).
#
# Without --from-pypi:
#   Verifies python/pyproject.toml carries VERSION and python/CHANGELOG.md has
#   release notes for VERSION, builds sdist and wheel with `uv build`, verifies
#   neither ships conformance/ or tests/ and that py.typed is present, installs
#   the wheel into a throwaway venv, and runs a consumer smoke test against an
#   in-process OTLPHTTPReceiver.
#
# With --from-pypi (used by the release workflow's pypi-smoke job):
#   Installs `libo11y==VERSION` directly from PyPI into a throwaway venv and
#   runs the same consumer smoke test.
set -euo pipefail

version="v0.1.0"
version_set=false
from_pypi=false

while (($# > 0)); do
	case "$1" in
	--from-pypi)
		from_pypi=true
		shift
		;;
	-h | --help)
		echo "usage: python-release-check.sh [VERSION] [--from-pypi]" >&2
		exit 0
		;;
	-*)
		echo "python-release-check: unknown option: $1" >&2
		exit 2
		;;
	*)
		if [[ "$version_set" == true ]]; then
			echo "usage: python-release-check.sh [VERSION] [--from-pypi]" >&2
			exit 2
		fi
		version="$1"
		version_set=true
		shift
		;;
	esac
done

plain="${version#v}"
if [[ -z "$plain" ]]; then
	echo "python-release-check: version must not be empty" >&2
	exit 1
fi

fail() {
	echo "python-release-check: $*" >&2
	exit 1
}

tmp="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp"
}
trap cleanup EXIT

venv="$tmp/venv"
uv venv --quiet --python ">=3.12" "$venv"
venv_py="$venv/bin/python"

if [[ "$from_pypi" == true ]]; then
	uv pip install --quiet --python "$venv_py" "libo11y==$plain"
	echo "python-release-check: installed libo11y==$plain from PyPI"
else
	repo_root="$(git rev-parse --show-toplevel)"
	got="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$repo_root/python/pyproject.toml" | head -n 1)"
	[[ "$got" == "$plain" ]] || fail "python/pyproject.toml is at version ${got:-unset}, want $plain"

	"$repo_root/scripts/release-notes.sh" "$plain" "$repo_root/python/CHANGELOG.md" >/dev/null
	echo "python-release-check: python/pyproject.toml and python/CHANGELOG.md match $plain"

	dist="$tmp/dist"
	uv build --quiet --out-dir "$dist" "$repo_root/python"

	wheel="$(find "$dist" -maxdepth 1 -name "libo11y-${plain}-*.whl" | head -n 1)"
	sdist="$(find "$dist" -maxdepth 1 -name "libo11y-${plain}.tar.gz" | head -n 1)"
	[[ -n "$wheel" ]] || fail "expected wheel libo11y-${plain}-*.whl in $dist"
	[[ -n "$sdist" ]] || fail "expected sdist libo11y-${plain}.tar.gz in $dist"

	"$venv_py" - "$wheel" "$sdist" <<'PY'
import sys, tarfile, zipfile

wheel_path, sdist_path = sys.argv[1], sys.argv[2]

with zipfile.ZipFile(wheel_path) as zf:
    names = zf.namelist()
    if "libo11y/py.typed" not in names:
        raise SystemExit("wheel missing libo11y/py.typed")
    for name in names:
        if name.startswith(("tests/", "conformance/")) or "/conformance/" in name:
            raise SystemExit(f"wheel unexpectedly contains {name}")

with tarfile.open(sdist_path, "r:gz") as tf:
    names = tf.getnames()
    if not any(n.endswith("/src/libo11y/py.typed") for n in names):
        raise SystemExit("sdist missing src/libo11y/py.typed")
    for name in names:
        parts = name.split("/")
        if "conformance" in parts or "tests" in parts:
            raise SystemExit(f"sdist unexpectedly contains {name}")
PY
	echo "python-release-check: wheel and sdist include py.typed and exclude conformance/ and tests/"

	uv pip install --quiet --python "$venv_py" "$wheel"
fi

# Run consumer smoke test against an in-process OTLP/HTTP receiver outside the repository.
(
	cd "$tmp"
	"$venv_py" - "$plain" <<'PY'
import importlib.metadata
import logging
import sys

import libo11y
from libo11y.testing.receivers import OTLPHTTPReceiver

want_version = sys.argv[1]
got_version = importlib.metadata.version("libo11y")
if got_version != want_version:
    raise SystemExit(f"version mismatch: got {got_version!r}, want {want_version!r}")

with OTLPHTTPReceiver() as rx:
    env = {
        "OTEL_EXPORTER_OTLP_ENDPOINT": rx.endpoint,
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_TRACES_EXPORTER": "otlp",
        "OTEL_METRICS_EXPORTER": "otlp",
        "OTEL_LOGS_EXPORTER": "otlp",
    }
    tel = libo11y.init(
        env=env,
        service_name="python-release-smoke",
        version=want_version,
        environment="test",
        console_enabled=False,
        runtime_metrics=False,
    )
    tracer = tel.tracer_provider.get_tracer("smoke")
    meter = tel.meter_provider.get_meter("smoke")
    counter = meter.create_counter("smoke.requests", unit="{request}")
    lg = logging.getLogger("smoke.consumer")
    lg.setLevel(logging.INFO)
    lg.propagate = False
    lg.addHandler(tel.logging_handler())
    try:
        with tracer.start_as_current_span("smoke-op") as sp:
            sc = sp.get_span_context()
            counter.add(1, {"http.request.method": "GET"})
            lg.info("smoke-log", extra={"smoke.ok": True})
    finally:
        lg.removeHandler(tel.logging_handler())

    report = tel.shutdown(timeout=5.0)
    if not report.ok:
        raise SystemExit(f"shutdown failed: {report}")

    rec = rx.received()
    if "smoke-op" not in rec.span_names():
        raise SystemExit(f"missing smoke-op span: {rec.span_names()}")
    if "smoke.requests" not in rec.metric_names():
        raise SystemExit(f"missing smoke.requests metric: {rec.metric_names()}")
    if "smoke-log" not in rec.log_bodies():
        raise SystemExit(f"missing smoke-log record: {rec.log_bodies()}")

    lr = rec.log_requests[0].resource_logs[0].scope_logs[0].log_records[0]
    if lr.trace_id != sc.trace_id.to_bytes(16, "big") or lr.span_id != sc.span_id.to_bytes(8, "big"):
        raise SystemExit("log record trace/span correlation mismatch")
PY
)
echo "python-release-check: OK, libo11y v$plain installs and exports span, metric, and correlated log"
