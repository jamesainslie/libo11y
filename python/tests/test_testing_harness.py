"""Tests for libo11y.testing Recorder, assertions, pytest plugin, and OTLP wire receivers."""

from __future__ import annotations

import logging
from typing import Any

import pytest

import libo11y
from libo11y.spec import (
    ATTR_OUTCOME,
    EVENT_REQUEST_SUMMARY,
    EVENT_TELEMETRY_CONFIGURED,
    Outcome,
)
from libo11y.testing import (
    OTLPGRPCReceiver,
    OTLPHTTPReceiver,
    Recorder,
    start_recorder,
)


def test_pytest_fixture_o11y_recorder(o11y_recorder: Recorder) -> None:
    tracer = o11y_recorder.telemetry.tracer_provider.get_tracer("fixture")
    logger = o11y_recorder.logger("fixture.log")
    with tracer.start_as_current_span("fixture-op"):
        logger.info("inside span", extra={"o11y.outcome": Outcome.SUCCESS})
    o11y_recorder.assert_conforms()
    assert [s.name for s in o11y_recorder.spans()] == ["fixture-op"]
    logs = o11y_recorder.logs()
    assert len(logs) == 1
    assert logs[0].trace_id is not None
    assert logs[0].span_id is not None


def test_recorder_assert_conforms_detects_secret_and_missing_event_attrs() -> None:
    with start_recorder(service_name="conforms-secret") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        with tracer.start_as_current_span("op") as sp:
            sp.set_attribute("http.request.header.authorization", "Bearer tok")
        with pytest.raises(AssertionError, match="secret-classified attribute emitted on traces"):
            rec.assert_conforms()

    with start_recorder(service_name="conforms-event") as rec2:
        rec2.telemetry.event(EVENT_TELEMETRY_CONFIGURED, {})
        with pytest.raises(
            AssertionError, match=r"missing required template attribute o11y\.config\.<key>"
        ):
            rec2.assert_conforms()

    with start_recorder(service_name="conforms-ok") as rec3:
        rec3.telemetry.event(
            EVENT_REQUEST_SUMMARY,
            {
                "http.request.method": "GET",
                "http.response.status_code": 200,
                "o11y.duration": 12.5,
                ATTR_OUTCOME: str(Outcome.SUCCESS),
            },
        )
        rec3.assert_conforms()


def test_recorder_exemplars_link_metrics_to_sampled_spans() -> None:
    with start_recorder(service_name="exemplar-test") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        meter = rec.telemetry.meter_provider.get_meter("test")
        hist = meter.create_histogram("http.server.request.duration", unit="s")
        with tracer.start_as_current_span("GET /orders") as sp:
            hist.record(0.042, {"http.request.method": "GET"})
            sc = sp.get_span_context()

        exemplars = rec.exemplars("http.server.request.duration")
        assert len(exemplars) >= 1
        assert any(ex.trace_id == sc.trace_id and ex.span_id == sc.span_id for ex in exemplars)


