"""Option validation: every invalid option value is a typed InvalidOption error."""

from __future__ import annotations

import logging
import math
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, get_type_hints

import pytest

import libo11y
from libo11y._internal import logs_bridge


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


def test_invalid_option_is_an_o11y_error_and_is_exported() -> None:
    assert issubclass(libo11y.InvalidOption, libo11y.O11yError)
    assert "InvalidOption" in libo11y.__all__


@pytest.mark.parametrize("timeout", [-1.0, math.nan, math.inf, -math.inf])
def test_shutdown_timeout_must_be_finite_and_not_negative(timeout: float) -> None:
    with pytest.raises(libo11y.InvalidOption, match="shutdown_timeout"):
        _init(shutdown_timeout=timeout)


def test_zero_shutdown_timeout_is_accepted() -> None:
    with _init(shutdown_timeout=0.0) as tel:
        assert tel.effective_config() != ""


@pytest.mark.parametrize("name", ["verbose", "", "  ", "warnings", "10"])
def test_unknown_log_level_name_is_rejected(name: str) -> None:
    with pytest.raises(libo11y.InvalidOption, match="log_level"):
        _init(log_level=name)


@pytest.mark.parametrize(
    ("name", "level"),
    [
        ("debug", logging.DEBUG),
        ("INFO", logging.INFO),
        (" warn ", logging.WARNING),
        ("Warning", logging.WARNING),
        ("error", logging.ERROR),
        ("critical", logging.CRITICAL),
        ("fatal", logging.CRITICAL),
    ],
)
def test_known_log_level_names_resolve(name: str, level: int) -> None:
    with _init(log_level=name) as tel:
        handler = tel.logging_handler()
        assert getattr(handler, "min_level", None) == level


@pytest.mark.parametrize(
    "buckets",
    [
        {"": [1.0, 2.0]},
        {"   ": [1.0, 2.0]},
        {"latency": [2.0, 1.0]},
        {"latency": [1.0, 1.0]},
        {"latency": [1.0, math.nan]},
        {"latency": [1.0, math.inf]},
        {"latency": ["1"]},
        {"latency": [True]},
        {"latency": 5.0},
        {"latency": "12"},
        {7: [1.0]},
    ],
)
def test_invalid_histogram_buckets_are_rejected(buckets: Mapping[Any, Any]) -> None:
    with pytest.raises(libo11y.InvalidOption, match="histogram_buckets"):
        _init(histogram_buckets=buckets)


def test_pii_hash_without_a_key_stays_pii_hash_key() -> None:
    with pytest.raises(libo11y.PIIHashKey):
        _init(pii_mode=libo11y.PIIMode.HASH)


def test_invalid_option_starts_no_worker_thread() -> None:
    before = {t.name for t in threading.enumerate()}
    with pytest.raises(libo11y.InvalidOption):
        libo11y.init(
            env={"OTEL_TRACES_EXPORTER": "console"},
            service_name="checkout",
            environment="production",
            console_enabled=False,
            shutdown_timeout=-1.0,
        )
    assert {t.name for t in threading.enumerate()} == before


def test_unreadable_build_info_is_an_invalid_option_naming_the_path(tmp_path: Path) -> None:
    missing = tmp_path / "missing-build-info.json"
    with pytest.raises(libo11y.InvalidOption) as excinfo:
        _init(build_info=missing)
    assert str(missing) in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, OSError)


def test_unparsable_build_info_is_an_invalid_option_naming_the_path(tmp_path: Path) -> None:
    broken = tmp_path / "build-info.json"
    broken.write_text("{not json", encoding="utf-8")
    with pytest.raises(libo11y.InvalidOption) as excinfo:
        _init(build_info=broken)
    assert str(broken) in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, ValueError)


def test_log_exporter_option_is_typed_as_the_log_record_exporter() -> None:
    hints = get_type_hints(
        libo11y.Options,
        localns={"LogRecordExporter": logs_bridge.LogRecordExporter},
    )
    assert hints["log_exporter"] == logs_bridge.LogRecordExporter | None


def test_histogram_buckets_option_is_a_mapping_of_boundaries() -> None:
    hints = get_type_hints(
        libo11y.Options,
        localns={"LogRecordExporter": logs_bridge.LogRecordExporter},
    )
    assert hints["histogram_buckets"] == Mapping[str, Sequence[float]]
