"""The stdlib log pipeline: every leg sees the same classified, correlated record.

The legs are the console, the OTLP bridge and Options.extra_log_handlers.
These mirror go/internal/fanout/fanout.go and SPEC sections 4 and 5.
"""

from __future__ import annotations

import io
import json
import logging
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from opentelemetry._logs import LogRecord
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter

import libo11y
from libo11y._internal.logging_handler import (
    _STANDARD_LOG_ATTRS,  # pyright: ignore[reportPrivateUsage]
    O11yLoggingHandler,
)
from libo11y._internal.policy import RULE_SECRET, SensitivityPolicy
from libo11y.redact import Secret
from libo11y.spec import ATTR_RULE, METRIC_SCHEMA_VIOLATIONS
from libo11y.testing import Recorder, start_recorder

_SECRET_KEY = "http.request.header.authorization"
_PII_KEY = "device.id"
_HASH_KEY = b"k" * 32


class _ListHandler(logging.Handler):
    """Collects the records an extra log handler receives."""

    def __init__(self, level: int = logging.NOTSET) -> None:
        super().__init__(level=level)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


class _FailingHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        del record
        raise RuntimeError("sink down")


class _CheckoutError(Exception):
    pass


def _user_attrs(record: logging.LogRecord) -> dict[str, Any]:
    return {k: v for k, v in record.__dict__.items() if k not in _STANDARD_LOG_ATTRS}


@dataclass
class _Pipeline:
    rec: Recorder
    console: io.StringIO
    extra: _ListHandler
    errors: list[Exception] = field(default_factory=lambda: [])

    def logger(self) -> logging.Logger:
        return self.rec.logger("pipeline.test")

    def console_json(self) -> list[dict[str, Any]]:
        return [json.loads(ln) for ln in self.console.getvalue().splitlines() if ln.strip()]

    def otlp_attrs(self) -> list[dict[str, Any]]:
        return [dict(lr.log_record.attributes or {}) for lr in self.rec.otel_logs()]

    def extra_attrs(self) -> list[dict[str, Any]]:
        return [_user_attrs(r) for r in self.extra.records]

    def violations(self, rule: str) -> int:
        points = self.rec.metric_points(METRIC_SCHEMA_VIOLATIONS)
        return sum(int(p["value"]) for p in points if p["attributes"].get(ATTR_RULE) == rule)


@pytest.fixture
def make_pipeline() -> Iterator[Callable[..., _Pipeline]]:
    recorders: list[Recorder] = []

    def make(*, extra: _ListHandler | None = None, **kwargs: Any) -> _Pipeline:
        console = io.StringIO()
        handler = extra if extra is not None else _ListHandler()
        errors: list[Exception] = []
        extra_handlers: tuple[logging.Handler, ...] = kwargs.pop("extra_log_handlers", (handler,))
        kwargs.setdefault("console_enabled", True)
        rec = start_recorder(
            console_writer=console,
            extra_log_handlers=extra_handlers,
            error_handler=errors.append,
            **kwargs,
        )
        recorders.append(rec)
        return _Pipeline(rec=rec, console=console, extra=handler, errors=errors)

    yield make
    for rec in recorders:
        rec.shutdown()


# Finding 1: extra log handlers receive the classified record.


