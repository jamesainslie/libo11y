"""Signal restoration and callback shutdown guarantees."""

from __future__ import annotations

import asyncio
import signal
import threading
from collections.abc import Callable, Generator
from types import FrameType, SimpleNamespace
from typing import Literal

import pytest

import libo11y
from libo11y import signals as signal_helpers

type _Handler = Callable[[int, FrameType | None], None]


@pytest.fixture
def telemetry() -> libo11y.Telemetry:
    return libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
    )


@pytest.fixture
def custom_sigint() -> Generator[_Handler]:
    def custom(signum: int, frame: FrameType | None) -> None:
        pass

    previous = signal.signal(signal.SIGINT, custom)
    try:
        yield custom
    finally:
        signal.signal(signal.SIGINT, previous)


def test_sync_callback_failure_still_shuts_down(
    telemetry: libo11y.Telemetry, monkeypatch: pytest.MonkeyPatch
) -> None:
    stop = threading.Event()
    stop.set()
    calls: list[float | None] = []
    shutdown = telemetry.shutdown

    def record(timeout: float | None = None) -> libo11y.ShutdownReport:
        calls.append(timeout)
        return shutdown(timeout)

    monkeypatch.setattr(telemetry, "shutdown", record)

    def fail() -> None:
        raise RuntimeError("server shutdown failed")

    with pytest.raises(RuntimeError, match="server shutdown failed"):
        libo11y.shutdown_on_signals(telemetry, stop_event=stop, before_shutdown=fail)
    assert len(calls) == 1


async def test_async_callback_failure_restores_handler_and_shuts_down(
    telemetry: libo11y.Telemetry, custom_sigint: _Handler, monkeypatch: pytest.MonkeyPatch
) -> None:
    stop = asyncio.Event()
    stop.set()
    calls: list[float | None] = []
    shutdown = telemetry.ashutdown

    async def record(timeout: float | None = None) -> libo11y.ShutdownReport:
        calls.append(timeout)
        return await shutdown(timeout)

    monkeypatch.setattr(telemetry, "ashutdown", record)

    async def fail() -> None:
        assert signal.getsignal(signal.SIGINT) is custom_sigint
        raise RuntimeError("server shutdown failed")

    with pytest.raises(RuntimeError, match="server shutdown failed"):
        await libo11y.ashutdown_on_signals(telemetry, stop_event=stop, before_shutdown=fail)
    assert len(calls) == 1
    assert signal.getsignal(signal.SIGINT) is custom_sigint


async def test_async_success_restores_handler(
    telemetry: libo11y.Telemetry, custom_sigint: _Handler
) -> None:
    stop = asyncio.Event()
    stop.set()
    assert (await libo11y.ashutdown_on_signals(telemetry, stop_event=stop)).ok
    assert signal.getsignal(signal.SIGINT) is custom_sigint


async def test_async_cancellation_restores_handler(
    telemetry: libo11y.Telemetry, custom_sigint: _Handler
) -> None:
    ready = asyncio.Event()

    class WaitingEvent(asyncio.Event):
        async def wait(self) -> Literal[True]:
            ready.set()
            return await super().wait()

    task = asyncio.create_task(libo11y.ashutdown_on_signals(telemetry, stop_event=WaitingEvent()))
    await asyncio.wait_for(ready.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert signal.getsignal(signal.SIGINT) is custom_sigint


@pytest.mark.parametrize("asynchronous", [False, True])
async def test_callback_time_is_deducted_from_shutdown_budget(
    telemetry: libo11y.Telemetry, monkeypatch: pytest.MonkeyPatch, asynchronous: bool
) -> None:
    now = 10.0
    monkeypatch.setattr(signal_helpers, "time", SimpleNamespace(monotonic=lambda: now))
    calls: list[float | None] = []
    shutdown = telemetry.shutdown

    def before() -> None:
        nonlocal now
        now += 0.25

    def record(timeout: float | None = None) -> libo11y.ShutdownReport:
        calls.append(timeout)
        return shutdown(timeout)

    monkeypatch.setattr(telemetry, "shutdown", record)
    if asynchronous:
        stop = asyncio.Event()
        stop.set()
        await libo11y.ashutdown_on_signals(
            telemetry, stop_event=stop, before_shutdown=before, timeout=0.5
        )
    else:
        stopping = threading.Event()
        stopping.set()
        libo11y.shutdown_on_signals(
            telemetry, stop_event=stopping, before_shutdown=before, timeout=0.5
        )
    assert calls == [0.25]


def test_off_main_thread_requires_a_stop_event(telemetry: libo11y.Telemetry) -> None:
    errors: list[Exception] = []

    def run() -> None:
        try:
            libo11y.shutdown_on_signals(telemetry)
        except Exception as exc:
            errors.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(0.5)
    assert not thread.is_alive()
    assert len(errors) == 1
    assert "main thread" in str(errors[0])
    telemetry.shutdown()


def test_off_main_thread_accepts_an_explicit_event(telemetry: libo11y.Telemetry) -> None:
    stop = threading.Event()
    stop.set()
    reports: list[libo11y.ShutdownReport] = []
    thread = threading.Thread(
        target=lambda: reports.append(libo11y.shutdown_on_signals(telemetry, stop_event=stop))
    )
    thread.start()
    thread.join(2.0)
    assert not thread.is_alive()
    assert reports[0].ok
