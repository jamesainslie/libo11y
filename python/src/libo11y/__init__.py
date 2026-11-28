"""Opinionated, elegant observability for Python built purely on OpenTelemetry."""

from __future__ import annotations

from libo11y import buildinfo, detached, proc, redact, spec
from libo11y._internal.logging_handler import force_emit
from libo11y.errors import (
    AlreadySetup,
    CanaryRejected,
    ExporterError,
    ExportFailed,
    ForeignProvider,
    InvalidAppRegistry,
    InvalidCarrier,
    InvalidEnvironment,
    InvalidOption,
    NoEnvironment,
    NoServiceName,
    O11yError,
    PIIHashKey,
    UnknownPropagator,
    UnsupportedProtocol,
)
from libo11y.options import (
    HERMETIC,
    AttrReplacer,
    BaggagePredicate,
    ConsoleFormat,
    ErrorHandler,
    Options,
    PIIMode,
)
from libo11y.record import Record, current_record, start_record
from libo11y.signals import ashutdown_on_signals, shutdown_on_signals
from libo11y.telemetry import ShutdownReport, Telemetry, init, setup

__all__ = [
    "HERMETIC",
    "AlreadySetup",
    "AttrReplacer",
    "BaggagePredicate",
    "CanaryRejected",
    "ConsoleFormat",
    "ErrorHandler",
    "ExportFailed",
    "ExporterError",
    "ForeignProvider",
    "InvalidAppRegistry",
    "InvalidCarrier",
    "InvalidEnvironment",
    "InvalidOption",
    "NoEnvironment",
    "NoServiceName",
    "O11yError",
    "Options",
    "PIIHashKey",
    "PIIMode",
    "Record",
    "ShutdownReport",
    "Telemetry",
    "UnknownPropagator",
    "UnsupportedProtocol",
    "ashutdown_on_signals",
    "buildinfo",
    "current_record",
    "detached",
    "force_emit",
    "init",
    "proc",
    "redact",
    "setup",
    "shutdown_on_signals",
    "spec",
    "start_record",
]
