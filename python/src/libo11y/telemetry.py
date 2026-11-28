"""Core Telemetry handle, setup(), init(), effective config, canary, and shutdown."""

from __future__ import annotations

import asyncio
import logging
import math
import sys
import threading
import time
from collections.abc import Callable, Mapping, MutableMapping
from contextlib import suppress
from contextvars import copy_context
from dataclasses import dataclass, fields
from functools import partial
from types import MappingProxyType, TracebackType
from typing import Any

from opentelemetry import propagate
from opentelemetry.context import Context
from opentelemetry.propagators.textmap import TextMapPropagator
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

from libo11y._internal.endpoint import sanitize_endpoint
from libo11y._internal.env import EnvView
from libo11y._internal.exporters import ExportFailures, check_export_selection, shutdown_exporter
from libo11y._internal.logging_handler import O11yLoggingHandler, default_error_handler
from libo11y._internal.logs_bridge import (
    GlobalLoggerProvider,
    LoggerProvider,
    build_logger_provider,
    register_global_providers,
)
from libo11y._internal.metrics_bridge import (
    GlobalMeterProvider,
    PolicyMeterProvider,
    build_meter_provider,
)
from libo11y._internal.policy import SensitivityPolicy, ViolationRecorder, load_app_registries
from libo11y._internal.propagators import build_propagator
from libo11y._internal.resource import build_resource
from libo11y._internal.runtime_metrics import register_runtime_metrics
from libo11y._internal.trace_bridge import GlobalTracerProvider, build_tracer_provider
from libo11y.errors import AlreadySetup, CanaryRejected, InvalidOption, O11yError
from libo11y.options import ConsoleFormat, Options, level_name, parse_log_level, validate_options
from libo11y.spec import (
    ATTR_RULE,
    ATTR_SIGNAL,
    EVENT_NAME_KEY,
    EVENT_TELEMETRY_CONFIGURED,
    EVENT_TELEMETRY_DROPPED,
    METRIC_SCHEMA_VIOLATIONS,
    Signal,
)

_GLOBAL_LOCK = threading.Lock()
_global_telemetry: Telemetry | None = None
_global_setup_in_progress = False
_GLOBAL_TRACES = GlobalTracerProvider()
_GLOBAL_METERS = GlobalMeterProvider()
_GLOBAL_LOGS = GlobalLoggerProvider()
_DIAGNOSTIC_GRACE = 0.01
_ABANDON_GRACE = 0.1

type _SignalStep = Callable[[int], bool | None]


@dataclass(frozen=True, slots=True)
class ShutdownReport:
    """Per-signal outcome of Telemetry.shutdown() or Telemetry.force_flush()."""

    errors: Mapping[str, Exception]
    timed_out: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return len(self.errors) == 0 and len(self.timed_out) == 0

    def __bool__(self) -> bool:
        return self.ok


def _report(errors: dict[str, Exception], timed_out: tuple[str, ...] = ()) -> ShutdownReport:
    return ShutdownReport(MappingProxyType(errors), timed_out)


def _remaining(deadline: float) -> float:
    return min(max(deadline - time.monotonic(), 0.0), threading.TIMEOUT_MAX)


def _millis_remaining(deadline: float) -> int:
    return math.ceil(_remaining(deadline) * 1000)


def _run_steps(
    operation: str,
    steps: Mapping[str, _SignalStep],
    deadline: float,
    failures: Mapping[str, ExportFailures] | None = None,
) -> ShutdownReport:
    """Run signal operations in parallel and observe exports while they run."""
    completed: dict[str, tuple[float, Exception | None]] = {}
    lock = threading.Lock()
    windows = {name: observer.open() for name, observer in (failures or {}).items()}

    def run(name: str, step: _SignalStep) -> None:
        error = None
        try:
            if step(_millis_remaining(deadline)) is False:
                error = O11yError(f"o11y: {name} {operation} did not complete")
        except Exception as exc:
            error = exc
        finally:
            cause = sys.exception()
            if cause is not None and not isinstance(cause, Exception):
                error = O11yError(f"o11y: {name} {operation} interrupted by {type(cause).__name__}")
                error.__cause__ = cause
            with lock:
                completed[name] = (time.monotonic(), error)

    threads: list[threading.Thread] = []
    try:
        for name, step in steps.items():
            thread = threading.Thread(
                target=run, args=(name, step), name=f"libo11y-{operation}-{name}", daemon=True
            )
            try:
                thread.start()
            except Exception as exc:
                with lock:
                    completed[name] = (time.monotonic(), exc)
            else:
                threads.append(thread)
        for thread in threads:
            thread.join(_remaining(deadline))
    finally:
        if failures is not None:
            for name, window in windows.items():
                failures[name].close(window)

    errors: dict[str, Exception] = {}
    timed_out: list[str] = []
    with lock:
        results = dict(completed)
    for name in steps:
        finished, error = results.get(name, (math.inf, None))
        if finished > deadline:
            timed_out.append(name)
            error = TimeoutError(f"o11y: {name} {operation} exceeded deadline")
        window = windows.get(name)
        if window is not None:
            error = window.join(error)
        if error is not None:
            errors[name] = error
    return _report(errors, tuple(timed_out))


