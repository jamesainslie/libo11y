"""CPython and OS process runtime metrics with zero third-party dependencies."""

from __future__ import annotations

import gc
import os
import resource
import sys
import threading
from collections.abc import Iterable

from opentelemetry.metrics import CallbackOptions, MeterProvider, Observation


def _read_rss_bytes() -> int:
    # Prefer /proc/self/statm on Linux for exact resident memory in bytes.
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/self/statm", encoding="ascii") as fh:
                parts = fh.read().split()
            if len(parts) >= 2:
                return int(parts[1]) * os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError):
            pass
    usage = resource.getrusage(resource.RUSAGE_SELF)
    # macOS reports ru_maxrss in bytes; Linux reports KiB.
    return int(usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024)


def _read_open_fds() -> int | None:
    for fd_dir in ("/proc/self/fd", "/dev/fd"):
        try:
            return len(os.listdir(fd_dir))
        except OSError:
            continue
    return None


def register_runtime_metrics(meter_provider: MeterProvider) -> None:
    """Register CPython GC and process runtime metrics on meter_provider."""
    meter = meter_provider.get_meter("libo11y.runtime")

    def _gc_collections(_opts: CallbackOptions) -> Iterable[Observation]:
        stats = gc.get_stats()
        return [
            Observation(int(st.get("collections", 0)), {"cpython.gc.generation": gen})
            for gen, st in enumerate(stats)
        ]

    def _gc_collected(_opts: CallbackOptions) -> Iterable[Observation]:
        stats = gc.get_stats()
        return [
            Observation(int(st.get("collected", 0)), {"cpython.gc.generation": gen})
            for gen, st in enumerate(stats)
        ]

    def _gc_uncollectable(_opts: CallbackOptions) -> Iterable[Observation]:
        stats = gc.get_stats()
        return [
            Observation(int(st.get("uncollectable", 0)), {"cpython.gc.generation": gen})
            for gen, st in enumerate(stats)
        ]

    def _cpu_time(_opts: CallbackOptions) -> Iterable[Observation]:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return [
            Observation(float(usage.ru_utime), {"cpu.mode": "user"}),
            Observation(float(usage.ru_stime), {"cpu.mode": "system"}),
        ]

    def _memory_usage(_opts: CallbackOptions) -> Iterable[Observation]:
        return [Observation(_read_rss_bytes())]

    def _thread_count(_opts: CallbackOptions) -> Iterable[Observation]:
        return [Observation(threading.active_count())]

    def _fd_count(_opts: CallbackOptions) -> Iterable[Observation]:
        count = _read_open_fds()
        return [Observation(count)] if count is not None else []

    meter.create_observable_counter(
        name="cpython.gc.collections",
        callbacks=[_gc_collections],
        unit="{collection}",
        description="Number of garbage collections per generation.",
    )
    meter.create_observable_counter(
        name="cpython.gc.collected_objects",
        callbacks=[_gc_collected],
        unit="{object}",
        description="Number of objects collected per generation.",
    )
    meter.create_observable_counter(
        name="cpython.gc.uncollectable_objects",
        callbacks=[_gc_uncollectable],
        unit="{object}",
        description="Number of uncollectable objects found per generation.",
    )
    meter.create_observable_counter(
        name="process.cpu.time",
        callbacks=[_cpu_time],
        unit="s",
        description="Total CPU seconds broken down by different states.",
    )
    meter.create_observable_up_down_counter(
        name="process.memory.usage",
        callbacks=[_memory_usage],
        unit="By",
        description="The amount of physical memory in use.",
    )
    meter.create_observable_up_down_counter(
        name="process.thread.count",
        callbacks=[_thread_count],
        unit="{thread}",
        description="Process threads count.",
    )
    meter.create_observable_up_down_counter(
        name="process.unix.file_descriptor.count",
        callbacks=[_fd_count],
        unit="{file_descriptor}",
        description="Number of file descriptors in use by the process.",
    )
