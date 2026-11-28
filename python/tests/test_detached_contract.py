"""Detached context and proc propagation contract tests."""

from __future__ import annotations

import asyncio
import contextvars
import inspect
from concurrent.futures import ThreadPoolExecutor

import pytest
from opentelemetry import baggage, context, propagate, trace
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.context import Context
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags, TraceState
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

import libo11y
from libo11y import detached, proc
from libo11y.errors import InvalidCarrier
from libo11y.testing import start_recorder

_SAMPLE_TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


# Finding 7: Carrier 32 KiB invariant on construction and serialization, matching Go encoding.


@pytest.mark.parametrize(
    ("tp", "ts", "bag"),
    [
        pytest.param("0" * (detached.MAX_CARRIER_TEXT + 1), "", "", id="oversized-traceparent"),
        pytest.param(_SAMPLE_TP, "k=" + "v" * detached.MAX_CARRIER_TEXT, "", id="oversized-ts"),
        pytest.param(_SAMPLE_TP, "", "k=" + "v" * detached.MAX_CARRIER_TEXT, id="oversized-bag"),
        pytest.param(
            _SAMPLE_TP,
            "k=" + "/" * 12_000,
            "",
            id="url-encoded-expansion-past-limit",
        ),
        pytest.param(
            _SAMPLE_TP,
            "t=" + "a" * 17_000,
            "b=" + "c" * 17_000,
            id="combined-ts-and-baggage-past-limit",
        ),
    ],
)
def test_carrier_direct_construction_rejects_oversized_content(tp: str, ts: str, bag: str) -> None:
    with pytest.raises(InvalidCarrier, match="exceeds"):
        detached.Carrier(traceparent=tp, tracestate=ts, baggage=bag)


def test_carrier_direct_construction_allows_exact_32kib_boundary() -> None:
    prefix = f"traceparent={_SAMPLE_TP}&tracestate=k%3D"
    remaining = detached.MAX_CARRIER_TEXT - len(prefix)
    exact = detached.Carrier(traceparent=_SAMPLE_TP, tracestate="k=" + "a" * remaining)
    assert len(exact.to_text().encode("utf-8")) == detached.MAX_CARRIER_TEXT

    with pytest.raises(InvalidCarrier, match="exceeds"):
        detached.Carrier(traceparent=_SAMPLE_TP, tracestate="k=" + "a" * (remaining + 1))


def test_carrier_to_text_enforces_32kib_bound_even_if_init_bypassed() -> None:
    c = object.__new__(detached.Carrier)
    object.__setattr__(c, "traceparent", _SAMPLE_TP)
    object.__setattr__(c, "tracestate", "k=" + "v" * detached.MAX_CARRIER_TEXT)
    object.__setattr__(c, "baggage", "")

    with pytest.raises(InvalidCarrier, match="exceeds"):
        c.to_text()
    with pytest.raises(InvalidCarrier, match="exceeds"):
        str(c)


def test_carrier_text_encoding_matches_go_byte_for_byte() -> None:
    assert detached.Carrier().to_text() == ""
    c = detached.Carrier(
        traceparent=_SAMPLE_TP,
        tracestate="vendor=a/b,other=1~2_3.4-5",
        baggage="tenant=acme corp,env=prod",
    )
    # Go url.Values.Encode() sorts keys alphabetically, uses '+' for space,
    # keeps [-_.~A-Za-z0-9] unescaped, and uses uppercase percent escapes.
    want = (
        "baggage=tenant%3Dacme+corp%2Cenv%3Dprod"
        f"&traceparent={_SAMPLE_TP}"
        "&tracestate=vendor%3Da%2Fb%2Cother%3D1~2_3.4-5"
    )
    assert c.to_text() == want
    assert str(c) == want


def test_carrier_from_text_drops_tracestate_that_expands_past_32kib_on_reencode() -> None:
    # Unencoded '/' characters fit under 32 KiB on input, but triple past 32 KiB on re-encode.
    raw_members = [f"k{i:02d}{'/' * 253}={'/' * 256}" for i in range(32)]
    raw_ts = ",".join(raw_members)
    raw = f"traceparent={_SAMPLE_TP}&tracestate={raw_ts}&baggage=tenant%3Dacme"
    assert len(raw.encode("utf-8")) < detached.MAX_CARRIER_TEXT

    parsed = detached.Carrier.from_text(raw)
    assert parsed.span_context().is_valid
    assert parsed.tracestate == ""
    assert parsed.baggage == "tenant=acme"
    assert len(parsed.to_text().encode("utf-8")) <= detached.MAX_CARRIER_TEXT