def _stop_all(steps: tuple[_SignalStep, ...], timeout_millis: int) -> None:
    deadline = time.monotonic() + timeout_millis / 1000
    errors: list[Exception] = []
    for step in steps:
        try:
            step(_millis_remaining(deadline))
        except Exception as exc:
            errors.append(exc)
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise ExceptionGroup("o11y: stopping telemetry components", errors)


def _injected_components(opts: Options) -> dict[str, tuple[_SignalStep, ...]]:
    traces: list[_SignalStep] = []
    if opts.span_processor is not None:
        stop_processor = opts.span_processor.shutdown
        traces.append(lambda _: stop_processor())
    if opts.span_exporter is not None:
        traces.append(partial(shutdown_exporter, opts.span_exporter.shutdown))
    reader = opts.metric_reader
    metrics: tuple[_SignalStep, ...] = ()
    if reader is not None:
        # The upstream reader leaves its unused variadic keywords untyped.
        metrics = (lambda millis: reader.shutdown(millis),)  # pyright: ignore[reportUnknownMemberType]
    return {
        "traces": tuple(traces),
        "metrics": metrics,
        "logs": (
            (partial(shutdown_exporter, opts.log_exporter.shutdown),)
            if opts.log_exporter is not None
            else ()
        ),
    }


def _shutdown_steps(ownership: Mapping[str, tuple[_SignalStep, ...]]) -> dict[str, _SignalStep]:
    return {name: partial(_stop_all, steps) for name, steps in ownership.items() if steps}


def _discard(
    ownership: Mapping[str, tuple[_SignalStep, ...]],
    failures: Mapping[str, ExportFailures] | None = None,
) -> None:
    for observer in (failures or {}).values():
        observer.abandoned = True
    _run_steps("abandon", _shutdown_steps(ownership), time.monotonic() + _ABANDON_GRACE)


