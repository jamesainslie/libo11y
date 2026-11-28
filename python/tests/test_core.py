"""Comprehensive tests for libo11y Python core (P2)."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

import pytest
from opentelemetry import baggage, metrics, trace
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, LogRecordExportResult
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import (
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Link

import libo11y
from libo11y.spec import (
    APP_REGISTRY_SCHEMA,
    ATTR_BUILD_MODIFIED,
    ATTR_BUILD_TIME,
    ATTR_VCS_REF_HEAD_REVISION,
    EVENT_NAME_KEY,
    EVENT_REQUEST_SUMMARY,
    EVENT_TELEMETRY_CONFIGURED,
    EVENT_TELEMETRY_DROPPED,
    METRIC_SCHEMA_VIOLATIONS,
    SCHEMA_URL,
)


def _metric_names(reader: InMemoryMetricReader) -> set[str]:
    data = reader.get_metrics_data()
    if data is None:
        return set()
    names: set[str] = set()
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for m in sm.metrics:
                names.add(m.name)
    return names


def _metric_points(reader: InMemoryMetricReader, name: str) -> list[dict[str, Any]]:
    data = reader.get_metrics_data()
    if data is None:
        return []
    out: list[dict[str, Any]] = []
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for m in sm.metrics:
                if m.name != name:
                    continue
                for dp in m.data.data_points:
                    out.append(
                        {
                            "attributes": dict(dp.attributes) if dp.attributes else {},
                            "value": getattr(dp, "value", getattr(dp, "sum", None)),
                        }
                    )
    return out


def test_identity_validation_and_strict_toggle() -> None:
    with pytest.raises(libo11y.NoServiceName):
        libo11y.init(env=libo11y.HERMETIC, environment="production")

    with pytest.raises(libo11y.NoEnvironment):
        libo11y.init(env=libo11y.HERMETIC, service_name="checkout")

    with pytest.raises(libo11y.InvalidEnvironment):
        libo11y.init(env=libo11y.HERMETIC, service_name="checkout", environment="qa")

    # Extending environments works.
    tel = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="qa",
        extra_environments=("qa",),
        console_enabled=False,
        runtime_metrics=False,
    )
    assert tel.resource.attributes["deployment.environment.name"] == "qa"
    assert tel.resource.schema_url == SCHEMA_URL
    assert tel.shutdown().ok

    # Non-strict identity records violations instead of raising.
    reader = InMemoryMetricReader()
    tel2 = libo11y.init(
        env=libo11y.HERMETIC,
        strict_identity=False,
        metric_reader=reader,
        console_enabled=False,
        runtime_metrics=False,
    )
    pts = _metric_points(reader, METRIC_SCHEMA_VIOLATIONS)
    rules = {p["attributes"].get("o11y.rule") for p in pts}
    assert "identity_service_name" in rules
    assert "identity_environment" in rules
    assert tel2.shutdown().ok


def test_build_info_and_distribution_version(tmp_path: Path) -> None:
    bi_path = tmp_path / "buildinfo.json"
    info = libo11y.buildinfo.BuildInfo(
        revision="deadbeef1234",
        build_time="2026-11-27T00:00:00Z",
        modified=True,
    )
    libo11y.buildinfo.write_build_info(bi_path, info)
    loaded = libo11y.buildinfo.read_build_info(bi_path)
    assert loaded == info

    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        build_info=bi_path,
        console_enabled=False,
        runtime_metrics=False,
    ) as tel:
        assert tel.resource.attributes[ATTR_VCS_REF_HEAD_REVISION] == "deadbeef1234"
        assert tel.resource.attributes[ATTR_BUILD_TIME] == "2026-11-27T00:00:00Z"
        assert tel.resource.attributes[ATTR_BUILD_MODIFIED] is True
        assert tel.resource.attributes["service.version"] == "0.0.0-unknown"
        assert "o11y.config.service_version_fallback=true" in tel.effective_config()

    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        distribution="libo11y",
        console_enabled=False,
        runtime_metrics=False,
    ) as tel2:
        assert "service.version" in tel2.resource.attributes


def test_setup_globals_canary_and_already_setup() -> None:
    buf = io.StringIO()
    tel = libo11y.setup(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_writer=buf,
        runtime_metrics=False,
    )
    try:
        # Second setup fails with AlreadySetup.
        with pytest.raises(libo11y.AlreadySetup):
            libo11y.setup(
                env=libo11y.HERMETIC,
                service_name="other",
                environment="production",
                console_enabled=False,
            )

        # Canary event arrived on console writer.
        lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
        assert any(rec.get(EVENT_NAME_KEY) == EVENT_TELEMETRY_CONFIGURED for rec in lines)

        # Globals installed.
        assert trace.get_tracer_provider() is tel.tracer_provider
        assert metrics.get_meter_provider() is tel.meter_provider
    finally:
        assert tel.shutdown().ok


def test_canary_rejection_fails_setup_cleanly() -> None:
    class _BoomWriter(io.StringIO):
        def write(self, s: str) -> int:
            raise OSError("disk full")

    with pytest.raises(libo11y.CanaryRejected):
        libo11y.setup(
            env=libo11y.HERMETIC,
            service_name="checkout",
            environment="production",
            console_writer=_BoomWriter(),
            runtime_metrics=False,
        )

    # Failed setup must not leave global lock wedged.
    tel = libo11y.setup(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
    )
    assert tel.shutdown().ok


def test_sensitivity_policy_all_signals_and_app_registry(tmp_path: Path) -> None:
    reg_file = tmp_path / "app.yaml"
    reg_file.write_text(
        f"schema: {APP_REGISTRY_SCHEMA}\n"
        "namespace: billing\n"
        "attributes:\n"
        "  billing.card_token:\n"
        "    type: string\n"
        "    sensitivity: secret\n"
        "    cardinality: unbounded\n"
        "  billing.customer_email:\n"
        "    type: string\n"
        "    sensitivity: pii\n"
        "    cardinality: unbounded\n"
        "  billing.plan:\n"
        "    type: string\n"
        "    sensitivity: public\n"
        "    cardinality: bounded\n",
        encoding="utf-8",
    )

    with pytest.raises(libo11y.PIIHashKey):
        libo11y.init(
            env=libo11y.HERMETIC,
            service_name="svc",
            environment="test",
            pii_mode=libo11y.PIIMode.HASH,
            pii_hash_key=b"too-short",
        )

    span_exp = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    log_exp = InMemoryLogRecordExporter()
    console_buf = io.StringIO()
    key = bytes(range(32))

    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        app_registry=reg_file,
        pii_mode=libo11y.PIIMode.HASH,
        pii_hash_key=key,
        resource_attributes={
            "billing.card_token": "tok_secret",
            "billing.customer_email": "alice@example.com",
            "billing.plan": "pro",
        },
        span_processor=SimpleSpanProcessor(span_exp),
        metric_reader=metric_reader,
        log_exporter=log_exp,
        console_writer=console_buf,
        runtime_metrics=False,
    ) as tel:
        # Resource classification.
        assert "billing.card_token" not in tel.resource.attributes
        assert str(tel.resource.attributes["billing.customer_email"]).startswith("hmac-sha256:")
        assert tel.resource.attributes["billing.plan"] == "pro"

        # Trace classification (span, event, and link attributes).
        tracer = tel.tracer_provider.get_tracer("test")
        with tracer.start_as_current_span("parent") as parent:
            link = Link(
                parent.get_span_context(),
                attributes={
                    "billing.card_token": "secret-link",
                    "billing.customer_email": "alice@example.com",
                    "billing.plan": "pro",
                },
            )
            with tracer.start_as_current_span("child", links=[link]) as child:
                child.set_attribute("billing.card_token", "secret-span")
                child.set_attribute("billing.customer_email", "alice@example.com")
                child.set_attribute("billing.plan", "pro")
                child.add_event(
                    "ev",
                    {
                        "billing.card_token": "secret-ev",
                        "billing.customer_email": "alice@example.com",
                    },
                )

                # Log classification + trace correlation.
                logger = logging.getLogger("test.policy")
                logger.setLevel(logging.DEBUG)
                logger.propagate = False
                logger.addHandler(tel.logging_handler())
                try:
                    logger.info(
                        "charged",
                        extra={
                            "billing.card_token": "secret-log",
                            "billing.customer_email": "alice@example.com",
                            "billing.plan": "pro",
                        },
                    )
                finally:
                    logger.removeHandler(tel.logging_handler())

        # Metric classification: PII dropped even in HASH mode!
        meter = tel.meter_provider.get_meter("test")
        counter = meter.create_counter("test.charges")
        counter.add(
            1,
            {
                "billing.card_token": "secret-metric",
                "billing.customer_email": "alice@example.com",
                "billing.plan": "pro",
            },
        )

        # Inspect spans.
        spans = span_exp.get_finished_spans()
        child_span = next(s for s in spans if s.name == "child")
        assert child_span.attributes is not None
        assert "billing.card_token" not in child_span.attributes
        email_tok = str(child_span.attributes["billing.customer_email"])
        assert email_tok.startswith("hmac-sha256:")
        assert child_span.attributes["billing.plan"] == "pro"
        assert child_span.events[0].attributes is not None
        assert "billing.card_token" not in child_span.events[0].attributes
        assert child_span.events[0].attributes["billing.customer_email"] == email_tok
        assert child_span.links[0].attributes is not None
        assert "billing.card_token" not in child_span.links[0].attributes
        assert child_span.links[0].attributes["billing.customer_email"] == email_tok

        # Inspect metrics.
        charge_pts = _metric_points(metric_reader, "test.charges")
        assert len(charge_pts) == 1
        assert charge_pts[0]["attributes"] == {"billing.plan": "pro"}

        # Inspect console logs (same PII token across signals!).
        log_lines = [json.loads(ln) for ln in console_buf.getvalue().splitlines() if ln.strip()]
        assert len(log_lines) == 1
        rec = log_lines[0]
        assert rec["msg"] == "charged"
        assert "billing.card_token" not in rec
        assert rec["billing.customer_email"] == email_tok
        assert rec["billing.plan"] == "pro"
        assert child_span.context is not None
        assert rec["trace_id"] == f"{child_span.context.trace_id:032x}"
        assert rec["span_id"] == f"{child_span.context.span_id:016x}"

        # Violations counter incremented.
        viol_pts = _metric_points(metric_reader, METRIC_SCHEMA_VIOLATIONS)
        assert len(viol_pts) > 0

    # OTLP log leg also got the record with the exact same token (not double-hashed!).
    exported_logs = log_exp.get_finished_logs()
    assert len(exported_logs) == 1
    assert exported_logs[0].log_record.attributes is not None
    assert exported_logs[0].log_record.attributes["billing.customer_email"] == email_tok


def test_logging_handler_features_force_emit_replacer_text_and_bounds() -> None:
    buf = io.StringIO()

    def replacer(groups: tuple[str, ...], key: str, val: Any) -> tuple[str, Any] | None:
        del groups
        if key == "drop_me":
            return None
        if key == "rename_me":
            return ("renamed", val)
        return (key, val)

    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        log_level=logging.WARNING,
        console_writer=buf,
        console_format=libo11y.ConsoleFormat.TEXT,
        attr_replacer=replacer,
        log_export=False,
        runtime_metrics=False,
    ) as tel:
        logger = logging.getLogger("test.features")
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
        logger.addHandler(tel.logging_handler())
        try:
            logger.info("filtered_out")
            with libo11y.force_emit():
                cyclic: dict[str, Any] = {}
                cyclic["self"] = cyclic
                logger.info(
                    "forced_in",
                    extra={"drop_me": "gone", "rename_me": "ok", "cyc": cyclic},
                )
        finally:
            logger.removeHandler(tel.logging_handler())

    out = buf.getvalue()
    assert "filtered_out" not in out
    assert "forced_in" in out
    assert "drop_me" not in out
    assert "renamed=ok" in out
    # The cyclic mapping is cut at the cycle, emptied, and dropped whole.
    assert "cyc=" not in out
    assert "truncated" not in out


def test_redact_types_and_decorator_typo_rejection() -> None:
    sec = libo11y.redact.Secret("super-secret")
    assert str(sec) == "REDACTED"
    assert repr(sec) == "REDACTED"
    assert f"{sec}" == "REDACTED"
    assert sec.reveal() == "super-secret"

    msk = libo11y.redact.Masked("4111-1111")
    assert str(msk) == "XXXXXXXXX"
    assert repr(msk) == "XXXXXXXXX"
    assert f"{msk}" == "XXXXXXXXX"
    assert msk.reveal() == "4111-1111"

    @libo11y.redact.redacted
    @dataclass
    class Payment:
        card: Annotated[str, "mask"]
        cvv: Annotated[str, "redact"]
        pin: Annotated[str, "omit"]
        token: Annotated[str, "secret"]
        note: Annotated[str, "confidential"]
        merchant: str

    p = Payment(
        card="4111",
        cvv="123",
        pin="9999",
        token="sec_val_999",
        note="vip",
        merchant="acme",
    )
    rendered = str(p)
    assert "4111" not in rendered
    assert "123" not in rendered
    assert "9999" not in rendered
    assert "pin" not in rendered
    assert "sec_val_999" not in rendered
    assert "vip" not in rendered
    assert "card:XXXX" in rendered
    assert "cvv:REDACTED" in rendered
    assert "token:REDACTED" in rendered
    assert "note:XXX" in rendered
    assert "merchant:acme" in rendered

    # Unknown tag raises TypeError immediately when class is defined.
    with pytest.raises(TypeError, match="unknown redaction tag"):

        @libo11y.redact.redacted
        @dataclass
        class Bad:
            field: Annotated[str, "redatced"]


def test_events_and_wide_record() -> None:
    buf = io.StringIO()
    with (
        libo11y.init(
            env=libo11y.HERMETIC,
            service_name="svc",
            environment="test",
            console_writer=buf,
            log_level=logging.ERROR,
            log_export=False,
            runtime_metrics=False,
        ) as tel,
        libo11y.start_record() as rec,
    ):
        assert libo11y.current_record() is rec
        rec.set("http.request.method", "GET")
        rec.add("db.queries", 2)
        rec.add("db.queries", 3)
        rec.max("downstream.max_ms", 12.5)
        rec.max("downstream.max_ms", 4.0)
        rec.emit_event(tel, EVENT_REQUEST_SUMMARY, {"o11y.outcome": "success"})

    lines = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
    assert len(lines) == 1
    assert lines[0][EVENT_NAME_KEY] == EVENT_REQUEST_SUMMARY
    assert lines[0]["db.queries"] == 5
    assert lines[0]["downstream.max_ms"] == 12.5
    assert lines[0]["o11y.outcome"] == "success"


def test_runtime_metrics_registered() -> None:
    reader = InMemoryMetricReader()
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        metric_reader=reader,
        console_enabled=False,
        runtime_metrics=True,
    ):
        names = _metric_names(reader)
        assert "cpython.gc.collections" in names
        assert "cpython.gc.collected_objects" in names
        assert "cpython.gc.uncollectable_objects" in names
        assert "process.cpu.time" in names
        assert "process.memory.usage" in names
        assert "process.thread.count" in names


def test_hostile_environment_ignored_in_hermetic_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    hostile = {
        "OTEL_SERVICE_NAME": "evil-service",
        "OTEL_RESOURCE_ATTRIBUTES": "deployment.environment.name=staging,evil=1",
        "OTEL_TRACES_EXPORTER": "prometheus",
        "OTEL_METRICS_EXPORTER": "prometheus",
        "OTEL_LOGS_EXPORTER": "prometheus",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "invalid_proto",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "https://user:pass@evil.example:4318",
        "OTEL_TRACES_SAMPLER": "always_off",
        "OTEL_METRICS_EXEMPLAR_FILTER": "always_off",
        "OTEL_BSP_MAX_QUEUE_SIZE": "1",
        "OTEL_BLRP_MAX_QUEUE_SIZE": "1",
        "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT": "1",
        "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT": "1",
        "OTEL_ATTRIBUTE_COUNT_LIMIT": "1",
        "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT": "1",
        "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT": "1",
        "OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT": "1",
    }
    for k, v in hostile.items():
        monkeypatch.setenv(k, v)

    span_exp = InMemorySpanExporter()
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="hermetic-svc",
        environment="test",
        span_processor=SimpleSpanProcessor(span_exp),
        console_enabled=False,
        runtime_metrics=False,
    ) as tel:
        assert tel.resource.attributes["service.name"] == "hermetic-svc"
        assert tel.resource.attributes["deployment.environment.name"] == "test"
        assert "evil" not in tel.resource.attributes
        assert "evil.example" not in tel.effective_config()
        tracer = tel.tracer_provider.get_tracer("test")
        with tracer.start_as_current_span("ok") as sp:
            sp.set_attribute("a", 1)
            sp.set_attribute("b", 2)
        spans = span_exp.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].attributes is not None
        assert spans[0].attributes["a"] == 1
        assert spans[0].attributes["b"] == 2


def test_unsupported_exporter_and_protocol_rejected() -> None:
    with pytest.raises(libo11y.UnsupportedProtocol):
        libo11y.init(
            env={"OTEL_METRICS_EXPORTER": "prometheus"},
            service_name="svc",
            environment="test",
            console_enabled=False,
        )

    with pytest.raises(libo11y.UnsupportedProtocol):
        libo11y.init(
            env={"OTEL_EXPORTER_OTLP_PROTOCOL": "http/json"},
            service_name="svc",
            environment="test",
            console_enabled=False,
        )


def test_hermetic_detects_ambient_otel_sdk_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    with pytest.raises(libo11y.O11yError, match="OTEL_SDK_DISABLED"):
        libo11y.init(
            env=libo11y.HERMETIC,
            service_name="svc",
            environment="test",
            console_enabled=False,
            runtime_metrics=False,
        )


def test_shutdown_idempotent_concurrent_and_timeout() -> None:
    class _SlowSpanExporter(SpanExporter):
        def __init__(self) -> None:
            self.release = threading.Event()

        def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
            del spans
            return SpanExportResult.SUCCESS

        def shutdown(self) -> None:
            self.release.wait(timeout=2.0)

    slow = _SlowSpanExporter()
    buf = io.StringIO()
    tel = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        span_exporter=slow,
        console_writer=buf,
        log_export=False,
        runtime_metrics=False,
        shutdown_timeout=0.05,
    )

    results: list[libo11y.ShutdownReport] = []

    def _call() -> None:
        results.append(tel.shutdown())

    threads = [threading.Thread(target=_call) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=2.0)
    slow.release.set()

    assert len(results) == 4
    first = results[0]
    assert not first.ok
    assert "traces" in first.timed_out
    assert all(r is first for r in results)
    assert tel.shutdown() is first
    assert EVENT_TELEMETRY_DROPPED in buf.getvalue()


async def test_ashutdown_and_signal_helpers() -> None:
    ran: list[str] = []
    tel = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        console_enabled=False,
        runtime_metrics=False,
    )
    stop = asyncio.Event()

    async def _trigger() -> None:
        await asyncio.sleep(0.01)
        stop.set()

    async def _before() -> None:
        ran.append("before")

    task = asyncio.create_task(_trigger())
    report = await libo11y.ashutdown_on_signals(
        tel,
        before_shutdown=_before,
        stop_event=stop,
    )
    await task
    assert report.ok
    assert ran == ["before"]

    # Sync shutdown_on_signals with stop_event.
    tel2 = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        console_enabled=False,
        runtime_metrics=False,
    )
    sync_stop = threading.Event()
    sync_stop.set()
    report2 = libo11y.shutdown_on_signals(
        tel2,
        before_shutdown=lambda: ran.append("sync_before"),
        stop_event=sync_stop,
    )
    assert report2.ok
    assert "sync_before" in ran


def test_baggage_egress_filter_and_non_global_propagation() -> None:
    def _allow_tenant(key: str) -> bool:
        return key == "tenant"

    tel = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        baggage_egress_allow=_allow_tenant,
        console_enabled=False,
        runtime_metrics=False,
    )
    try:
        ctx = baggage.set_baggage("tenant", "acme")
        ctx = baggage.set_baggage("secret_key", "nope", context=ctx)
        carrier: dict[str, str] = {}
        tel.inject(carrier, context=ctx)
        extracted = tel.extract(carrier)
        assert baggage.get_baggage("tenant", context=extracted) == "acme"
        assert baggage.get_baggage("secret_key", context=extracted) is None
    finally:
        assert tel.shutdown().ok


def test_effective_config_sanitizes_endpoints() -> None:
    with libo11y.init(
        env={
            "OTEL_TRACES_EXPORTER": "none",
            "OTEL_METRICS_EXPORTER": "none",
            "OTEL_LOGS_EXPORTER": "none",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "https://user:s3cr3t@collector.example:4318/v1?tok=1#f",
        },
        service_name="svc",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
    ) as tel:
        cfg = tel.effective_config()
        assert "s3cr3t" not in cfg
        assert "tok=1" not in cfg
        assert "o11y.config.endpoint=https://collector.example:4318/v1" in cfg
        # Ensure we didn't leak into os.environ.
        assert "OTEL_EXPORTER_OTLP_ENDPOINT" not in os.environ


def test_duplicate_app_registry_namespace_rejected(tmp_path: Path) -> None:
    body = (
        f"schema: {APP_REGISTRY_SCHEMA}\n"
        "namespace: dup\n"
        "attributes:\n"
        "  dup.item:\n"
        "    type: string\n"
        "    sensitivity: public\n"
        "    cardinality: bounded\n"
    )
    p1 = tmp_path / "a.yaml"
    p2 = tmp_path / "b.yaml"
    p1.write_text(body, encoding="utf-8")
    p2.write_text(body, encoding="utf-8")
    with pytest.raises(libo11y.InvalidAppRegistry, match="duplicate namespace"):
        libo11y.init(
            env=libo11y.HERMETIC,
            service_name="svc",
            environment="test",
            app_registry=(p1, p2),
            console_enabled=False,
        )


def test_shutdown_racing_emits_from_threads() -> None:
    span_exp = InMemorySpanExporter()
    tel = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        span_exporter=span_exp,
        console_enabled=False,
        runtime_metrics=False,
    )
    tracer = tel.tracer_provider.get_tracer("race")
    stop = threading.Event()
    errors: list[Exception] = []

    def _worker() -> None:
        try:
            while not stop.is_set():
                with tracer.start_as_current_span("work"):
                    time.sleep(0.0005)
        except Exception as exc:
            errors.append(exc)

    workers = [threading.Thread(target=_worker) for _ in range(4)]
    for w in workers:
        w.start()
    time.sleep(0.02)
    report = tel.shutdown()
    stop.set()
    for w in workers:
        w.join(timeout=2.0)

    assert report.ok
    assert errors == []


def test_otel_log_exporter_failure_never_crashes_host() -> None:
    class _FailingLogExporter(InMemoryLogRecordExporter):
        def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
            del batch
            return LogRecordExportResult.FAILURE

    errs: list[Exception] = []
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="svc",
        environment="test",
        log_exporter=_FailingLogExporter(),
        console_enabled=False,
        error_handler=errs.append,
        runtime_metrics=False,
    ) as tel:
        logger = logging.getLogger("test.fail_log")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        logger.addHandler(tel.logging_handler())
        try:
            logger.info("hello")
        finally:
            logger.removeHandler(tel.logging_handler())
    assert errs == []