def test_capture_drops_tracestate_then_baggage_to_stay_within_32kib() -> None:
    # Largest valid W3C tracestate: 32 members whose keys/values expand 3x on URL-encoding.
    ts_pairs = [(f"k{i:02d}" + "/" * 253, "/" * 256) for i in range(32)]
    sc = SpanContext(
        trace_id=0x4BF92F3577B34DA6A3CE929D0E0E4736,
        span_id=0x00F067AA0BA902B7,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState(ts_pairs),
    )
    ctx = trace.set_span_in_context(NonRecordingSpan(sc), Context())
    ctx = baggage.set_baggage("tenant", "acme", context=ctx)

    with start_recorder(service_name="detached-bound") as rec:
        carrier = detached.capture(ctx, telemetry=rec.telemetry)

    text = carrier.to_text()
    assert len(text.encode("utf-8")) <= detached.MAX_CARRIER_TEXT
    assert "tenant%3Dacme" in text
    assert carrier.tracestate == ""
    parsed = detached.Carrier.from_text(text)
    assert parsed.span_context().span_id == sc.span_id


# Finding 8 + functools.wraps: copy_context sync, async, metadata and signature.


def test_copy_context_sync_runs_in_copied_context_with_thread_pool_submit() -> None:
    var: contextvars.ContextVar[str] = contextvars.ContextVar("sync_var", default="unset")
    with start_recorder(service_name="copy-ctx-sync") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("tenant", "blue")
        tok = context.attach(ctx)
        var_tok = var.set("captured")
        try:
            with tracer.start_as_current_span("parent") as parent:
                parent_tid = parent.get_span_context().trace_id

                def work(label: str) -> tuple[str, int, object, str]:
                    seen_var = var.get()
                    var.set(f"mutated-{label}")
                    with tracer.start_as_current_span(f"child-{label}") as child:
                        return (
                            label,
                            child.get_span_context().trace_id,
                            baggage.get_baggage("tenant"),
                            seen_var,
                        )

                wrapped = detached.copy_context(work)
        finally:
            var.reset(var_tok)
            context.detach(tok)

        with ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(wrapped, "one")
            f2 = pool.submit(wrapped, "two")
            r1 = f1.result()
            r2 = f2.result()

        assert r1 == ("one", parent_tid, "blue", "captured")
        assert r2 == ("two", parent_tid, "blue", "captured")
        assert var.get() == "unset"


async def test_copy_context_async_runs_body_in_copied_context_across_awaits() -> None:
    var: contextvars.ContextVar[str] = contextvars.ContextVar("async_var", default="unset")
    gate = asyncio.Event()

    with start_recorder(service_name="copy-ctx-async") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("tenant", "blue")
        tok = context.attach(ctx)
        var_tok = var.set("captured")
        try:
            with tracer.start_as_current_span("parent") as parent:
                parent_tid = parent.get_span_context().trace_id

                async def worker(val: int) -> tuple[int, int, object, str, int, object, str]:
                    before_tid = trace.get_current_span().get_span_context().trace_id
                    before_bag = baggage.get_baggage("tenant")
                    before_var = var.get()
                    var.set("worker-local")
                    await gate.wait()
                    await asyncio.sleep(0)
                    after_tid = trace.get_current_span().get_span_context().trace_id
                    after_bag = baggage.get_baggage("tenant")
                    after_var = var.get()
                    return (
                        val,
                        before_tid,
                        before_bag,
                        before_var,
                        after_tid,
                        after_bag,
                        after_var,
                    )

                wrapped = detached.copy_context(worker)
        finally:
            var.reset(var_tok)
            context.detach(tok)

        # Await inside a completely different span, baggage, and ContextVar value.
        other_ctx = baggage.set_baggage("tenant", "red")
        tok_other = context.attach(other_ctx)
        var_other = var.set("awaiter")
        try:
            with tracer.start_as_current_span("awaiter-span") as other_span:
                other_tid = other_span.get_span_context().trace_id
                gate.set()
                res = await wrapped(7)
                assert trace.get_current_span().get_span_context().trace_id == other_tid
                assert baggage.get_baggage("tenant") == "red"
                assert var.get() == "awaiter"
        finally:
            var.reset(var_other)
            context.detach(tok_other)

        assert res == (7, parent_tid, "blue", "captured", parent_tid, "blue", "worker-local")