def _merge_options(options: Options | None, kwargs: dict[str, Any]) -> Options:
    valid_names = {f.name for f in fields(Options)}
    for k in kwargs:
        if k not in valid_names:
            raise InvalidOption(k, "unexpected option keyword argument")
    if options is None:
        return Options(**kwargs)
    if not kwargs:
        return options
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

    attrs: dict[str, str] = {"service.name": svc_name}
    if svc_ver:
        attrs["service.version"] = svc_ver
    attrs["o11y.config.traces"] = traces_kind
    attrs["o11y.config.metrics"] = metrics_kind
    attrs["o11y.config.logs"] = logs_kind
    attrs["o11y.config.console"] = console
    attrs["o11y.config.level"] = level_name(level)
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
        failures: Mapping[str, ExportFailures],
        ownership: Mapping[str, tuple[_SignalStep, ...]],
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
        self._failures = failures
        self._ownership = ownership
        self._is_global = is_global
        self._root_handler_attached = False
        self._prev_root_level: int | None = None
        self._prev_global_propagator: TextMapPropagator | None = None

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
        """Emit an event past the configured log level gate."""
        cleaned: dict[str, Any] = {EVENT_NAME_KEY: name}
        if attributes:
            for k, v in attributes.items():
                if k != EVENT_NAME_KEY:
                    cleaned[k] = v

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

    def _detach_logging(self) -> None:
        if self._root_handler_attached:
            root = logging.getLogger()
            root.removeHandler(self._handler)
            if self._prev_root_level is not None:
                root.setLevel(self._prev_root_level)
            self._root_handler_attached = False

    def _detach_globals(self) -> None:
        if self._is_global:
            with _GLOBAL_LOCK:
                _GLOBAL_TRACES.unbind(self.tracer_provider)
                _GLOBAL_METERS.unbind(self.meter_provider)
                _GLOBAL_LOGS.unbind(self.logger_provider)
                if self._prev_global_propagator is not None:
                    propagate.set_global_textmap(self._prev_global_propagator)
                    self._prev_global_propagator = None

    def _activate_globals(self, cfg_attrs: Mapping[str, str], run_canary: bool) -> None:
        if run_canary:
            self._emit_canary(cfg_attrs)

        register_global_providers(_GLOBAL_TRACES, _GLOBAL_METERS, _GLOBAL_LOGS, install=True)
        _GLOBAL_METERS.bind(self.meter_provider)
        _GLOBAL_TRACES.bind(self.tracer_provider)
        _GLOBAL_LOGS.bind(self.logger_provider)
        self._prev_global_propagator = propagate.get_global_textmap()
        propagate.set_global_textmap(self.propagator)

        root_logger = logging.getLogger()
        self._prev_root_level = root_logger.level
        if root_logger.level == logging.NOTSET or root_logger.level > self._handler.min_level:
            root_logger.setLevel(self._handler.min_level)
        root_logger.addHandler(self._handler)
        self._root_handler_attached = True

    @property
    def shutdown_timeout(self) -> float:
        """The default shutdown and flush timeout in seconds."""
        return self._shutdown_timeout

    def _budget(self, timeout: float | None) -> float:
        budget = self._shutdown_timeout if timeout is None else timeout
        if not math.isfinite(budget) or budget < 0:
            raise ValueError("timeout must be finite and non-negative")
        return budget

    def _deadline(self, timeout: float | None) -> float:
        return time.monotonic() + self._budget(timeout)

    def _emit_dropped(self, report: ShutdownReport, deadline: float) -> None:
        if report.ok:
            return

        def emit() -> None:
            for name, cause in report.errors.items():
                self.event(
                    EVENT_TELEMETRY_DROPPED,
                    {ATTR_SIGNAL: name, "error.type": type(cause).__name__},
                )

        context = copy_context()
        thread = threading.Thread(
            target=context.run, args=(emit,), name="libo11y-dropped-events", daemon=True
        )
        thread.start()
        thread.join(min(_remaining(deadline) + _DIAGNOSTIC_GRACE, threading.TIMEOUT_MAX))

    def force_flush(self, timeout: float | None = None) -> ShutdownReport:
        """Flush buffered telemetry concurrently and report any per-signal failures."""
        deadline = self._deadline(timeout)
        report = _run_steps(
            "force flush",
            {
                "traces": self.tracer_provider.force_flush,
                "metrics": self.meter_provider.force_flush,
                "logs": self.logger_provider.force_flush,
            },
            deadline,
            self._failures,
        )
        self._emit_dropped(report, deadline)
        return report

    def shutdown(self, timeout: float | None = None) -> ShutdownReport:
        """Stop all signals under one deadline and publish the result once.

        Concurrent callers may time out while waiting for the first caller.
        Work that exceeds the deadline continues on a daemon thread.
        """
        global _global_telemetry
        budget = self._budget(timeout)
        with self._shutdown_lock:
            is_leader = not self._shutdown_started
            self._shutdown_started = True
        deadline = time.monotonic() + budget

        if not is_leader:
            if not self._shutdown_done.is_set():
                self._shutdown_done.wait(_remaining(deadline))
            if self._shutdown_report is not None:
                return self._shutdown_report
            return _report({"shutdown": TimeoutError("o11y: timed out waiting for shutdown")})

        report = _report({"shutdown": O11yError("o11y: shutdown interrupted")})
        try:
            self._detach_globals()
            report = _run_steps(
                "shutdown", _shutdown_steps(self._ownership), deadline, self._failures
            )
            self._emit_dropped(report, deadline)
        except Exception as exc:
            errors = dict(report.errors)
            errors["shutdown"] = exc
            report = _report(errors, report.timed_out)
        finally:
            try:
                self._detach_logging()
            finally:
                with _GLOBAL_LOCK:
                    if _global_telemetry is self:
                        _global_telemetry = None
                    self._shutdown_report = report
                    self._shutdown_done.set()
        return report

    def _abandon(self) -> None:
        """Release a handle whose setup failed before it reached the caller."""
        try:
            self._detach_globals()
            self._detach_logging()
        finally:
            _discard(self._ownership, self._failures)

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


