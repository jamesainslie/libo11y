"""Tests for libo11y.detached and libo11y.proc including Hypothesis property tests."""

from __future__ import annotations

import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from opentelemetry import baggage, context, trace
from opentelemetry.trace import Link, SpanContext, SpanKind, TraceFlags, TraceState

import libo11y
from libo11y import detached, proc
from libo11y.errors import InvalidCarrier
from libo11y.testing import start_recorder


def test_capture_zero_without_active_span() -> None:
    c = detached.capture()
    assert c.is_zero()
    assert c.to_text() == ""
    assert str(c) == ""
    assert not c.span_context().is_valid
    assert detached.Carrier.from_text("") == detached.Carrier()
    assert detached.Carrier.from_text(b"") == detached.Carrier()
    assert detached.Carrier.from_text(None) == detached.Carrier()


def test_capture_round_trip_and_baggage_egress_filter() -> None:
    def allow_tenant(key: str) -> bool:
        return key == "tenant"

    with start_recorder(service_name="detached-egress", baggage_egress_allow=allow_tenant) as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("tenant", "acme")
        ctx = baggage.set_baggage("secret_bag", "dropme", context=ctx)
        tok = context.attach(ctx)
        try:
            with tracer.start_as_current_span("origin") as sp:
                orig_sc = sp.get_span_context()
                carrier = detached.capture(telemetry=rec.telemetry)
        finally:
            context.detach(tok)

        assert not carrier.is_zero()
        text = carrier.to_text()
        assert "traceparent=" in text
        assert "tenant" in text
        assert "secret_bag" not in text
        assert len(text.encode("utf-8")) <= detached.MAX_CARRIER_TEXT

        parsed = detached.Carrier.from_text(text)
        assert parsed == carrier
        assert detached.Carrier.from_text(text.encode("utf-8")) == carrier
        sc = parsed.span_context()
        assert sc.is_valid
        assert sc.is_remote
        assert sc.trace_id == orig_sc.trace_id
        assert sc.span_id == orig_sc.span_id


def test_start_linked_creates_linked_root_and_merges_baggage() -> None:
    with start_recorder(service_name="detached-linked") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("tenant", "acme")
        ctx = baggage.set_baggage("shared", "from-carrier", context=ctx)
        tok = context.attach(ctx)
        try:
            with tracer.start_as_current_span("producer") as sp:
                prod_sc = sp.get_span_context()
                carrier = detached.capture(telemetry=rec.telemetry)
        finally:
            context.detach(tok)

        # Simulate consumer with pre-existing baggage and active outer span.
        consumer_ctx = baggage.set_baggage("existing", "keep")
        consumer_ctx = baggage.set_baggage("shared", "old", context=consumer_ctx)
        tok2 = context.attach(consumer_ctx)
        try:
            with tracer.start_as_current_span("outer-worker") as outer:
                outer_sc = outer.get_span_context()
                extra_link = Link(outer_sc)
                with detached.start_linked(
                    carrier,
                    "process-job",
                    telemetry=rec.telemetry,
                    kind=SpanKind.CONSUMER,
                    attributes={"job.id": "42"},
                    links=[extra_link],
                ) as job_span:
                    job_sc = job_span.get_span_context()
                    assert job_sc.trace_id != prod_sc.trace_id
                    assert job_sc.trace_id != outer_sc.trace_id
                    assert baggage.get_baggage("tenant") == "acme"
                    assert baggage.get_baggage("existing") == "keep"
                    assert baggage.get_baggage("shared") == "from-carrier"
        finally:
            context.detach(tok2)

        spans = {s.name: s for s in rec.spans()}
        job = spans["process-job"]
        assert job.parent is None
        assert job.kind == SpanKind.CONSUMER
        assert job.attributes is not None and job.attributes["job.id"] == "42"
        assert len(job.links) == 2
        assert job.links[0].context.trace_id == prod_sc.trace_id
        assert job.links[0].context.span_id == prod_sc.span_id
        assert job.links[1].context.span_id == outer_sc.span_id


def test_start_linked_zero_carrier_starts_unlinked_root() -> None:
    with start_recorder(service_name="detached-zero") as rec:
        with detached.start_linked(detached.Carrier(), "unlinked-job", telemetry=rec.telemetry):
            pass
        spans = rec.spans()
        assert len(spans) == 1
        assert spans[0].parent is None
        assert len(spans[0].links) == 0