async def test_copy_context_async_works_with_asyncio_create_task_and_isolates_calls() -> None:
    var: contextvars.ContextVar[str] = contextvars.ContextVar("task_var", default="unset")
    started = asyncio.Event()
    proceed = asyncio.Event()
    started_count = 0

    with start_recorder(service_name="copy-ctx-task") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("tenant", "green")
        tok = context.attach(ctx)
        var_tok = var.set("initial")
        try:
            with tracer.start_as_current_span("origin") as origin:
                origin_tid = origin.get_span_context().trace_id

                async def task_body(name: str) -> tuple[str, int, object, str, str]:
                    nonlocal started_count
                    initial = var.get()
                    var.set(f"owned-by-{name}")
                    started_count += 1
                    if started_count == 2:
                        started.set()
                    await proceed.wait()
                    with tracer.start_as_current_span(f"work-{name}") as sp:
                        return (
                            name,
                            sp.get_span_context().trace_id,
                            baggage.get_baggage("tenant"),
                            initial,
                            var.get(),
                        )

                wrapped = detached.copy_context(task_body)
        finally:
            var.reset(var_tok)
            context.detach(tok)

        other_ctx = baggage.set_baggage("tenant", "other")
        tok_other = context.attach(other_ctx)
        try:
            t1 = asyncio.create_task(wrapped("a"))
            t2 = asyncio.create_task(wrapped("b"))
            await started.wait()
            proceed.set()
            r1, r2 = await asyncio.gather(t1, t2)
        finally:
            context.detach(tok_other)

        assert r1 == ("a", origin_tid, "green", "initial", "owned-by-a")
        assert r2 == ("b", origin_tid, "green", "initial", "owned-by-b")


async def test_copy_context_async_propagates_errors_and_cancellation() -> None:
    var: contextvars.ContextVar[str] = contextvars.ContextVar("cancel_var", default="unset")
    entered = asyncio.Event()
    cleanup_seen: list[str] = []

    var_tok = var.set("captured")
    try:

        async def fail() -> None:
            await asyncio.sleep(0)
            raise ValueError("boom")

        async def block_until_cancelled() -> None:
            try:
                entered.set()
                await asyncio.Event().wait()
            finally:
                cleanup_seen.append(var.get())

        wrapped_fail = detached.copy_context(fail)
        wrapped_block = detached.copy_context(block_until_cancelled)
    finally:
        var.reset(var_tok)

    with pytest.raises(ValueError, match="boom"):
        await wrapped_fail()

    task = asyncio.create_task(wrapped_block())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleanup_seen == ["captured"]


def test_copy_context_preserves_metadata_and_signature_for_sync_callable() -> None:
    def sample_sync(a: int, *, b: str = "x") -> str:
        """Sync helper docstring."""
        return f"{a}:{b}"

    wrapped = detached.copy_context(sample_sync)
    assert not inspect.iscoroutinefunction(wrapped)
    assert wrapped.__name__ == "sample_sync"
    assert wrapped.__qualname__ == sample_sync.__qualname__
    assert wrapped.__doc__ == "Sync helper docstring."
    assert getattr(wrapped, "__wrapped__", None) is sample_sync
    assert inspect.signature(wrapped) == inspect.signature(sample_sync)
    assert wrapped(3, b="ok") == "3:ok"


async def test_copy_context_preserves_metadata_and_signature_for_async_callable() -> None:
    async def sample_async(a: int, *, b: str = "x") -> str:
        """Async helper docstring."""
        return f"{a}:{b}"

    wrapped = detached.copy_context(sample_async)
    assert inspect.iscoroutinefunction(wrapped)
    assert wrapped.__name__ == "sample_async"
    assert wrapped.__qualname__ == sample_async.__qualname__
    assert wrapped.__doc__ == "Async helper docstring."
    assert getattr(wrapped, "__wrapped__", None) is sample_async
    assert inspect.signature(wrapped) == inspect.signature(sample_async)
    assert await wrapped(4, b="ok") == "4:ok"