def _proto_attrs_dict(attrs: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for kv in attrs:
        v = kv.value
        which = v.WhichOneof("value")
        if which == "string_value":
            out[kv.key] = v.string_value
        elif which == "int_value":
            out[kv.key] = v.int_value
        elif which == "double_value":
            out[kv.key] = v.double_value
        elif which == "bool_value":
            out[kv.key] = v.bool_value
    return out


def test_otlp_http_wire_all_signals_policy_exemplars_and_correlation() -> None:
    key = bytes(range(32))
    with OTLPHTTPReceiver() as rx:
        env = {
            "OTEL_EXPORTER_OTLP_ENDPOINT": rx.endpoint,
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
            "OTEL_EXPORTER_OTLP_COMPRESSION": "gzip",
            "OTEL_EXPORTER_OTLP_HEADERS": "x-test-token=ok123",
            "OTEL_TRACES_EXPORTER": "otlp",
            "OTEL_METRICS_EXPORTER": "otlp",
            "OTEL_LOGS_EXPORTER": "otlp",
        }
        tel = libo11y.init(
            env=env,
            service_name="wire-http-svc",
            environment="production",
            pii_mode=libo11y.PIIMode.HASH,
            pii_hash_key=key,
            console_enabled=False,
            runtime_metrics=False,
        )
        tracer = tel.tracer_provider.get_tracer("wire")
        meter = tel.meter_provider.get_meter("wire")
        hist = meter.create_histogram("wire.latency", unit="s")
        lg = logging.getLogger("wire.http.test")
        lg.setLevel(logging.DEBUG)
        lg.propagate = False
        lg.addHandler(tel.logging_handler())
        try:
            with tracer.start_as_current_span("wire-http-op") as sp:
                sp.set_attribute("http.request.header.authorization", "Bearer secret")
                sp.set_attribute("device.id", "dev-12345")
                hist.record(
                    0.125,
                    {
                        "http.request.header.authorization": "Bearer secret",
                        "device.id": "dev-12345",
                        "route": "/ok",
                    },
                )
                lg.info(
                    "wire log",
                    extra={
                        "http.request.header.authorization": "Bearer secret",
                        "device.id": "dev-12345",
                    },
                )
                sc = sp.get_span_context()
        finally:
            lg.removeHandler(tel.logging_handler())

        report = tel.shutdown(timeout=5.0)
        assert report.ok
        rec = rx.received()

    assert "wire-http-op" in rec.span_names()
    assert "wire.latency" in rec.metric_names()
    assert "wire log" in rec.log_bodies()
    assert any(h.get("x-test-token") == "ok123" for h in rx.headers())

    # Verify resource identity & policy on traces.
    rs = rec.trace_requests[0].resource_spans[0]
    res_attrs = _proto_attrs_dict(rs.resource.attributes)
    assert res_attrs["service.name"] == "wire-http-svc"
    assert res_attrs["deployment.environment.name"] == "production"
    sp_proto = rs.scope_spans[0].spans[0]
    sp_attrs = _proto_attrs_dict(sp_proto.attributes)
    assert "http.request.header.authorization" not in sp_attrs
    device_tok = sp_attrs["device.id"]
    assert isinstance(device_tok, str) and device_tok.startswith("hmac-sha256:")

    # Verify log-to-trace correlation & identical PII token.
    lr_proto = rec.log_requests[0].resource_logs[0].scope_logs[0].log_records[0]
    assert lr_proto.trace_id == sc.trace_id.to_bytes(16, "big")
    assert lr_proto.span_id == sc.span_id.to_bytes(8, "big")
    lr_attrs = _proto_attrs_dict(lr_proto.attributes)
    assert "http.request.header.authorization" not in lr_attrs
    assert lr_attrs["device.id"] == device_tok

    # Verify metrics dropped secret and PII and recorded exemplar.
    found_exemplar = False
    for req_m in rec.metric_requests:
        for rm in req_m.resource_metrics:
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    if m.name == "wire.latency":
                        for dp in m.histogram.data_points:
                            dp_attrs = _proto_attrs_dict(dp.attributes)
                            assert "http.request.header.authorization" not in dp_attrs
                            assert "device.id" not in dp_attrs
                            assert dp_attrs["route"] == "/ok"
                            for ex in dp.exemplars:
                                if ex.trace_id == sc.trace_id.to_bytes(16, "big"):
                                    found_exemplar = True
    assert found_exemplar


def test_otlp_grpc_wire_all_signals_policy_and_correlation() -> None:
    with OTLPGRPCReceiver() as rx:
        env = {
            "OTEL_EXPORTER_OTLP_ENDPOINT": rx.endpoint,
            "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
            "OTEL_EXPORTER_OTLP_INSECURE": "true",
            "OTEL_TRACES_EXPORTER": "otlp",
            "OTEL_METRICS_EXPORTER": "otlp",
            "OTEL_LOGS_EXPORTER": "otlp",
        }
        tel = libo11y.init(
            env=env,
            service_name="wire-grpc-svc",
            environment="staging",
            console_enabled=False,
            runtime_metrics=False,
        )
        tracer = tel.tracer_provider.get_tracer("wire-grpc")
        meter = tel.meter_provider.get_meter("wire-grpc")
        counter = meter.create_counter("wire.grpc.calls")
        lg = logging.getLogger("wire.grpc.test")
        lg.setLevel(logging.DEBUG)
        lg.propagate = False
        lg.addHandler(tel.logging_handler())
        try:
            with tracer.start_as_current_span("wire-grpc-op") as sp:
                sp.set_attribute("http.request.header.cookie", "session=secret")
                counter.add(1, {"ok": "yes"})
                lg.info("grpc wire log")
                sc = sp.get_span_context()
        finally:
            lg.removeHandler(tel.logging_handler())

        report = tel.shutdown(timeout=5.0)
        assert report.ok
        rec = rx.received()

    assert "wire-grpc-op" in rec.span_names()
    assert "wire.grpc.calls" in rec.metric_names()
    assert "grpc wire log" in rec.log_bodies()

    sp_proto = rec.trace_requests[0].resource_spans[0].scope_spans[0].spans[0]
    assert "http.request.header.cookie" not in _proto_attrs_dict(sp_proto.attributes)

    lr_proto = rec.log_requests[0].resource_logs[0].scope_logs[0].log_records[0]
    assert lr_proto.trace_id == sc.trace_id.to_bytes(16, "big")
    assert lr_proto.span_id == sc.span_id.to_bytes(8, "big")
