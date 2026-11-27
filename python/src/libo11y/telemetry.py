"""Core Telemetry handle, setup(), init(), effective config, canary, and shutdown."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Callable, Mapping, MutableMapping
from dataclasses import dataclass, fields
from types import MappingProxyType, TracebackType
from typing import Any

from opentelemetry import metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.propagators.textmap import TextMapPropagator
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

from libo11y._internal.endpoint import sanitize_endpoint
from libo11y._internal.env import EnvView
from libo11y._internal.logging_handler import O11yLoggingHandler, default_error_handler
from libo11y._internal.logs_bridge import build_logger_provider
from libo11y._internal.metrics_bridge import PolicyMeterProvider, build_meter_provider
from libo11y._internal.policy import SensitivityPolicy, ViolationRecorder, load_app_registries
from libo11y._internal.propagators import build_propagator, propagator_fields_str
from libo11y._internal.resource import build_resource
from libo11y._internal.runtime_metrics import register_runtime_metrics
from libo11y._internal.trace_bridge import build_tracer_provider
from libo11y.errors import AlreadySetup, CanaryRejected
from libo11y.options import ConsoleFormat, Options, parse_log_level
from libo11y.spec import (
    ATTR_RULE,
    ATTR_SIGNAL,
    EVENT_NAME_KEY,
    EVENT_TELEMETRY_CONFIGURED,
    EVENT_TELEMETRY_DROPPED,
    EVENTS,
    METRIC_SCHEMA_VIOLATIONS,
    Signal,
)

_GLOBAL_LOCK = threading.Lock()
_global_telemetry: Telemetry | None = None
_global_setup_in_progress = False


@dataclass(frozen=True, slots=True)
class ShutdownReport:
    """Per-signal outcome of Telemetry.shutdown()."""

    errors: Mapping[str, Exception]
    timed_out: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return len(self.errors) == 0 and len(self.timed_out) == 0


def _merge_options(options: Options | None, kwargs: dict[str, Any]) -> Options:
    if options is None:
        return Options(**kwargs)
    if not kwargs:
        return options
    valid_names = {f.name for f in fields(Options)}
    for k in kwargs:
        if k not in valid_names:
            raise TypeError(f"unexpected option keyword argument {k!r}")
    merged = {f.name: getattr(options, f.name) for f in fields(Options)}
    merged.update(kwargs)
    return Options(**merged)


def _build_effective_config(
    *,
    resource: Resource,
    opts: Options,
    env: EnvView,
    traces_kind: str,
    metrics_kind: str,
    logs_kind: str,
    sampler_desc: str,
    level: int,
    prop_fields: str,
    version_fallback: bool,
    disabled: bool,
) -> tuple[dict[str, str], str]:
    svc_name = str(resource.attributes.get("service.name", ""))
    svc_ver = str(resource.attributes.get("service.version", ""))

    if disabled:
        traces_kind, metrics_kind, logs_kind = "none", "none", "none"

    if not opts.console_enabled:
        console = "off"
    elif opts.console_format is ConsoleFormat.TEXT:
        console = "text"
    else:
        console = "json"

    level_name = str(logging.getLevelName(level))

    attrs: dict[str, str] = {"service.name": svc_name}
    if svc_ver:
        attrs["service.version"] = svc_ver
    attrs["o11y.config.traces"] = traces_kind
    attrs["o11y.config.metrics"] = metrics_kind
    attrs["o11y.config.logs"] = logs_kind
    attrs["o11y.config.console"] = console
    attrs["o11y.config.level"] = level_name
    attrs["o11y.config.sampler"] = sampler_desc
    attrs["o11y.config.propagators"] = prop_fields
    attrs["o11y.config.runtime_metrics"] = (
        "true" if (opts.runtime_metrics and not disabled) else "false"
    )
    if version_fallback:
        attrs["o11y.config.service_version_fallback"] = "true"

    for key, env_name in (
        ("endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT"),
        ("traces_endpoint", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        ("metrics_endpoint", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
        ("logs_endpoint", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
    ):
        raw = env.get_opt(env_name)
        if raw is not None:
            attrs[f"o11y.config.{key}"] = sanitize_endpoint(raw)

    line = " ".join(f"{k}={v}" for k, v in attrs.items())
    return attrs, line


class Telemetry:
    """Owned handle to a libo11y OpenTelemetry SDK instance."""

    def __init__(
        self,
        *,
        tracer_provider: TracerProvider,
        meter_provider: PolicyMeterProvider,
        logger_provider: LoggerProvider,
        resource: Resource,
        propagator: TextMapPropagator,
        handler: O11yLoggingHandler,
        effective_config: str,
        shutdown_timeout: float,
        recorder: ViolationRecorder,
        is_global: bool,
    ) -> None:
        self._tracer_provider = tracer_provider
        self._meter_provider = meter_provider
        self._logger_provider = logger_provider
        self._resource = resource
        self._propagator = propagator
        self._handler = handler
        self._effective_config = effective_config
        self._shutdown_timeout = shutdown_timeout
        self._recorder = recorder
        self._is_global = is_global
        self._root_handler_attached = False
        self._prev_root_level: int | None = None

        self._shutdown_lock = threading.Lock()
        self._shutdown_done = threading.Event()
        self._shutdown_started = False
        self._shutdown_report: ShutdownReport | None = None

    @property
    def tracer_provider(self) -> TracerProvider:
        return self._tracer_provider

    @property
    def meter_provider(self) -> PolicyMeterProvider:
        return self._meter_provider

    @property
    def logger_provider(self) -> LoggerProvider:
        return self._logger_provider

    @property
    def resource(self) -> Resource:
        return self._resource

    @property
    def propagator(self) -> TextMapPropagator:
        return self._propagator

    def logging_handler(self) -> logging.Handler:
        """Return the libo11y logging.Handler bound to this Telemetry instance."""
        return self._handler

    def effective_config(self) -> str:
        """Return the single-line summary of resolved configuration."""
        return self._effective_config

    def inject(
        self,
        carrier: MutableMapping[str, str],
        context: Context | None = None,
    ) -> None:
        """Inject active (or explicit) context into carrier without relying on globals."""
        carrier_any: Any = carrier
        self._propagator.inject(carrier_any, context=context)

    def extract(
        self,
        carrier: Mapping[str, str],
        context: Context | None = None,
    ) -> Context:
        """Extract context from carrier without relying on globals."""
        return self._propagator.extract(carrier, context=context)

    def event(
        self,
        name: str,
        attributes: Mapping[str, Any] | None = None,
        *,
        level: int = logging.INFO,
    ) -> None:
        """Emit a contract-bearing event, force-emitted past level gates.

        Registered events are checked against EVENTS; missing required keys or
        templates increment o11y.schema.violations on the logs signal.
        """
        cleaned: dict[str, Any] = {EVENT_NAME_KEY: name}
        if attributes:
            for k, v in attributes.items():
                if k != EVENT_NAME_KEY:
                    cleaned[k] = v

        contract = EVENTS.get(name)
        if contract is not None:
            for req_key in contract.required:
                if req_key not in cleaned:
                    self._recorder.record(Signal.LOGS, f"missing_event_attribute:{req_key}")
            for tpl in contract.required_templates:
                prefix = f"{tpl}."
                if not any(k.startswith(prefix) for k in cleaned):
                    self._recorder.record(Signal.LOGS, f"missing_event_template:{tpl}")

        self._handler.emit_checked(
            level=level,
            message=name,
            attributes=cleaned,
            raise_on_error=False,
        )

    def _emit_canary(self, attrs: Mapping[str, str]) -> None:
        payload: dict[str, Any] = {EVENT_NAME_KEY: EVENT_TELEMETRY_CONFIGURED}
        payload.update(attrs)
        try:
            self._handler.emit_checked(
                level=logging.INFO,
                message=EVENT_TELEMETRY_CONFIGURED,
                attributes=payload,
                raise_on_error=True,
            )
        except Exception as exc:
            raise CanaryRejected(f"o11y: startup canary rejected by sink: {exc}") from exc

    def _detach_globals(self) -> None:
        global _global_telemetry
        if self._root_handler_attached:
            root = logging.getLogger()
            root.removeHandler(self._handler)
            if self._prev_root_level is not None:
                root.setLevel(self._prev_root_level)
            self._root_handler_attached = False
        if self._is_global:
            with _GLOBAL_LOCK:
                if _global_telemetry is self:
                    _global_telemetry = None

    def _activate_globals(self, cfg_attrs: Mapping[str, str], run_canary: bool) -> None:
        if run_canary:
            try:
                self._emit_canary(cfg_attrs)
            except Exception:
                self.shutdown(timeout=1.0)
                raise

        trace_once: Any = getattr(trace, "_TRACER_PROVIDER_SET_ONCE", None)
        if trace_once is not None:
            trace_once._done = False
        trace.set_tracer_provider(self.tracer_provider)

        metrics_internal: Any = getattr(metrics, "_internal", None)
        if metrics_internal is not None:
            meter_once: Any = getattr(metrics_internal, "_METER_PROVIDER_SET_ONCE", None)
            if meter_once is not None:
                meter_once._done = False
        metrics.set_meter_provider(self.meter_provider)
        propagate.set_global_textmap(self.propagator)

        root_logger = logging.getLogger()
        self._prev_root_level = root_logger.level
        if root_logger.level == logging.NOTSET or root_logger.level > self._handler.min_level:
            root_logger.setLevel(self._handler.min_level)
        root_logger.addHandler(self._handler)
        self._root_handler_attached = True

    def force_flush(self, timeout: float | None = None) -> bool:
        """Flush buffered spans, metrics, and logs within timeout seconds."""
        deadline_ms = max(
            int((self._shutdown_timeout if timeout is None else max(timeout, 0.0)) * 1000),
            1,
        )
        ok_t = self._tracer_provider.force_flush(timeout_millis=deadline_ms)
        ok_m = self._meter_provider.force_flush(timeout_millis=deadline_ms)
        ok_l = self._logger_provider.force_flush(timeout_millis=deadline_ms)
        return bool(ok_t and ok_m and ok_l)

    def shutdown(self, timeout: float | None = None) -> ShutdownReport:
        """Flush and shut down all three signals concurrently under one deadline.

        Idempotent: concurrent and subsequent callers receive the exact same
        ShutdownReport. A signal that misses the deadline keeps flushing on a
        daemon thread and is reported in report.timed_out.
        """
        with self._shutdown_lock:
            if self._shutdown_started:
                is_leader = False
            else:
                self._shutdown_started = True
                is_leader = True

        if not is_leader:
            self._shutdown_done.wait()
            assert self._shutdown_report is not None
            return self._shutdown_report

        deadline_sec = self._shutdown_timeout if timeout is None else max(timeout, 0.0)
        deadline_ms = max(int(deadline_sec * 1000), 1)
        end_monotonic = time.monotonic() + deadline_sec

        errors: dict[str, Exception] = {}
        err_lock = threading.Lock()

        def _run_signal(sig_name: str, fn: Callable[[], None]) -> None:
            try:
                fn()
            except Exception as exc:
                with err_lock:
                    errors[sig_name] = exc

        threads: dict[str, threading.Thread] = {
            "traces": threading.Thread(
                target=_run_signal,
                args=("traces", self._tracer_provider.shutdown),
                name="libo11y-shutdown-traces",
                daemon=True,
            ),
            "metrics": threading.Thread(
                target=_run_signal,
                args=("metrics", lambda: self._meter_provider.shutdown(timeout_millis=deadline_ms)),
                name="libo11y-shutdown-metrics",
                daemon=True,
            ),
            "logs": threading.Thread(
                target=_run_signal,
                args=("logs", self._logger_provider.shutdown),
                name="libo11y-shutdown-logs",
                daemon=True,
            ),
        }

        for t in threads.values():
            t.start()

        timed_out: list[str] = []
        for sig_name, t in threads.items():
            remaining = max(end_monotonic - time.monotonic(), 0.0)
            t.join(timeout=remaining)
            if t.is_alive():
                timed_out.append(sig_name)

        with err_lock:
            final_errors = dict(errors)

        for sig_name in timed_out:
            if sig_name not in final_errors:
                final_errors[sig_name] = TimeoutError(
                    f"o11y: {sig_name} shutdown exceeded deadline of {deadline_sec:.3f}s"
                )

        # Best-effort dropped-telemetry event on surviving sinks.
        for sig_name, cause in final_errors.items():
            self._handler.emit_checked(
                level=logging.WARNING,
                message=EVENT_TELEMETRY_DROPPED,
                attributes={
                    EVENT_NAME_KEY: EVENT_TELEMETRY_DROPPED,
                    ATTR_SIGNAL: sig_name,
                    "error.type": type(cause).__name__,
                },
                raise_on_error=False,
            )

        self._detach_globals()
        report = ShutdownReport(
            errors=MappingProxyType(final_errors),
            timed_out=tuple(timed_out),
        )
        self._shutdown_report = report
        self._shutdown_done.set()
        return report

    async def ashutdown(self, timeout: float | None = None) -> ShutdownReport:
        """Run shutdown() on a worker thread without blocking the asyncio event loop."""
        return await asyncio.to_thread(self.shutdown, timeout)

    def __enter__(self) -> Telemetry:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        del exc_type, exc_val, exc_tb
        self.shutdown()

    async def __aenter__(self) -> Telemetry:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        del exc_type, exc_val, exc_tb
        await self.ashutdown()


def _build_telemetry(opts: Options, *, is_global: bool) -> tuple[Telemetry, dict[str, str]]:
    env = EnvView(opts.env)
    disabled = env.sdk_disabled()

    app_classes = load_app_registries(opts.app_registry)
    recorder = ViolationRecorder()
    policy = SensitivityPolicy(
        pii_mode=opts.pii_mode,
        pii_hash_key=opts.pii_hash_key,
        app_classes=app_classes,
        recorder=recorder,
    )

    resource, version_fallback = build_resource(opts, env, policy, recorder)
    propagator = build_propagator(opts.propagators, opts.baggage_egress_allow)

    tracer_provider, traces_kind, sampler_desc = build_tracer_provider(
        opts, env, resource, policy, disabled
    )
    meter_provider, metrics_kind = build_meter_provider(opts, env, resource, policy, disabled)
    logger_provider, logs_kind = build_logger_provider(opts, env, resource, policy, disabled)

    # Wire the violation counter onto the policy's ViolationRecorder.
    violation_counter = meter_provider.sdk_provider.get_meter("libo11y").create_counter(
        name=METRIC_SCHEMA_VIOLATIONS,
        unit="{violation}",
        description="Schema and sensitivity policy violations observed by libo11y.",
    )
    err_handler = opts.error_handler if opts.error_handler is not None else default_error_handler

    def _record_violation(sig: Signal, rule: str) -> None:
        try:
            violation_counter.add(1, {ATTR_SIGNAL: str(sig), ATTR_RULE: rule})
        except Exception as exc:
            err_handler(exc)

    recorder.attach(_record_violation)

    if opts.runtime_metrics and not disabled:
        register_runtime_metrics(meter_provider.sdk_provider)

    level = parse_log_level(opts.log_level)
    handler = O11yLoggingHandler(
        level=level,
        policy=policy,
        logger_provider=logger_provider,
        console_enabled=opts.console_enabled,
        console_writer=opts.console_writer,
        console_format=opts.console_format,
        log_export=opts.log_export and not disabled,
        attr_replacer=opts.attr_replacer,
        extra_handlers=opts.extra_log_handlers,
        error_handler=err_handler,
    )

    cfg_attrs, cfg_line = _build_effective_config(
        resource=resource,
        opts=opts,
        env=env,
        traces_kind=traces_kind,
        metrics_kind=metrics_kind,
        logs_kind=logs_kind,
        sampler_desc=sampler_desc,
        level=level,
        prop_fields=propagator_fields_str(propagator),
        version_fallback=version_fallback,
        disabled=disabled,
    )

    tel = Telemetry(
        tracer_provider=tracer_provider,
        meter_provider=meter_provider,
        logger_provider=logger_provider,
        resource=resource,
        propagator=propagator,
        handler=handler,
        effective_config=cfg_line,
        shutdown_timeout=opts.shutdown_timeout,
        recorder=recorder,
        is_global=is_global,
    )
    return tel, cfg_attrs


def init(options: Options | None = None, **kwargs: Any) -> Telemetry:
    """Build an isolated Telemetry handle without installing process globals."""
    opts = _merge_options(options, kwargs)
    tel, _ = _build_telemetry(opts, is_global=False)
    return tel


def setup(options: Options | None = None, **kwargs: Any) -> Telemetry:
    """Build a Telemetry handle, install OTel globals and root logging, and run the canary.

    Raises AlreadySetup if a global Telemetry handle is already active or being set up.
    """
    global _global_telemetry, _global_setup_in_progress
    opts = _merge_options(options, kwargs)

    with _GLOBAL_LOCK:
        if _global_telemetry is not None or _global_setup_in_progress:
            raise AlreadySetup()
        _global_setup_in_progress = True

    try:
        tel, cfg_attrs = _build_telemetry(opts, is_global=True)
        tel._activate_globals(cfg_attrs, run_canary=opts.startup_summary)  # pyright: ignore[reportPrivateUsage]
    except Exception:
        with _GLOBAL_LOCK:
            _global_setup_in_progress = False
        raise

    with _GLOBAL_LOCK:
        _global_telemetry = tel
        _global_setup_in_progress = False
    return tel
