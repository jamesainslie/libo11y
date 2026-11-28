"""Runtime metrics contract tests: pure parsers, OS guards, and semconv 1.41.0 metadata."""

from __future__ import annotations

import gc
import importlib.util
import os
import sys
import threading
from pathlib import Path
from typing import Any

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, Metric, NumberDataPoint, Sum

from libo11y._internal import runtime_metrics


def _collect_metrics(reader: InMemoryMetricReader) -> dict[str, Metric]:
    data = reader.get_metrics_data()
    if data is None:
        return {}
    out: dict[str, Metric] = {}
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                out[metric.name] = metric
    return out


def _sum_points(metric: Metric) -> list[NumberDataPoint]:
    assert isinstance(metric.data, Sum)
    return list(metric.data.data_points)


# Pure parser tests against controlled input.


@pytest.mark.parametrize(
    ("text", "page_size", "want"),
    [
        pytest.param("4591 2649 1663 1 0 1513 0\n", 4096, 2649 * 4096, id="standard-4k"),
        pytest.param("100 50 10 1 0 20 0", 16384, 50 * 16384, id="16k-pages"),
        pytest.param("100 0 0 0 0 0 0", 4096, 0, id="zero-rss"),
        pytest.param("onlyone", 4096, None, id="too-few-fields"),
        pytest.param("", 4096, None, id="empty"),
        pytest.param("100 abc 0", 4096, None, id="non-integer"),
        pytest.param("100 -5 0", 4096, None, id="negative-pages"),
        pytest.param("100 50 0", 0, None, id="zero-page-size"),
    ],
)
def test_parse_proc_statm_rss_bytes(text: str, page_size: int, want: int | None) -> None:
    assert runtime_metrics.parse_proc_statm_rss_bytes(text, page_size) == want


@pytest.mark.parametrize(
    ("text", "want"),
    [
        pytest.param(
            "Name:\tpython3\nVmSize:\t   18364 kB\nVmRSS:\t   10596 kB\nThreads:\t4\n",
            10596 * 1024,
            id="standard-status",
        ),
        pytest.param("VmRSS:    0 kB\n", 0, id="zero-rss"),
        pytest.param("Name:\tpython3\nThreads:\t2\n", None, id="missing-vmrss"),
        pytest.param("VmRSS:\t   100 MB\n", None, id="unexpected-unit"),
        pytest.param("VmRSS:\t   -10 kB\n", None, id="negative-value"),
        pytest.param("VmRSS:\t   abc kB\n", None, id="non-integer"),
    ],
)
def test_parse_proc_status_rss_bytes(text: str, want: int | None) -> None:
    assert runtime_metrics.parse_proc_status_rss_bytes(text) == want


@pytest.mark.parametrize(
    ("text", "want"),
    [
        pytest.param(
            "Name:\tpython3\nState:\tR (running)\nThreads:\t7\n",
            7,
            id="multi-threaded",
        ),
        pytest.param("Threads:\t1\n", 1, id="single-thread"),
        pytest.param("Name:\tpython3\n", None, id="missing-threads"),
        pytest.param("Threads:\t0\n", None, id="zero-threads"),
        pytest.param("Threads:\t-2\n", None, id="negative-threads"),
        pytest.param("Threads:\tabc\n", None, id="non-integer"),
    ],
)
def test_parse_proc_status_thread_count(text: str, want: int | None) -> None:
    assert runtime_metrics.parse_proc_status_thread_count(text) == want


# Unix-only import guard.