def _assemble_telemetry(
    opts: Options,
    *,
    is_global: bool,
    ownership: dict[str, tuple[_SignalStep, ...]],
    failures: dict[str, ExportFailures],
) -> tuple[Telemetry, dict[str, str]]:
    validate_options(opts)
    env = EnvView(opts.env)
    disabled = env.sdk_disabled()
    if not disabled:
        configured: list[str] = []
        if opts.span_exporter is None and opts.span_processor is None:
            configured.append("TRACES")
        if opts.metric_reader is None:
            configured.append("METRICS")
        if opts.log_export and opts.log_exporter is None:
            configured.append("LOGS")
        check_export_selection(env, configured)

    app_classes = load_app_registries(opts.app_registry)
    recorder = ViolationRecorder()
    policy = SensitivityPolicy(
        pii_mode=opts.pii_mode,
        pii_hash_key=opts.pii_hash_key,
        app_classes=app_classes,
        recorder=recorder,
    )

    resource, version_fallback = build_resource(opts, env, policy, recorder)
    propagator = build_propagator(opts.propagators, opts.baggage_egress_allow, env)

    traces = build_tracer_provider(opts, env, resource, policy, disabled)
    failures["traces"] = traces.failures
    ownership["traces"] = (
        lambda _: traces.provider.shutdown(),
        *(ownership["traces"] if disabled else ()),
    )
    if disabled and ownership["metrics"]:
        # Periodic readers start their own worker before registration.
        _discard({"metrics": ownership["metrics"]})
        ownership["metrics"] = ()
    meters = build_meter_provider(opts, env, resource, policy, disabled)
    failures["metrics"] = meters.failures
    # The SDK skips shutting down readers outright with a zero timeout.
    ownership["metrics"] = (lambda millis: meters.provider.shutdown(max(1, millis)),)
    logs = build_logger_provider(opts, env, resource, policy, disabled)
    failures["logs"] = logs.failures
    ownership["logs"] = (
        lambda _: logs.provider.shutdown(),
        *(ownership["logs"] if disabled or not opts.log_export else ()),
    )
    tracer_provider = traces.provider
    meter_provider = meters.provider
    logger_provider = logs.provider

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
        traces_kind=traces.exporter_kind,
        metrics_kind=meters.exporter_kind,
        logs_kind=logs.exporter_kind,
        sampler_desc=traces.sampler,
        level=level,
        prop_fields=propagator.fields,
        version_fallback=version_fallback,
        disabled=disabled,
    )

    tel = Telemetry(
        tracer_provider=tracer_provider,
        meter_provider=meter_provider,
        logger_provider=logger_provider,
        resource=resource,
        propagator=propagator.propagator,
        handler=handler,
        effective_config=cfg_line,
        shutdown_timeout=opts.shutdown_timeout,
        failures=failures,
        ownership=ownership,
        is_global=is_global,
    )
    return tel, cfg_attrs


def _build_telemetry(opts: Options, *, is_global: bool) -> tuple[Telemetry, dict[str, str]]:
    ownership = _injected_components(opts)
    failures: dict[str, ExportFailures] = {}
    complete = False
    try:
        result = _assemble_telemetry(
            opts, is_global=is_global, ownership=ownership, failures=failures
        )
        complete = True
        return result
    finally:
        if not complete:
            with suppress(Exception):
                _discard(ownership, failures)


def init(options: Options | None = None, **kwargs: Any) -> Telemetry:
    """Build an isolated Telemetry handle without installing process globals."""
    try:
        opts = _merge_options(options, kwargs)
        tel, _ = _build_telemetry(opts, is_global=False)
    except O11yError:
        raise
    except Exception as exc:
        raise O11yError(f"o11y: creating telemetry: {exc}") from exc
    return tel


def setup(options: Options | None = None, **kwargs: Any) -> Telemetry:
    """Build a Telemetry handle, install OTel globals and root logging, and run the canary.

    Raises AlreadySetup if a global Telemetry handle is already active or being set up.
    """
    global _global_telemetry, _global_setup_in_progress
    with _GLOBAL_LOCK:
        already_setup = _global_telemetry is not None or _global_setup_in_progress
        if not already_setup:
            _global_setup_in_progress = True

    tel: Telemetry | None = None
    succeeded = False
    try:
        opts = _merge_options(options, kwargs)
        if already_setup:
            _discard(_injected_components(opts))
            raise AlreadySetup()
        try:
            register_global_providers(_GLOBAL_TRACES, _GLOBAL_METERS, _GLOBAL_LOGS, install=False)
        except Exception:
            _discard(_injected_components(opts))
            raise
        tel, cfg_attrs = _build_telemetry(opts, is_global=True)
        tel._activate_globals(cfg_attrs, run_canary=opts.startup_summary)  # pyright: ignore[reportPrivateUsage]
        with _GLOBAL_LOCK:
            _global_telemetry = tel
        succeeded = True
        return tel
    except O11yError:
        raise
    except Exception as exc:
        raise O11yError(f"o11y: setting up telemetry: {exc}") from exc
    finally:
        try:
            if tel is not None and not succeeded:
                with suppress(Exception):
                    tel._abandon()  # pyright: ignore[reportPrivateUsage]
        finally:
            if not already_setup:
                with _GLOBAL_LOCK:
                    _global_setup_in_progress = False
