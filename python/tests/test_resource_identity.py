"""Tier-0 identity and resource composition, checked against the Go reference."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

import libo11y
from libo11y.spec import ATTR_VCS_REF_HEAD_REVISION, METRIC_SCHEMA_VIOLATIONS


def _init(**kwargs: Any) -> libo11y.Telemetry:
    options: dict[str, Any] = {
        "env": libo11y.HERMETIC,
        "service_name": "checkout",
        "environment": "production",
        "console_enabled": False,
        "runtime_metrics": False,
    }
    options.update(kwargs)
    return libo11y.init(**options)


def _violation_rules(reader: InMemoryMetricReader) -> dict[str, int]:
    data = reader.get_metrics_data()
    rules: dict[str, int] = {}
    if data is None:
        return rules
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                if metric.name != METRIC_SCHEMA_VIOLATIONS:
                    continue
                for point in metric.data.data_points:
                    attrs = dict(point.attributes or {})
                    if attrs.get("o11y.signal") != "resource":
                        continue
                    rules[str(attrs["o11y.rule"])] = int(getattr(point, "value", 0))
    return rules


def test_service_version_falls_back_to_unknown_with_a_flag() -> None:
    with _init() as tel:
        assert tel.resource.attributes["service.version"] == "0.0.0-unknown"
        assert "o11y.config.service_version_fallback=true" in tel.effective_config()


def test_explicit_version_sets_no_fallback_flag() -> None:
    with _init(version="1.4.2") as tel:
        assert tel.resource.attributes["service.version"] == "1.4.2"
        assert "service_version_fallback" not in tel.effective_config()


def test_environment_version_sets_no_fallback_flag() -> None:
    env = {"OTEL_RESOURCE_ATTRIBUTES": "service.version=2.0.0", "OTEL_TRACES_EXPORTER": "none"}
    env |= {"OTEL_METRICS_EXPORTER": "none", "OTEL_LOGS_EXPORTER": "none"}
    with _init(env=env) as tel:
        assert tel.resource.attributes["service.version"] == "2.0.0"
        assert "service_version_fallback" not in tel.effective_config()


def test_vcs_revision_is_never_the_service_version(tmp_path: Path) -> None:
    path = tmp_path / "buildinfo.json"
    libo11y.buildinfo.write_build_info(
        path,
        libo11y.buildinfo.BuildInfo(revision="deadbeef1234", build_time="", modified=False),
    )
    with _init(build_info=path) as tel:
        assert tel.resource.attributes[ATTR_VCS_REF_HEAD_REVISION] == "deadbeef1234"
        assert tel.resource.attributes["service.version"] == "0.0.0-unknown"
        assert "o11y.config.service_version_fallback=true" in tel.effective_config()


def test_resource_carries_no_pid_or_host_detail_beyond_the_name() -> None:
    with _init() as tel:
        attrs = tel.resource.attributes
        assert "process.pid" not in attrs
        assert "host.arch" not in attrs
        assert "os.type" not in attrs
        assert "host.id" not in attrs
        assert "process.command_line" not in attrs
        assert attrs["host.name"]
        assert attrs["process.runtime.name"] == "cpython"
        assert attrs["process.runtime.version"]
        assert attrs["telemetry.sdk.language"] == "python"


def test_lenient_identity_counts_the_go_rule_names() -> None:
    reader = InMemoryMetricReader()
    tel = libo11y.init(
        env=libo11y.HERMETIC,
        strict_identity=False,
        metric_reader=reader,
        console_enabled=False,
        runtime_metrics=False,
    )
    try:
        assert _violation_rules(reader) == {
            "identity_service_name": 1,
            "identity_environment": 1,
        }
    finally:
        assert tel.shutdown().ok


def test_lenient_identity_counts_an_invalid_environment() -> None:
    reader = InMemoryMetricReader()
    tel = _init(strict_identity=False, environment="qa", metric_reader=reader)
    try:
        assert _violation_rules(reader) == {"identity_environment_invalid": 1}
        assert tel.resource.attributes["deployment.environment.name"] == "qa"
    finally:
        assert tel.shutdown().ok


def test_invalid_environment_message_matches_go() -> None:
    with pytest.raises(libo11y.InvalidEnvironment) as excinfo:
        _init(environment="qa", extra_environments=("perf",))
    assert str(excinfo.value) == (
        'o11y: deployment environment not in the allowed set: "qa" '
        "(allowed: development, perf, production, staging, test)"
    )


@pytest.mark.parametrize("name", ["unknown_service", "unknown_service:python", "   "])
def test_unusable_service_names_are_refused(name: str) -> None:
    with pytest.raises(libo11y.NoServiceName):
        _init(service_name=name)


def test_a_name_that_only_starts_like_the_sdk_default_is_usable() -> None:
    with _init(service_name="unknown_service_registry") as tel:
        assert tel.resource.attributes["service.name"] == "unknown_service_registry"


def test_blank_identity_options_do_not_shadow_the_environment() -> None:
    env = {
        "OTEL_SERVICE_NAME": "from-env",
        "OTEL_RESOURCE_ATTRIBUTES": (
            "deployment.environment.name=staging,service.version=3.1.0,service.namespace=shop"
        ),
        "OTEL_TRACES_EXPORTER": "none",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_LOGS_EXPORTER": "none",
    }
    with _init(
        env=env, service_name=" ", environment="", version="  ", service_namespace=""
    ) as tel:
        attrs = tel.resource.attributes
        assert attrs["service.name"] == "from-env"
        assert attrs["deployment.environment.name"] == "staging"
        assert attrs["service.version"] == "3.1.0"
        assert attrs["service.namespace"] == "shop"