def test_carrier_from_text_rejects_malformed_and_oversized() -> None:
    with pytest.raises(InvalidCarrier, match="exceeds"):
        detached.Carrier.from_text("a" * (detached.MAX_CARRIER_TEXT + 1))
    with pytest.raises(InvalidCarrier, match="exceeds"):
        detached.Carrier.from_text(b"a" * (detached.MAX_CARRIER_TEXT + 1))
    with pytest.raises(InvalidCarrier, match="UTF-8"):
        detached.Carrier.from_text(b"\xff\xfe")
    with pytest.raises(InvalidCarrier, match="semicolon"):
        detached.Carrier.from_text("traceparent=00-1;foo=bar")
    with pytest.raises(InvalidCarrier, match="percent"):
        detached.Carrier.from_text("traceparent=%ZZ")
    with pytest.raises(InvalidCarrier, match="no valid traceparent"):
        detached.Carrier.from_text("baggage=k%3Dv")
    with pytest.raises(InvalidCarrier, match="no valid traceparent"):
        detached.Carrier.from_text("traceparent=not-a-valid-tp")


def test_carrier_drops_oversized_baggage_and_invalid_members() -> None:
    tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    # Invalid member mixed with valid members: invalid dropped, valid kept in order.
    c = detached.Carrier.from_text(f"traceparent={tp}&baggage=a%3D1%2Cbad%20member%2Cb%3D2%2Ca%3D3")
    assert c.baggage == "b=2,a=3"

    # Baggage over 8192 bytes is dropped whole, keeping the trace link.
    big_bag = ",".join(f"k{i}={'v' * 200}" for i in range(60))
    c_big = detached.Carrier.from_text(f"traceparent={tp}&baggage={big_bag}")
    assert not c_big.is_zero()
    assert c_big.baggage == ""


def test_copy_context_across_thread_pool_and_concurrent_calls() -> None:
    with start_recorder(service_name="detached-copy-ctx") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("tenant", "blue")
        tok = context.attach(ctx)
        try:
            with tracer.start_as_current_span("parent") as parent:
                parent_sc = parent.get_span_context()

                def worker(idx: int) -> tuple[int, int, object]:
                    with tracer.start_as_current_span(f"child-{idx}") as ch:
                        return (
                            idx,
                            ch.get_span_context().trace_id,
                            baggage.get_baggage("tenant"),
                        )

                wrapped = detached.copy_context(worker)
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(wrapped, range(8)))
        finally:
            context.detach(tok)

        assert len(results) == 8
        for idx, tid, bag in results:
            assert tid == parent_sc.trace_id
            assert bag == "blue"
            assert 0 <= idx < 8


def test_proc_env_carrier_and_subprocess_round_trip() -> None:
    assert proc.env_carrier() == {}
    assert proc.extract_env({}) == context.get_current()

    with start_recorder(service_name="proc-parent") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("secret_bag", "must-not-enter-env")
        tok = context.attach(ctx)
        try:
            with tracer.start_as_current_span("spawn-child") as sp:
                sc = sp.get_span_context()
                env_entries = proc.env_carrier()
                assert proc.ENV_TRACEPARENT in env_entries
                assert proc.ENV_TRACESTATE in env_entries
                assert "BAGGAGE" not in env_entries
                assert env_entries[proc.ENV_TRACESTATE] == ""

                # Stale inherited TRACESTATE is overwritten with empty string.
                merged = proc.child_env({"TRACESTATE": "stale=1", "KEEP": "yes"})
                assert merged["TRACESTATE"] == ""
                assert merged["KEEP"] == "yes"
                assert merged["TRACEPARENT"] == env_entries[proc.ENV_TRACEPARENT]

                # Real child process extracts TRACEPARENT into a child span.
                child_code = (
                    "import json; from opentelemetry import trace; from libo11y import proc; "
                    "c = proc.extract_env(); "
                    "sc = trace.get_current_span(c).get_span_context(); "
                    "print(json.dumps({'trace_id': f'{sc.trace_id:032x}', "
                    "'span_id': f'{sc.span_id:016x}', 'remote': sc.is_remote}))"
                )
                out = subprocess.check_output(
                    [sys.executable, "-c", child_code],
                    env=proc.child_env(),
                    text=True,
                )
                parsed = json.loads(out)
                assert parsed["trace_id"] == f"{sc.trace_id:032x}"
                assert parsed["span_id"] == f"{sc.span_id:016x}"
                assert parsed["remote"] is True
        finally:
            context.detach(tok)