def test_module_imports_cleanly_without_unix_resource_module(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "resource", None)
    monkeypatch.setattr(sys, "platform", "win32")

    module_path = Path(runtime_metrics.__file__)
    spec = importlib.util.spec_from_file_location("_test_runtime_metrics_win32", module_path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    reader = InMemoryMetricReader()
    mp = MeterProvider(metric_readers=[reader])
    try:
        mod.register_runtime_metrics(mp)
        metrics = _collect_metrics(reader)
    finally:
        mp.shutdown()

    assert "cpython.gc.collections" in metrics
    assert "process.cpu.time" in metrics
    assert "process.memory.usage" not in metrics
    assert "process.thread.count" not in metrics
    assert "process.unix.file_descriptor.count" not in metrics


# Correct OS sources and fail-closed omission on unsupported platforms.


def test_memory_usage_never_falls_back_to_ru_maxrss_when_proc_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_read(_path: str) -> str | None:
        return None

    monkeypatch.setattr(runtime_metrics, "_read_text_file", fail_read)

    reader = InMemoryMetricReader()
    mp = MeterProvider(metric_readers=[reader])
    try:
        runtime_metrics.register_runtime_metrics(mp)
        metrics = _collect_metrics(reader)
    finally:
        mp.shutdown()

    assert "process.memory.usage" not in metrics
    assert "process.thread.count" not in metrics


def test_memory_usage_falls_back_from_statm_to_status_vmrss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def read_only_status(path: str) -> str | None:
        if path == "/proc/self/status":
            return "VmRSS:\t    2048 kB\nThreads:\t3\n"
        return None

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(runtime_metrics, "_read_text_file", read_only_status)

    reader = InMemoryMetricReader()
    mp = MeterProvider(metric_readers=[reader])
    try:
        runtime_metrics.register_runtime_metrics(mp)
        metrics = _collect_metrics(reader)
    finally:
        mp.shutdown()

    rss_pts = _sum_points(metrics["process.memory.usage"])
    assert len(rss_pts) == 1
    assert rss_pts[0].value == 2048 * 1024

    thread_pts = _sum_points(metrics["process.thread.count"])
    assert len(thread_pts) == 1
    assert thread_pts[0].value == 3


def test_thread_count_reports_os_threads_not_python_threading_active_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_read(path: str) -> str | None:
        if path == "/proc/self/status":
            return "Name:\tpython\nThreads:\t9\n"
        return None

    def _fake_active_count() -> int:
        return 1

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(runtime_metrics, "_read_text_file", fake_read)
    monkeypatch.setattr(threading, "active_count", _fake_active_count)

    reader = InMemoryMetricReader()
    mp = MeterProvider(metric_readers=[reader])
    try:
        runtime_metrics.register_runtime_metrics(mp)
        metrics = _collect_metrics(reader)
    finally:
        mp.shutdown()

    pts = _sum_points(metrics["process.thread.count"])
    assert len(pts) == 1
    assert pts[0].value == 9


@pytest.mark.parametrize(
    ("platform", "expect_fds"),
    [
        pytest.param("darwin", True, id="macos"),
        pytest.param("win32", False, id="windows"),
    ],
)
def test_non_linux_platforms_omit_unsupported_metrics_instead_of_wrong_values(
    monkeypatch: pytest.MonkeyPatch,
    platform: str,
    expect_fds: bool,
) -> None:
    def _fake_listdir(_path: object) -> list[str]:
        return ["0", "1", "2", "3"]

    monkeypatch.setattr(sys, "platform", platform)
    if platform == "win32":
        monkeypatch.setitem(sys.modules, "resource", None)
    monkeypatch.setattr(os, "listdir", _fake_listdir)

    reader = InMemoryMetricReader()
    mp = MeterProvider(metric_readers=[reader])
    try:
        runtime_metrics.register_runtime_metrics(mp)
        metrics = _collect_metrics(reader)
    finally:
        mp.shutdown()

    assert "cpython.gc.collections" in metrics
    assert "cpython.gc.collected_objects" in metrics
    assert "cpython.gc.uncollectable_objects" in metrics
    assert "process.cpu.time" in metrics
    assert "process.memory.usage" not in metrics
    assert "process.thread.count" not in metrics
    if expect_fds:
        fd_pts = _sum_points(metrics["process.unix.file_descriptor.count"])
        assert len(fd_pts) == 1
        assert fd_pts[0].value == 3
    else:
        assert "process.unix.file_descriptor.count" not in metrics


def test_open_fd_count_excludes_directory_listing_descriptor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _fake_listdir(_path: object) -> list[str]:
        return ["0", "1", "2", "3", "4"]

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(os, "listdir", _fake_listdir)

    reader = InMemoryMetricReader()
    mp = MeterProvider(metric_readers=[reader])
    try:
        runtime_metrics.register_runtime_metrics(mp)
        metrics = _collect_metrics(reader)
    finally:
        mp.shutdown()

    pts = _sum_points(metrics["process.unix.file_descriptor.count"])
    assert len(pts) == 1
    assert pts[0].value == 4


# Semconv 1.41.0 names, units, instrument kinds, and live Linux readings.


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux /proc metrics test")
def test_semconv_1_41_0_names_units_kinds_and_live_linux_values() -> None:
    reader = InMemoryMetricReader()
    mp = MeterProvider(metric_readers=[reader])
    try:
        runtime_metrics.register_runtime_metrics(mp)
        metrics = _collect_metrics(reader)
    finally:
        mp.shutdown()

    expected: dict[str, tuple[str, bool]] = {
        "cpython.gc.collections": ("{collection}", True),
        "cpython.gc.collected_objects": ("{object}", True),
        "cpython.gc.uncollectable_objects": ("{object}", True),
        "process.cpu.time": ("s", True),
        "process.memory.usage": ("By", False),
        "process.thread.count": ("{thread}", False),
        "process.unix.file_descriptor.count": ("{file_descriptor}", False),
    }

    assert set(metrics.keys()) == set(expected.keys())
    for name, (unit, is_monotonic) in expected.items():
        metric = metrics[name]
        assert metric.unit == unit
        assert isinstance(metric.data, Sum)
        assert metric.data.is_monotonic is is_monotonic

    # cpython.gc.* carry cpython.gc.generation = 0, 1, 2.
    expected_gens = set(range(len(gc.get_stats())))
    for gc_name in (
        "cpython.gc.collections",
        "cpython.gc.collected_objects",
        "cpython.gc.uncollectable_objects",
    ):
        pts = _sum_points(metrics[gc_name])
        gens = {
            gen
            for p in pts
            if isinstance((gen := dict(p.attributes or {}).get("cpython.gc.generation")), int)
        }
        assert gens == expected_gens
        assert all(int(p.value) >= 0 for p in pts)

    # process.cpu.time carries cpu.mode = user / system.
    cpu_pts: dict[Any, float] = {
        dict(p.attributes or {}).get("cpu.mode"): float(p.value)
        for p in _sum_points(metrics["process.cpu.time"])
    }
    assert set(cpu_pts.keys()) == {"user", "system"}
    assert cpu_pts["user"] >= 0.0
    assert cpu_pts["system"] >= 0.0

    # Live Linux values for memory, threads, and fds have no attributes and positive readings.
    rss_pt = _sum_points(metrics["process.memory.usage"])[0]
    assert not rss_pt.attributes
    assert int(rss_pt.value) > 0

    thread_pt = _sum_points(metrics["process.thread.count"])[0]
    assert not thread_pt.attributes
    assert int(thread_pt.value) >= 1

    fd_pt = _sum_points(metrics["process.unix.file_descriptor.count"])[0]
    assert not fd_pt.attributes
    assert int(fd_pt.value) >= 1
