"""Configuration options, sentinels, and enums for libo11y setup and init."""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Final, TextIO, cast

from opentelemetry.propagators.textmap import TextMapPropagator
from opentelemetry.sdk.metrics import ExemplarFilter
from opentelemetry.sdk.metrics.export import MetricReader
from opentelemetry.sdk.metrics.view import View
from opentelemetry.sdk.trace import SpanProcessor
from opentelemetry.sdk.trace.export import SpanExporter
from opentelemetry.sdk.trace.sampling import Sampler

from libo11y.errors import InvalidOption

if TYPE_CHECKING:
    # The logs SDK is still private upstream. Its names reach libo11y only
    # through logs_bridge, which imports this module, so the import is for
    # type checkers alone.
    from libo11y._internal.logs_bridge import LogRecordExporter


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


def _no_buckets() -> Mapping[str, Sequence[float]]:
    return MappingProxyType({})


@dataclass(frozen=True, slots=True)
class Options:
    """Configuration options for setup() and init().

    Precedence is strict: explicit code option > environment variable > default.
    Pass ``env=libo11y.HERMETIC`` to disable all environment reads.

    ``histogram_buckets`` maps an instrument name to the explicit bucket
    boundaries of that histogram. The name may use the wildcard forms a
    metric view supports (``*`` and ``?``, for example ``http.server.*``).
    Boundaries are finite and strictly increasing. The views it produces
    apply after ``views``.

    init() and setup() raise InvalidOption for a value that cannot be used.
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
    log_exporter: LogRecordExporter | None = None
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
    histogram_buckets: Mapping[str, Sequence[float]] = field(default_factory=_no_buckets)


def is_hermetic(env: Mapping[str, str] | None) -> bool:
    """Report whether env is the HERMETIC sentinel."""
    return env is HERMETIC


_LEVEL_NAMES: Final[Mapping[str, int]] = MappingProxyType(
    {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARN": logging.WARNING,
        "WARNING": logging.WARNING,
        "ERROR": logging.ERROR,
        "CRITICAL": logging.CRITICAL,
        "FATAL": logging.CRITICAL,
    }
)

# The names the console leg renders, lowest first, with the level each starts at.
_RENDERED_LEVELS: Final[tuple[tuple[int, str], ...]] = (
    (logging.DEBUG, "DEBUG"),
    (logging.INFO, "INFO"),
    (logging.WARNING, "WARN"),
    (logging.ERROR, "ERROR"),
    (logging.CRITICAL, "FATAL"),
)


def parse_log_level(value: int | str | None) -> int:
    """Resolve a logging level from an int or a level name. None is logging.INFO.

    Names are matched without regard to case or surrounding white space:
    DEBUG, INFO, WARN, WARNING, ERROR, CRITICAL and FATAL. Any other name
    raises InvalidOption.
    """
    if value is None:
        return logging.INFO
    if isinstance(value, int):
        return value
    level = _LEVEL_NAMES.get(value.strip().upper())
    if level is None:
        raise InvalidOption(
            "log_level",
            f"unknown level name {value!r} (use DEBUG, INFO, WARN, ERROR or FATAL)",
        )
    return level


def level_name(level: int) -> str:
    """Name a logging level as the console leg and Go's slog.Level do.

    The five standard levels are DEBUG, INFO, WARN, ERROR and FATAL. A level
    between two of them is the lower name with its offset, such as INFO+5,
    and a level below DEBUG is DEBUG with a negative offset.
    """
    base, name = _RENDERED_LEVELS[0]
    for floor, floor_name in _RENDERED_LEVELS:
        if level >= floor:
            base, name = floor, floor_name
    offset = level - base
    return name if offset == 0 else f"{name}{offset:+d}"


def _validate_boundaries(instrument: str, boundaries: object) -> None:
    option = f"histogram_buckets[{instrument!r}]"
    if isinstance(boundaries, (str, bytes)) or not isinstance(boundaries, Sequence):
        raise InvalidOption(option, "boundaries must be a sequence of numbers")
    previous: float | None = None
    for boundary in cast(Sequence[object], boundaries):
        if isinstance(boundary, bool) or not isinstance(boundary, (int, float)):
            raise InvalidOption(option, f"boundary {boundary!r} is not a number")
        if not math.isfinite(boundary):
            raise InvalidOption(option, f"boundary {boundary!r} is not finite")
        if previous is not None and boundary <= previous:
            raise InvalidOption(option, "boundaries must be strictly increasing")
        previous = boundary


def _validate_timeout(timeout: object) -> None:
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout < 0
    ):
        raise InvalidOption(
            "shutdown_timeout", f"{timeout!r} is not a finite, non-negative number of seconds"
        )


def _validate_buckets(buckets: object) -> None:
    if not isinstance(buckets, Mapping):
        raise InvalidOption("histogram_buckets", "must map instrument names to boundaries")
    for instrument, boundaries in cast(Mapping[object, object], buckets).items():
        if not isinstance(instrument, str) or not instrument.strip():
            raise InvalidOption(
                "histogram_buckets", f"instrument name {instrument!r} is not a non-empty string"
            )
        _validate_boundaries(instrument, boundaries)


def validate_options(opts: Options) -> None:
    """Raise InvalidOption before building workers for an invalid option."""
    _validate_timeout(opts.shutdown_timeout)
    parse_log_level(opts.log_level)
    _validate_buckets(opts.histogram_buckets)