# Finding 9: proc baggage exclusion, env round-trip, and SDK-scoped forms without globals.


def test_proc_env_never_carries_or_extracts_baggage() -> None:
    with start_recorder(service_name="proc-no-bag") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("test")
        ctx = baggage.set_baggage("tenant", "acme")
        tok = context.attach(ctx)
        try:
            with tracer.start_as_current_span("parent") as sp:
                sc = sp.get_span_context()
                carrier = proc.env_carrier()
                env = proc.child_env({"PATH": "/usr/bin"})
        finally:
            context.detach(tok)

    assert set(carrier.keys()) == {proc.ENV_TRACEPARENT, proc.ENV_TRACESTATE}
    assert set(env.keys()) == {"PATH", proc.ENV_TRACEPARENT, proc.ENV_TRACESTATE}

    # Even if an environment contains BAGGAGE or baggage, extract_env ignores it.
    env_with_bag = dict(env)
    env_with_bag["BAGGAGE"] = "tenant=acme"
    env_with_bag["baggage"] = "tenant=acme"
    extracted = proc.extract_env(env_with_bag, ctx=Context())
    rx_sc = trace.get_current_span(extracted).get_span_context()
    assert rx_sc.trace_id == sc.trace_id
    assert rx_sc.span_id == sc.span_id
    assert baggage.get_all(extracted) == {}


def test_proc_child_env_and_extract_env_round_trip_traceparent_and_tracestate() -> None:
    sc = SpanContext(
        trace_id=0x0AF7651916CD43DD8448EB211C80319C,
        span_id=0xB7AD6B7169203331,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState([("vendor", "abc"), ("other", "xyz")]),
    )
    parent_ctx = trace.set_span_in_context(NonRecordingSpan(sc), Context())
    env = proc.child_env({"KEEP": "yes", "TRACESTATE": "stale=1"}, ctx=parent_ctx)
    assert env["KEEP"] == "yes"
    assert env[proc.ENV_TRACESTATE] == "vendor=abc,other=xyz"

    extracted = proc.extract_env(env, ctx=Context())
    rx_sc = trace.get_current_span(extracted).get_span_context()
    assert rx_sc.is_valid
    assert rx_sc.is_remote
    assert rx_sc.trace_id == sc.trace_id
    assert rx_sc.span_id == sc.span_id
    assert rx_sc.trace_flags == sc.trace_flags
    assert rx_sc.trace_state.get("vendor") == "abc"
    assert rx_sc.trace_state.get("other") == "xyz"


@pytest.mark.parametrize(
    "environ",
    [
        pytest.param({"TRACESTATE": "vendor=abc"}, id="unset"),
        pytest.param({"TRACEPARENT": "", "TRACESTATE": "vendor=abc"}, id="empty"),
        pytest.param(
            {"TRACEPARENT": "00-not-a-traceparent", "TRACESTATE": "vendor=abc"},
            id="invalid",
        ),
    ],
)
def test_proc_extract_env_ignores_missing_empty_and_invalid_traceparent(
    environ: dict[str, str],
) -> None:
    extracted = proc.extract_env(environ, ctx=Context())
    sc = trace.get_current_span(extracted).get_span_context()
    assert not sc.is_valid
    assert len(sc.trace_state) == 0


def _allow_tenant(key: str) -> bool:
    return key == "tenant"


