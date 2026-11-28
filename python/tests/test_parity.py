"""Parity tests mirroring go/parity_test.go."""

from __future__ import annotations

import io
import json
import logging
import queue
import threading

import pytest

import libo11y
from libo11y.spec import EVENT_NAME_KEY, EVENT_TELEMETRY_CONFIGURED
from libo11y.testing import start_recorder


def test_force_emit_bypasses_the_handler_level_gate() -> None:
    """force_emit lifts the libo11y handler's level (ERROR here) for an INFO record.

    The logger is set to DEBUG first because force_emit cannot lift the
    originating logger's own level: the standard library drops a record that
    level rejects before any handler runs.
    """
    buf = io.StringIO()
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="libo11y-test",
        environment="test",
        log_level=logging.ERROR,
        console_writer=buf,
        log_export=False,
        runtime_metrics=False,
    ) as tel:
        lg = logging.getLogger("parity.force_emit")
        lg.setLevel(logging.DEBUG)
        lg.propagate = False
        lg.addHandler(tel.logging_handler())
        try:
            lg.info("filtered")
            with libo11y.force_emit():
                lg.info("audit event")
        finally:
            lg.removeHandler(tel.logging_handler())

    records = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
    assert len(records) == 1
    assert records[0]["msg"] == "audit event"


def test_effective_config_resolved() -> None:
    with start_recorder(
        service_name="libo11y-test",
        console_enabled=True,
        console_writer=io.StringIO(),
        log_level=logging.INFO,
        log_export=False,
    ) as rec:
        cfg = rec.telemetry.effective_config()
        for want in (
            "service.name=libo11y-test",
            "o11y.config.traces=injected",
            "o11y.config.metrics=injected",
            "o11y.config.logs=none",
            "o11y.config.console=json",
            "o11y.config.level=INFO",
            "traceparent",
            "tracestate",
            "baggage",
            "o11y.config.runtime_metrics=false",
        ):
            assert want in cfg, f"{cfg!r} missing {want!r}"


def test_setup_emits_startup_summary() -> None:
    captured: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    tel = libo11y.setup(
        env=libo11y.HERMETIC,
        service_name="summary-test",
        environment="test",
        log_level=logging.ERROR,
        console_enabled=False,
        log_export=False,
        runtime_metrics=False,
        extra_log_handlers=(_Capture(),),
    )
    try:
        assert len(captured) == 1
        assert captured[0].getMessage() == EVENT_TELEMETRY_CONFIGURED
        assert getattr(captured[0], "service.name", None) == "summary-test"
        assert getattr(captured[0], EVENT_NAME_KEY, None) == EVENT_TELEMETRY_CONFIGURED
    finally:
        assert tel.shutdown().ok


def test_setup_without_startup_summary() -> None:
    captured: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    tel = libo11y.setup(
        env=libo11y.HERMETIC,
        service_name="no-summary",
        environment="test",
        console_enabled=False,
        log_export=False,
        runtime_metrics=False,
        startup_summary=False,
        extra_log_handlers=(_Capture(),),
    )
    try:
        assert len(captured) == 0
        assert tel.effective_config() != ""
    finally:
        assert tel.shutdown().ok


def test_setup_reentrant_from_sink_does_not_deadlock() -> None:
    inner_err: queue.Queue[Exception | None] = queue.Queue()

    class _Reentrant(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            del record
            try:
                libo11y.setup(
                    env=libo11y.HERMETIC,
                    service_name="reentrant-inner",
                    environment="test",
                    console_enabled=False,
                    log_export=False,
                    runtime_metrics=False,
                )
                inner_err.put(None)
            except Exception as exc:
                inner_err.put(exc)

    tel = libo11y.setup(
        env=libo11y.HERMETIC,
        service_name="reentrant-outer",
        environment="test",
        console_enabled=False,
        log_export=False,
        runtime_metrics=False,
        extra_log_handlers=(_Reentrant(),),
    )
    try:
        got = inner_err.get(timeout=5.0)
        assert isinstance(got, libo11y.AlreadySetup)
    finally:
        assert tel.shutdown().ok


def test_setup_canary_fails_fast() -> None:
    class _Failing(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            del record
            raise RuntimeError("sink rejects records")

    with pytest.raises(libo11y.CanaryRejected, match="sink rejects records"):
        libo11y.setup(
            env=libo11y.HERMETIC,
            service_name="canary-fail",
            environment="test",
            console_enabled=False,
            log_export=False,
            runtime_metrics=False,
            extra_log_handlers=(_Failing(),),
        )

    # Guard must not remain held after failed setup.
    tel = libo11y.setup(
        env=libo11y.HERMETIC,
        service_name="canary-retry",
        environment="test",
        console_enabled=False,
        log_export=False,
        runtime_metrics=False,
    )
    assert tel.shutdown().ok


def test_shutdown_on_signals_honors_cancel() -> None:
    tel = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="signals-ctx",
        environment="test",
        console_enabled=False,
        log_export=False,
        runtime_metrics=False,
    )
    stop = threading.Event()
    result: queue.Queue[libo11y.ShutdownReport] = queue.Queue()

    def _run() -> None:
        result.put(libo11y.shutdown_on_signals(tel, stop_event=stop))

    t = threading.Thread(target=_run)
    t.start()
    stop.set()
    t.join(timeout=5.0)
    assert not t.is_alive()
    assert result.get(timeout=1.0).ok


def test_build_info_attrs_in_resource() -> None:
    with start_recorder(service_name="build-info-parity") as rec:
        assert rec.telemetry.resource is not None
        assert rec.telemetry.resource.attributes["service.name"] == "build-info-parity"
