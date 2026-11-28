"""CPython and OS process runtime metrics with zero third-party dependencies."""

from __future__ import annotations

import gc
import os
import sys
from collections.abc import Iterable

from opentelemetry.metrics import CallbackOptions, MeterProvider, Observation


def parse_proc_statm_rss_bytes(text: str, page_size: int) -> int | None:
    """Parse current resident memory in bytes from Linux /proc/self/statm text."""
    if page_size <= 0:
        return None
    parts = text.split()
    if len(parts) < 2:
        return None
    try:
        resident_pages = int(parts[1])
    except ValueError:
        return None
    if resident_pages < 0:
        return None
    return resident_pages * page_size


def _parse_proc_status_field(text: str, prefix: str, *, scale_kib: bool) -> int | None:
    for line in text.splitlines():
        if not line.startswith(prefix):
            continue
        parts = line[len(prefix) :].split()
        if not parts:
            return None
        try:
            value = int(parts[0])
        except ValueError:
            return None
        if scale_kib:
            if value < 0 or len(parts) < 2 or parts[1] != "kB":
                return None
            return value * 1024
        if value <= 0:
            return None
        return value
    return None


def parse_proc_status_rss_bytes(text: str) -> int | None:
    """Parse VmRSS in bytes from Linux /proc/self/status text."""
    return _parse_proc_status_field(text, "VmRSS:", scale_kib=True)


def parse_proc_status_thread_count(text: str) -> int | None:
    """Parse the OS thread count (Threads:) from Linux /proc/self/status text."""
    return _parse_proc_status_field(text, "Threads:", scale_kib=False)


def _read_text_file(path: str) -> str | None:
    try:
        with open(path, encoding="ascii") as fh:
            return fh.read()
    except OSError:
        return None


def _read_cpu_times() -> tuple[float, float] | None:
    """Return (user_seconds, system_seconds) for the current process."""
    if sys.platform != "win32":
        try:
            import resource
        except ImportError:
            pass
        else:
            usage = resource.getrusage(resource.RUSAGE_SELF)
            return (float(usage.ru_utime), float(usage.ru_stime))
    try:
        times = os.times()
    except OSError:
        return None
    return (float(times.user), float(times.system))


def _read_rss_bytes() -> int | None:
    """Return current resident set size in bytes on Linux, or None if unavailable.

    Never falls back to resource.getrusage().ru_maxrss because ru_maxrss
    reports peak RSS rather than current physical memory usage.
    """
    if not sys.platform.startswith("linux"):
        return None
    statm = _read_text_file("/proc/self/statm")
    if statm is not None:
        try:
            page_size = os.sysconf("SC_PAGE_SIZE")
        except (AttributeError, OSError, ValueError):
            page_size = 0
        rss = parse_proc_statm_rss_bytes(statm, page_size)
        if rss is not None:
            return rss
    status = _read_text_file("/proc/self/status")
    if status is not None:
        return parse_proc_status_rss_bytes(status)
    return None


def _read_thread_count() -> int | None:
    """Return the OS process thread count on Linux, or None if unavailable.

    Never falls back to threading.active_count() because Python's threading
    module misses native threads such as gRPC worker threads.
    """
    if not sys.platform.startswith("linux"):
        return None
    status = _read_text_file("/proc/self/status")
    if status is None:
        return None
    return parse_proc_status_thread_count(status)


def _read_open_fds() -> int | None:
    """Return the number of open UNIX file descriptors, excluding the listing FD."""
    if sys.platform == "win32":
        return None
    fd_dirs = ("/proc/self/fd", "/dev/fd") if sys.platform.startswith("linux") else ("/dev/fd",)
    for fd_dir in fd_dirs:
        try:
            entries = os.listdir(fd_dir)
        except OSError:
            continue
        return max(0, len(entries) - 1)
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
        times = _read_cpu_times()
        if times is None:
            return []
        user_s, sys_s = times
        return [
            Observation(user_s, {"cpu.mode": "user"}),
            Observation(sys_s, {"cpu.mode": "system"}),
        ]

    def _memory_usage(_opts: CallbackOptions) -> Iterable[Observation]:
        rss = _read_rss_bytes()
        return [Observation(rss)] if rss is not None else []

    def _thread_count(_opts: CallbackOptions) -> Iterable[Observation]:
        count = _read_thread_count()
        return [Observation(count)] if count is not None else []

    def _fd_count(_opts: CallbackOptions) -> Iterable[Observation]:
        count = _read_open_fds()
        return [Observation(count)] if count is not None else []

    meter.create_observable_counter(
        name="cpython.gc.collections",
        callbacks=[_gc_collections],
        unit="{collection}",
        description="The number of times a generation was collected since interpreter start.",
    )
    meter.create_observable_counter(
        name="cpython.gc.collected_objects",
        callbacks=[_gc_collected],
        unit="{object}",
        description=(
            "The total number of objects collected inside a generation since interpreter start."
        ),
    )
    meter.create_observable_counter(
        name="cpython.gc.uncollectable_objects",
        callbacks=[_gc_uncollectable],
        unit="{object}",
        description=(
            "The total number of objects which were found to be uncollectable inside a "
            "generation since interpreter start."
        ),
    )
    meter.create_observable_counter(
        name="process.cpu.time",
        callbacks=[_cpu_time],
        unit="s",
        description="Total CPU seconds broken down by different CPU modes.",
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
        description="Number of UNIX file descriptors in use by the process.",
    )
