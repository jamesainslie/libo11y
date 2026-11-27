"""Configuration options, sentinels, and enums for libo11y setup and init."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final, TextIO

from opentelemetry.propagators.textmap import TextMapPropagator
from opentelemetry.sdk.metrics import ExemplarFilter
from opentelemetry.sdk.metrics.export import MetricReader
from opentelemetry.sdk.metrics.view import View
from opentelemetry.sdk.trace import SpanProcessor
from opentelemetry.sdk.trace.export import SpanExporter
from opentelemetry.sdk.trace.sampling import Sampler


class _HermeticEnv(Mapping[str, str]):
    """Sentinel empty mapping selecting hermetic mode (no os.environ reads)."""

    def __getitem__(self, key: str) -> str:
        raise KeyError(key)

    def __iter__(self) -> Any:
        return iter(())

    def __len__(self) -> int:
        return 0

    def __repr__(self) -> str:
        return "libo11y.HERMETIC"


HERMETIC: Final[Mapping[str, str]] = _HermeticEnv()


class PIIMode(StrEnum):
    """How the sensitivity policy handles PII-classified attributes."""

    DROP = "drop"
    HASH = "hash"
    ALLOW = "allow"


class ConsoleFormat(StrEnum):
    """Encoding of the console log stream."""

    JSON = "json"
    TEXT = "text"


type AttrReplacer = Callable[[tuple[str, ...], str, Any], tuple[str, Any] | None]
type ErrorHandler = Callable[[Exception], None]
type BaggagePredicate = Callable[[str], bool]


def _empty_mapping() -> Mapping[str, Any]:
    return MappingProxyType({})


@dataclass(frozen=True, slots=True)
class Options:
    """Configuration options for setup() and init().

    Precedence is strict: explicit code option > environment variable > default.
    Pass ``env=libo11y.HERMETIC`` to disable all environment reads.
    """

    service_name: str | None = None
    version: str | None = None
    distribution: str | None = None
    build_info: str | Path | None = None
    service_namespace: str | None = None
    environment: str | None = None
    extra_environments: tuple[str, ...] = ()
    strict_identity: bool = True
    resource_attributes: Mapping[str, Any] = field(default_factory=_empty_mapping)

    env: Mapping[str, str] | None = None

    log_level: int | str | None = None
    console_enabled: bool = True
    console_writer: TextIO | None = None
    console_format: ConsoleFormat = ConsoleFormat.JSON
    log_export: bool = True
    log_exporter: Any | None = None
    extra_log_handlers: tuple[logging.Handler, ...] = ()
    attr_replacer: AttrReplacer | None = None

    sampler: Sampler | None = None
    propagators: tuple[TextMapPropagator, ...] | None = None
    baggage_egress_allow: BaggagePredicate | None = None

    views: tuple[View, ...] = ()
    exemplar_filter: ExemplarFilter | None = None
    runtime_metrics: bool = True

    error_handler: ErrorHandler | None = None
    startup_summary: bool = True

    pii_mode: PIIMode = PIIMode.DROP
    pii_hash_key: bytes | None = None
    app_registry: str | Path | tuple[str | Path, ...] | None = None

    span_exporter: SpanExporter | None = None
    span_processor: SpanProcessor | None = None
    metric_reader: MetricReader | None = None

    shutdown_timeout: float = 5.0


def is_hermetic(env: Mapping[str, str] | None) -> bool:
    """Report whether env is the HERMETIC sentinel."""
    return env is HERMETIC


def parse_log_level(value: int | str | None) -> int:
    """Resolve a logging level from int or string name; defaults to logging.INFO."""
    if value is None:
        return logging.INFO
    if isinstance(value, int):
        return value
    upper = value.strip().upper()
    mapping = {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARN": logging.WARNING,
        "WARNING": logging.WARNING,
        "ERROR": logging.ERROR,
        "CRITICAL": logging.CRITICAL,
        "FATAL": logging.CRITICAL,
    }
    return mapping.get(upper, logging.INFO)
