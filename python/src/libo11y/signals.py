"""Signal-driven graceful shutdown helpers for synchronous and asyncio programs."""

from __future__ import annotations

import asyncio
import math
import signal
import threading
import time
from collections.abc import Awaitable, Callable, Generator, Iterable
from contextlib import contextmanager
from types import FrameType

from libo11y.telemetry import ShutdownReport, Telemetry

type _SignalHandler = Callable[[int, FrameType | None], object]


def _default_signals() -> tuple[signal.Signals, ...]:
    sigs: list[signal.Signals] = [signal.SIGINT]
    if hasattr(signal, "SIGTERM"):
        sigs.append(signal.SIGTERM)
    return tuple(sigs)


@contextmanager
def _signal_handlers(
    signals: Iterable[signal.Signals] | None,
    trigger: Callable[[], None],
    *,
    has_stop_event: bool,
) -> Generator[None]:
    if threading.current_thread() is not threading.main_thread():
        if not has_stop_event:
            raise RuntimeError("signal shutdown requires the main thread or an explicit stop_event")
        yield
        return

    previous: dict[signal.Signals, _SignalHandler | int] = {}

    def handle(_signum: int, _frame: FrameType | None) -> None:
        trigger()

    try:
        for sig in dict.fromkeys(_default_signals() if signals is None else signals):
            handler = signal.getsignal(sig)
            if handler is None:
                raise RuntimeError(f"the previous handler for {sig.name} cannot be restored")
            signal.signal(sig, handle)
            previous[sig] = handler
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def _budget(telemetry: Telemetry, timeout: float | None) -> float:
    budget = telemetry.shutdown_timeout if timeout is None else timeout
    if not math.isfinite(budget) or budget < 0:
        raise ValueError("timeout must be finite and non-negative")
    return budget


def shutdown_on_signals(
    telemetry: Telemetry,
    *,
    signals: Iterable[signal.Signals] | None = None,
    before_shutdown: Callable[[], object] | None = None,
    timeout: float | None = None,
    stop_event: threading.Event | None = None,
) -> ShutdownReport:
    """Wait for a signal or stop event, restore the handlers, and shut down.

    Time spent in before_shutdown reduces the time available for telemetry.
    If the callback raises, telemetry shuts down before the exception propagates.
    """
    budget = _budget(telemetry, timeout)
    triggered = stop_event if stop_event is not None else threading.Event()
    with _signal_handlers(signals, triggered.set, has_stop_event=stop_event is not None):
        triggered.wait()

    deadline = time.monotonic() + budget
    try:
        if before_shutdown is not None:
            before_shutdown()
    finally:
        report = telemetry.shutdown(timeout=max(0.0, deadline - time.monotonic()))
    return report


async def ashutdown_on_signals(
    telemetry: Telemetry,
    *,
    signals: Iterable[signal.Signals] | None = None,
    before_shutdown: Callable[[], object] | None = None,
    timeout: float | None = None,
    stop_event: asyncio.Event | None = None,
) -> ShutdownReport:
    """Wait asynchronously and restore signal handlers before running the callback."""
    budget = _budget(telemetry, timeout)
    loop = asyncio.get_running_loop()
    triggered = stop_event if stop_event is not None else asyncio.Event()

    def trigger() -> None:
        loop.call_soon_threadsafe(triggered.set)

    try:
        with _signal_handlers(signals, trigger, has_stop_event=stop_event is not None):
            await triggered.wait()
    except asyncio.CancelledError:
        await telemetry.ashutdown(timeout=budget)
        raise

    deadline = time.monotonic() + budget
    try:
        if before_shutdown is not None:
            result = before_shutdown()
            if isinstance(result, Awaitable):
                await result
    finally:
        report = await telemetry.ashutdown(timeout=max(0.0, deadline - time.monotonic()))
    return report