def test_proc_frame_inject_and_extract_with_sdk_scope() -> None:
    def allow_only(key: str) -> bool:
        return key == "allowed"

    with start_recorder(
        service_name="proc-frame",
        baggage_egress_allow=allow_only,
    ) as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("allowed", "ok")
        ctx = baggage.set_baggage("blocked", "no", context=ctx)
        tok = context.attach(ctx)
        try:
            with tracer.start_as_current_span("frame-send") as sp:
                orig_sc = sp.get_span_context()
                frame: dict[str, str] = {}
                proc.inject_frame(frame, telemetry=rec.telemetry)
        finally:
            context.detach(tok)

        assert "traceparent" in frame
        assert "allowed=ok" in frame.get("baggage", "")
        assert "blocked" not in frame.get("baggage", "")

        extracted = proc.extract_frame(frame, ctx=context.Context(), telemetry=rec.telemetry)
        rx_sc = trace.get_current_span(extracted).get_span_context()
        assert rx_sc.trace_id == orig_sc.trace_id
        assert rx_sc.span_id == orig_sc.span_id
        assert baggage.get_baggage("allowed", context=extracted) == "ok"
        assert baggage.get_baggage("blocked", context=extracted) is None


# --- Hypothesis property tests ---

_TRACE_IDS = st.integers(min_value=1, max_value=(1 << 128) - 1)
_SPAN_IDS = st.integers(min_value=1, max_value=(1 << 64) - 1)
_TRACE_FLAGS = st.sampled_from([TraceFlags.DEFAULT, TraceFlags.SAMPLED])
_TS_KEY = st.from_regex(r"[a-z][a-z0-9_\-*/]{0,12}", fullmatch=True)
_TS_VAL = st.from_regex(r"[a-zA-Z0-9_.\-]{1,16}", fullmatch=True)
_BAG_KEY = st.from_regex(r"[a-zA-Z][a-zA-Z0-9_.\-]{0,12}", fullmatch=True)
_BAG_VAL = st.from_regex(r"[a-zA-Z0-9_.\-]{1,16}", fullmatch=True)


@settings(max_examples=50)
@given(
    trace_id=_TRACE_IDS,
    span_id=_SPAN_IDS,
    flags=_TRACE_FLAGS,
    ts_pairs=st.lists(st.tuples(_TS_KEY, _TS_VAL), max_size=4, unique_by=lambda p: p[0]),
    bag_pairs=st.lists(st.tuples(_BAG_KEY, _BAG_VAL), max_size=4, unique_by=lambda p: p[0]),
)
def test_property_carrier_round_trip(
    trace_id: int,
    span_id: int,
    flags: TraceFlags,
    ts_pairs: list[tuple[str, str]],
    bag_pairs: list[tuple[str, str]],
) -> None:
    sc = SpanContext(
        trace_id=trace_id,
        span_id=span_id,
        is_remote=True,
        trace_flags=flags,
        trace_state=TraceState(ts_pairs),
    )
    ctx = trace.set_span_in_context(trace.NonRecordingSpan(sc), context.Context())
    for k, v in bag_pairs:
        ctx = baggage.set_baggage(k, v, context=ctx)

    tel = libo11y.init(
        service_name="prop-svc",
        environment="test",
        env=libo11y.HERMETIC,
        console_enabled=False,
        runtime_metrics=False,
    )
    try:
        c = detached.capture(ctx, telemetry=tel)
    finally:
        tel.shutdown()

    text = c.to_text()
    assert len(text.encode("utf-8")) <= detached.MAX_CARRIER_TEXT
    c2 = detached.Carrier.from_text(text)
    assert c2.span_context().trace_id == trace_id
    assert c2.span_context().span_id == span_id
    assert c2.span_context().trace_flags == flags

    restored = detached.restore_baggage(c2, context.Context())
    for k, v in bag_pairs:
        assert baggage.get_baggage(k, context=restored) == v


@settings(max_examples=60)
@given(raw=st.text(max_size=200))
def test_property_carrier_from_text_never_crashes(raw: str) -> None:
    try:
        c = detached.Carrier.from_text(raw)
    except InvalidCarrier:
        return
    assert len(c.to_text().encode("utf-8")) <= detached.MAX_CARRIER_TEXT