def test_proc_frame_sdk_scoped_works_without_globals() -> None:
    prev = propagate.get_global_textmap()
    propagate.set_global_textmap(CompositePropagator([]))
    try:
        tel = libo11y.init(
            service_name="proc-no-globals",
            environment="test",
            env=libo11y.HERMETIC,
            console_enabled=False,
            runtime_metrics=False,
            baggage_egress_allow=_allow_tenant,
        )
        try:
            tracer = tel.tracer_provider.get_tracer("test")
            ctx = baggage.set_baggage("tenant", "acme", context=Context())
            ctx = baggage.set_baggage("secret", "drop", context=ctx)
            with tracer.start_as_current_span("send", context=ctx) as sp:
                orig_sc = sp.get_span_context()
                active_ctx = trace.set_span_in_context(sp, ctx)

                # Without telemetry=, global no-op propagator writes nothing.
                global_frame: dict[str, str] = {}
                proc.inject_frame(global_frame, ctx=active_ctx)
                assert global_frame == {}

                # With telemetry=, the init() handle's propagator runs without globals.
                frame: dict[str, str] = {}
                proc.inject_frame(frame, ctx=active_ctx, telemetry=tel)
        finally:
            tel.shutdown()

        assert "traceparent" in frame
        assert "tenant=acme" in frame.get("baggage", "")
        assert "secret" not in frame.get("baggage", "")

        # Without telemetry=, global no-op propagator extracts nothing.
        no_sdk_ctx = proc.extract_frame(frame, ctx=Context())
        assert not trace.get_current_span(no_sdk_ctx).get_span_context().is_valid

        # With telemetry=, extract_frame restores span context and baggage.
        extracted = proc.extract_frame(frame, ctx=Context(), telemetry=tel)
        rx_sc = trace.get_current_span(extracted).get_span_context()
        assert rx_sc.is_remote
        assert rx_sc.trace_id == orig_sc.trace_id
        assert rx_sc.span_id == orig_sc.span_id
        assert baggage.get_baggage("tenant", context=extracted) == "acme"
    finally:
        propagate.set_global_textmap(prev)


def test_proc_frame_sdk_scoped_honors_sdk_propagator_over_global() -> None:
    prev = propagate.get_global_textmap()
    propagate.set_global_textmap(
        CompositePropagator([TraceContextTextMapPropagator(), W3CBaggagePropagator()])
    )
    try:
        tel = libo11y.init(
            service_name="proc-trace-only",
            environment="test",
            env=libo11y.HERMETIC,
            console_enabled=False,
            runtime_metrics=False,
            propagators=[TraceContextTextMapPropagator()],
        )
        try:
            tracer = tel.tracer_provider.get_tracer("test")
            ctx = baggage.set_baggage("tenant", "acme", context=Context())
            with tracer.start_as_current_span("send", context=ctx) as sp:
                active_ctx = trace.set_span_in_context(sp, ctx)
                frame: dict[str, str] = {}
                proc.inject_frame(frame, ctx=active_ctx, telemetry=tel)
            assert "traceparent" in frame
            assert "baggage" not in frame

            extracted = proc.extract_frame(
                {"traceparent": frame["traceparent"], "baggage": "tenant=acme"},
                ctx=Context(),
                telemetry=tel,
            )
            assert trace.get_current_span(extracted).get_span_context().is_valid
            assert baggage.get_all(extracted) == {}
        finally:
            tel.shutdown()
    finally:
        propagate.set_global_textmap(prev)


def test_detached_sdk_scoped_capture_and_start_linked_work_without_globals() -> None:
    prev = propagate.get_global_textmap()
    propagate.set_global_textmap(CompositePropagator([]))
    exporter = InMemorySpanExporter()
    try:
        tel = libo11y.init(
            service_name="detached-no-globals",
            environment="test",
            env=libo11y.HERMETIC,
            console_enabled=False,
            runtime_metrics=False,
            span_processor=SimpleSpanProcessor(exporter),
            baggage_egress_allow=_allow_tenant,
        )
        try:
            tracer = tel.tracer_provider.get_tracer("test")
            ctx = baggage.set_baggage("tenant", "acme", context=Context())
            ctx = baggage.set_baggage("dropped", "secret", context=ctx)
            with tracer.start_as_current_span("origin", context=ctx) as origin:
                orig_sc = origin.get_span_context()
                active_ctx = trace.set_span_in_context(origin, ctx)
                carrier = detached.capture(active_ctx, telemetry=tel)

            with detached.start_linked(carrier, "detached-job", ctx=Context(), telemetry=tel) as sp:
                job_sc = sp.get_span_context()
                assert job_sc.trace_id != orig_sc.trace_id
                assert baggage.get_baggage("tenant") == "acme"
                assert baggage.get_baggage("dropped") is None
        finally:
            tel.shutdown()

        spans = {s.name: s for s in exporter.get_finished_spans()}
        job = spans["detached-job"]
        assert job.parent is None
        assert len(job.links) == 1
        assert job.links[0].context.trace_id == orig_sc.trace_id
        assert job.links[0].context.span_id == orig_sc.span_id
    finally:
        propagate.set_global_textmap(prev)
