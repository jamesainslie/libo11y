"""Signal-driven graceful shutdown helpers for synchronous and asyncio programs."""

from __future__ import annotations

import asyncio
import contextlib
import signal
import threading
import time
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from libo11y.telemetry import ShutdownReport, Telemetry


def _default_signals() -> tuple[signal.Signals, ...]:
    sigs: list[signal.Signals] = [signal.SIGINT]
    if hasattr(signal, "SIGTERM"):
        sigs.append(signal.SIGTERM)
    return tuple(sigs)


def shutdown_on_signals(
    telemetry: Telemetry,
    *,
    signals: Iterable[signal.Signals] | None = None,
    before_shutdown: Callable[[], Any] | None = None,
    timeout: float | None = None,
    stop_event: threading.Event | None = None,
) -> ShutdownReport:
    """Wait for SIGINT/SIGTERM (or stop_event), restore defaults, and shut down.

    Both before_shutdown and telemetry.shutdown share one deadline when timeout
    is given (or telemetry's default shutdown_timeout).
    """
    sigs = tuple(signals) if signals is not None else _default_signals()
    triggered = stop_event if stop_event is not None else threading.Event()
    previous: dict[signal.Signals, Any] = {}

    def _handle(_signum: int, _frame: Any) -> None:
        triggered.set()

    for sig in sigs:
        try:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, _handle)
        except (ValueError, OSError):
            pass

    try:
        triggered.wait()
    finally:
        for sig, prev in previous.items():
            with contextlib.suppress(ValueError, OSError):
                signal.signal(sig, signal.SIG_DFL if prev is _handle else prev)

    total_budget = telemetry._shutdown_timeout if timeout is None else max(timeout, 0.0)  # pyright: ignore[reportPrivateUsage]
    start = time.monotonic()
    if before_shutdown is not None:
        before_shutdown()
    remaining = max(total_budget - (time.monotonic() - start), 0.0)
    return telemetry.shutdown(timeout=remaining)


async def ashutdown_on_signals(
    telemetry: Telemetry,
    *,
    signals: Iterable[signal.Signals] | None = None,
    before_shutdown: Callable[[], Any | Awaitable[Any]] | None = None,
    timeout: float | None = None,
    stop_event: asyncio.Event | None = None,
) -> ShutdownReport:
    """Asyncio counterpart to shutdown_on_signals() using loop signal handlers."""
    loop = asyncio.get_running_loop()
    sigs = tuple(signals) if signals is not None else _default_signals()
    triggered = stop_event if stop_event is not None else asyncio.Event()
    installed: list[signal.Signals] = []

    def _on_sig() -> None:
        triggered.set()

    for sig in sigs:
        try:
            loop.add_signal_handler(sig, _on_sig)
            installed.append(sig)
        except (NotImplementedError, ValueError, RuntimeError):
            pass

    try:
        await triggered.wait()
    finally:
        for sig in installed:
            loop.remove_signal_handler(sig)

    total_budget = telemetry._shutdown_timeout if timeout is None else max(timeout, 0.0)  # pyright: ignore[reportPrivateUsage]
    start = time.monotonic()
    if before_shutdown is not None:
        res = before_shutdown()
        if asyncio.iscoroutine(res) or isinstance(res, Awaitable):
            await res
    remaining = max(total_budget - (time.monotonic() - start), 0.0)
    return await telemetry.ashutdown(timeout=remaining)