def test_extra_handler_does_not_receive_secret_attribute(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    p.logger().info("login", extra={_SECRET_KEY: "Bearer abc", "app.user_tier": "gold"})

    assert p.extra_attrs() == [{"app.user_tier": "gold"}]


def test_extra_handler_does_not_receive_pii_attribute(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    p.logger().info("seen", extra={_PII_KEY: "dev-123"})

    assert p.extra_attrs() == [{}]


def test_extra_handler_receives_hashed_pii_under_hash_mode(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline(pii_mode=libo11y.PIIMode.HASH, pii_hash_key=_HASH_KEY)

    p.logger().info("seen", extra={_PII_KEY: "dev-123"})

    token = p.otlp_attrs()[0][_PII_KEY]
    assert token != "dev-123"
    assert p.extra_attrs() == [{_PII_KEY: token}]


def test_extra_handler_receives_replacer_renames_and_drops(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    def replacer(groups: tuple[str, ...], key: str, val: Any) -> tuple[str, Any] | None:
        del groups
        if key == "app.drop_me":
            return None
        if key == "app.old":
            return ("app.new", val)
        return (key, val)

    p = make_pipeline(attr_replacer=replacer)

    p.logger().info("x", extra={"app.drop_me": 1, "app.old": 2})

    assert p.extra_attrs() == [{"app.new": 2}]


def test_extra_handler_receives_capture_time_redaction(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    p.logger().info("x", extra={"app.token": Secret("s3cr3t")})

    assert p.extra_attrs() == [{"app.token": "REDACTED"}]


def test_extra_handler_record_keeps_message_level_and_logger_name(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    p.logger().warning("order %s failed", "o-1")

    (got,) = p.extra.records
    assert (got.getMessage(), got.levelno, got.name) == ("order o-1 failed", 30, "pipeline.test")


def test_extra_handler_does_not_mutate_the_application_record(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()
    logger = p.logger()
    record = logger.makeRecord(
        logger.name, logging.INFO, __file__, 1, "x", (), None, extra={_SECRET_KEY: "Bearer abc"}
    )
    before = dict(record.__dict__)

    p.rec.telemetry.logging_handler().handle(record)

    assert record.__dict__ == before
    assert p.extra.records[0] is not record


def test_failing_extra_handler_does_not_stop_other_legs(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    survivor = _ListHandler()
    p = make_pipeline(extra=survivor, extra_log_handlers=(_FailingHandler(), survivor))

    p.logger().info("still delivered")

    assert [r.getMessage() for r in survivor.records] == ["still delivered"]
    assert [r["msg"] for r in p.console_json()] == ["still delivered"]
    assert len(p.rec.otel_logs()) == 1
    assert [str(e) for e in p.errors] == ["sink down"]


def test_extra_handler_filter_is_honoured(make_pipeline: Callable[..., _Pipeline]) -> None:
    handler = _ListHandler()
    handler.addFilter(lambda r: r.getMessage() != "hidden")
    p = make_pipeline(extra=handler)

    p.logger().info("hidden")
    p.logger().info("shown")

    assert [r.getMessage() for r in handler.records] == ["shown"]


def test_extra_handler_level_is_honoured(make_pipeline: Callable[..., _Pipeline]) -> None:
    handler = _ListHandler(level=logging.WARNING)
    p = make_pipeline(extra=handler)

    p.logger().info("quiet")
    p.logger().warning("loud")

    assert [r.getMessage() for r in handler.records] == ["loud"]


def test_extra_handler_level_is_bypassed_under_force_emit(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    handler = _ListHandler(level=logging.WARNING)
    p = make_pipeline(extra=handler)

    with libo11y.force_emit():
        p.logger().info("forced")

    assert [r.getMessage() for r in handler.records] == ["forced"]


def test_classification_counts_a_violation_once_across_all_legs(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    second = _ListHandler()
    first = _ListHandler()
    p = make_pipeline(extra=first, extra_log_handlers=(first, second))

    p.logger().info("login", extra={_SECRET_KEY: "Bearer abc"})

    assert len(p.rec.otel_logs()) == 1
    assert p.violations(RULE_SECRET) == 1


def test_raising_replacer_does_not_propagate_into_the_application(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    def replacer(groups: tuple[str, ...], key: str, val: Any) -> tuple[str, Any] | None:
        raise ValueError("bad replacer")

    p = make_pipeline(attr_replacer=replacer)

    p.logger().info("x", extra={"app.k": 1})

    assert [str(e) for e in p.errors] == ["bad replacer"]


# Finding 2: trace_id and span_id are reserved.


def _span_ids(p: _Pipeline) -> Iterator[tuple[str, str]]:
    tracer = p.rec.telemetry.tracer_provider.get_tracer("pipeline.test")
    with tracer.start_as_current_span("op") as span:
        sc = span.get_span_context()
        yield f"{sc.trace_id:032x}", f"{sc.span_id:016x}"


def _log_with_fake_ids(p: _Pipeline, *, in_span: bool) -> tuple[str, str] | None:
    fake = {"trace_id": "fake-trace", "span_id": "fake-span", "app.k": 1}
    if not in_span:
        p.logger().info("x", extra=fake)
        return None
    for ids in _span_ids(p):
        p.logger().info("x", extra=fake)
        return ids
    return None


@pytest.mark.parametrize("in_span", [True, False], ids=["in_span", "no_span"])
def test_json_console_carries_only_the_real_correlation_ids(
    make_pipeline: Callable[..., _Pipeline], in_span: bool
) -> None:
    p = make_pipeline()

    ids = _log_with_fake_ids(p, in_span=in_span)

    line = p.console.getvalue()
    assert line.count('"trace_id"') == (1 if in_span else 0)
    assert line.count('"span_id"') == (1 if in_span else 0)
    rec = p.console_json()[0]
    assert (rec.get("trace_id"), rec.get("span_id")) == (ids or (None, None))


@pytest.mark.parametrize("in_span", [True, False], ids=["in_span", "no_span"])
def test_text_console_carries_only_the_real_correlation_ids(
    make_pipeline: Callable[..., _Pipeline], in_span: bool
) -> None:
    p = make_pipeline(console_format=libo11y.ConsoleFormat.TEXT)

    ids = _log_with_fake_ids(p, in_span=in_span)

    line = p.console.getvalue()
    assert "fake" not in line
    if ids is None:
        assert "trace_id=" not in line
        assert "span_id=" not in line
    else:
        assert line.count("trace_id=") == 1
        assert line.count("span_id=") == 1
        assert f"trace_id={ids[0]}" in line
        assert f"span_id={ids[1]}" in line


@pytest.mark.parametrize("in_span", [True, False], ids=["in_span", "no_span"])
def test_otlp_attributes_drop_caller_set_correlation_ids(
    make_pipeline: Callable[..., _Pipeline], in_span: bool
) -> None:
    p = make_pipeline()

    _log_with_fake_ids(p, in_span=in_span)

    assert p.otlp_attrs() == [{"app.k": 1}]


@pytest.mark.parametrize("in_span", [True, False], ids=["in_span", "no_span"])
def test_extra_handler_receives_only_the_real_correlation_ids(
    make_pipeline: Callable[..., _Pipeline], in_span: bool
) -> None:
    p = make_pipeline()

    ids = _log_with_fake_ids(p, in_span=in_span)

    expected: dict[str, Any] = {"app.k": 1}
    if ids is not None:
        expected = {"trace_id": ids[0], "span_id": ids[1], "app.k": 1}
    assert p.extra_attrs() == [expected]


@pytest.mark.parametrize("fmt", list(libo11y.ConsoleFormat), ids=lambda f: str(f))
def test_console_does_not_duplicate_time_or_level(
    make_pipeline: Callable[..., _Pipeline], fmt: libo11y.ConsoleFormat
) -> None:
    p = make_pipeline(console_format=fmt)

    p.logger().info("x", extra={"time": "fake-time", "level": "fake-level"})

    line = p.console.getvalue()
    assert "fake" not in line


# Finding 3: exc_info maps to the semconv exception attributes.


def _raise_checkout() -> None:
    raise _CheckoutError("card declined")


def test_logger_exception_exports_exception_attributes(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    try:
        _raise_checkout()
    except _CheckoutError:
        p.logger().exception("checkout failed")

    attrs = p.otlp_attrs()[0]
    assert attrs["exception.type"] == f"{__name__}._CheckoutError"
    assert attrs["exception.message"] == "card declined"
    assert "_raise_checkout" in attrs["exception.stacktrace"]


def test_builtin_exception_type_is_unqualified(make_pipeline: Callable[..., _Pipeline]) -> None:
    p = make_pipeline()

    try:
        int("x")
    except ValueError:
        p.logger().exception("parse failed")

    assert p.otlp_attrs()[0]["exception.type"] == "ValueError"


def test_exception_tuple_exports_exception_attributes(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()
    try:
        _raise_checkout()
    except _CheckoutError as exc:
        caught = exc
    else:
        pytest.fail("expected _CheckoutError")

    p.logger().error("checkout failed", exc_info=(type(caught), caught, caught.__traceback__))

    attrs = p.otlp_attrs()[0]
    assert attrs["exception.type"] == f"{__name__}._CheckoutError"
    assert attrs["exception.message"] == "card declined"


@pytest.mark.parametrize("exc_info", [False, None], ids=["false", "none"])
def test_no_exc_info_adds_no_exception_attributes(
    make_pipeline: Callable[..., _Pipeline], exc_info: bool | None
) -> None:
    p = make_pipeline()

    try:
        _raise_checkout()
    except _CheckoutError:
        p.logger().error("checkout failed", exc_info=exc_info)

    assert p.otlp_attrs() == [{}]


def test_caller_supplied_exception_keys_win(make_pipeline: Callable[..., _Pipeline]) -> None:
    p = make_pipeline()

    try:
        _raise_checkout()
    except _CheckoutError:
        p.logger().exception("checkout failed", extra={"exception.type": "checkout.Declined"})

    attrs = p.otlp_attrs()[0]
    assert attrs["exception.type"] == "checkout.Declined"
    assert attrs["exception.message"] == "card declined"


def test_exception_attributes_pass_through_the_replacer(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    def replacer(groups: tuple[str, ...], key: str, val: Any) -> tuple[str, Any] | None:
        del groups
        return None if key == "exception.stacktrace" else (key, val)

    p = make_pipeline(attr_replacer=replacer)

    try:
        _raise_checkout()
    except _CheckoutError:
        p.logger().exception("checkout failed")

    assert "exception.stacktrace" not in p.otlp_attrs()[0]
    assert "exception.stacktrace" not in p.console_json()[0]
    assert set(p.extra_attrs()[0]) == {"exception.type", "exception.message", "error.type"}


# Finding 4: ObservedTimestamp is the observation time.


def test_observed_timestamp_is_the_capture_time(make_pipeline: Callable[..., _Pipeline]) -> None:
    p = make_pipeline()
    logger = p.logger()
    record = logger.makeRecord(logger.name, logging.INFO, __file__, 1, "late", (), None)
    record.created = time.time() - 60.0
    observed_after = time.time_ns()

    p.rec.telemetry.logging_handler().handle(record)

    (exported,) = p.rec.otel_logs()
    assert exported.log_record.timestamp == int(record.created * 1_000_000_000)
    assert exported.log_record.observed_timestamp is not None
    assert exported.log_record.observed_timestamp >= observed_after


# Finding 7: a record is counted once whichever way it enters the provider.


def test_stdlib_record_is_counted_once_with_the_policy_processor(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline(console_enabled=False, extra_log_handlers=())

    p.logger().info("login", extra={_SECRET_KEY: "Bearer abc"})

    assert p.otlp_attrs() == [{}]
    assert p.violations(RULE_SECRET) == 1


def test_direct_otel_record_is_classified_and_counted_once(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline(console_enabled=False, extra_log_handlers=())
    otel_logger = p.rec.telemetry.logger_provider.get_logger("direct")

    otel_logger.emit(LogRecord(body="login", attributes={_SECRET_KEY: "Bearer abc", "app.k": 1}))

    assert p.otlp_attrs() == [{"app.k": 1}]
    assert p.violations(RULE_SECRET) == 1


def test_replacer_cannot_rename_an_attribute_to_a_correlation_id(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    def replacer(groups: tuple[str, ...], key: str, val: Any) -> tuple[str, Any] | None:
        del groups
        return ("trace_id", val) if key == "app.k" else (key, val)

    p = make_pipeline(attr_replacer=replacer)

    p.logger().info("x", extra={"app.k": "fake-trace"})

    assert p.otlp_attrs() == [{}]
    assert p.extra_attrs() == [{}]
    assert "fake" not in p.console.getvalue()


# Item 9: error.type on ERROR and above when the record carries an exception.


def test_error_record_with_exception_carries_error_type(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    try:
        _raise_checkout()
    except _CheckoutError:
        p.logger().exception("checkout failed")

    assert p.otlp_attrs()[0]["error.type"] == f"{__name__}._CheckoutError"


def test_warning_record_with_exception_has_no_error_type(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    try:
        _raise_checkout()
    except _CheckoutError:
        p.logger().warning("retrying checkout", exc_info=True)

    attrs = p.otlp_attrs()[0]
    assert "error.type" not in attrs
    assert attrs["exception.type"] == f"{__name__}._CheckoutError"


def test_caller_supplied_error_type_wins(make_pipeline: Callable[..., _Pipeline]) -> None:
    p = make_pipeline()

    try:
        _raise_checkout()
    except _CheckoutError:
        p.logger().exception("checkout failed", extra={"error.type": "card_declined"})

    assert p.otlp_attrs()[0]["error.type"] == "card_declined"


# Item 6: force_emit bypasses the handler's gate on the public setup() path.


@dataclass
class _Global:
    tel: libo11y.Telemetry
    console: io.StringIO
    exporter: InMemoryLogRecordExporter
    extra: _ListHandler
    errors: list[Exception]

    def messages(self, leg: str) -> list[str]:
        if leg == "console":
            return [
                json.loads(ln)["msg"] for ln in self.console.getvalue().splitlines() if ln.strip()
            ]
        if leg == "otlp":
            self.tel.force_flush()
            return [str(lr.log_record.body) for lr in self.exporter.get_finished_logs()]
        return [r.getMessage() for r in self.extra.records]


@pytest.fixture
def global_setup() -> Iterator[_Global]:
    console = io.StringIO()
    exporter = InMemoryLogRecordExporter()
    extra = _ListHandler()
    errors: list[Exception] = []
    tel = libo11y.setup(
        env=libo11y.HERMETIC,
        service_name="pipeline-test",
        environment="test",
        log_level=logging.INFO,
        console_writer=console,
        log_exporter=exporter,
        extra_log_handlers=(extra,),
        error_handler=errors.append,
        runtime_metrics=False,
        startup_summary=False,
    )
    try:
        yield _Global(tel=tel, console=console, exporter=exporter, extra=extra, errors=errors)
    finally:
        tel.shutdown()


_LEGS = ["console", "otlp", "extra"]


@pytest.fixture
def debug_logger() -> Iterator[logging.Logger]:
    logger = logging.getLogger("pipeline.force_emit")
    logger.setLevel(logging.DEBUG)
    try:
        yield logger
    finally:
        logger.setLevel(logging.NOTSET)


@pytest.mark.parametrize("leg", _LEGS)
def test_force_emit_delivers_a_record_below_the_handler_level(
    global_setup: _Global, debug_logger: logging.Logger, leg: str
) -> None:
    with libo11y.force_emit():
        debug_logger.debug("forced debug")

    assert global_setup.messages(leg) == ["forced debug"]


@pytest.mark.parametrize("leg", _LEGS)
def test_record_below_the_handler_level_is_not_delivered_without_force_emit(
    global_setup: _Global, debug_logger: logging.Logger, leg: str
) -> None:
    debug_logger.debug("plain debug")

    assert global_setup.messages(leg) == []


@pytest.mark.parametrize("leg", _LEGS)
def test_event_name_attribute_alone_does_not_bypass_the_handler_level(
    global_setup: _Global, debug_logger: logging.Logger, leg: str
) -> None:
    debug_logger.debug("not an event", extra={"event.name": "o11y.request.summary"})

    assert global_setup.messages(leg) == []


def test_force_emit_cannot_deliver_a_record_the_logger_level_rejects(
    global_setup: _Global,
) -> None:
    inheriting = logging.getLogger("pipeline.force_emit.inherits_root")

    with libo11y.force_emit():
        inheriting.debug("dropped by logging")

    assert global_setup.messages("console") == []


# Item 8: OpenTelemetry SDK logs go to the error handler, never to the legs.


def _log_from_thread(logger_name: str, message: str) -> None:
    thread = threading.Thread(target=logging.getLogger(logger_name).error, args=(message,))
    thread.start()
    thread.join()


def test_sdk_log_from_a_worker_thread_goes_only_to_the_error_handler(
    global_setup: _Global,
) -> None:
    _log_from_thread("opentelemetry.sdk._logs._internal.export", "Failed to export logs batch")

    assert [m for leg in _LEGS for m in global_setup.messages(leg)] == []
    assert len(global_setup.errors) == 1
    assert "Failed to export logs batch" in str(global_setup.errors[0])
    assert "opentelemetry.sdk._logs._internal.export" in str(global_setup.errors[0])


def test_logger_named_like_the_sdk_prefix_is_not_an_sdk_log(global_setup: _Global) -> None:
    logging.getLogger("opentelemetry_app").warning("app warning")

    assert global_setup.messages("console") == ["app warning"]
    assert global_setup.errors == []


def _bare_handler(errors: list[Exception], *, clock: Callable[[], float]) -> O11yLoggingHandler:
    return O11yLoggingHandler(
        level=logging.INFO,
        policy=SensitivityPolicy(),
        logger_provider=LoggerProvider(shutdown_on_exit=False),
        console_enabled=False,
        console_writer=None,
        console_format=libo11y.ConsoleFormat.JSON,
        log_export=False,
        attr_replacer=None,
        extra_handlers=(),
        error_handler=errors.append,
        clock=clock,
    )


def _sdk_record(message: str) -> logging.LogRecord:
    return logging.LogRecord(
        "opentelemetry.sdk.trace", logging.ERROR, __file__, 1, message, (), None
    )


def test_sdk_errors_are_rate_limited_with_a_suppressed_count() -> None:
    now = [0.0]
    errors: list[Exception] = []
    handler = _bare_handler(errors, clock=lambda: now[0])

    for i in range(8):
        handler.handle(_sdk_record(f"failure {i}"))
    now[0] += 30.0
    handler.handle(_sdk_record("after refill"))

    prefix = "o11y: telemetry error: opentelemetry.sdk.trace: "
    assert [str(e) for e in errors] == [
        f"{prefix}failure 0",
        f"{prefix}failure 1",
        f"{prefix}failure 2",
        f"{prefix}failure 3",
        f"{prefix}failure 4",
        f"{prefix}after refill (suppressed 3)",
    ]


# Console rendering of bytes and non-finite floats.


def _reject_constant(name: str) -> Any:
    raise ValueError(f"not valid JSON: {name}")


def test_text_console_renders_bytes_as_text(make_pipeline: Callable[..., _Pipeline]) -> None:
    p = make_pipeline(console_format=libo11y.ConsoleFormat.TEXT)

    p.logger().info("x", extra={"app.b": b"ab"})

    assert " app.b=ab\n" in p.console.getvalue()


def test_json_console_line_with_non_finite_floats_is_valid_json(
    make_pipeline: Callable[..., _Pipeline],
) -> None:
    p = make_pipeline()

    p.logger().info(
        "x", extra={"app.nan": float("nan"), "app.inf": [float("inf"), {"neg": float("-inf")}]}
    )

    line = p.console.getvalue()
    rec = json.loads(line, parse_constant=_reject_constant)
    assert (rec["app.nan"], rec["app.inf"]) == ("nan", ["inf", {"neg": "-inf"}])
