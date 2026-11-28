"""Typed errors for libo11y."""
# ruff: noqa: N818

from __future__ import annotations


class O11yError(Exception):
    """Base class for all libo11y setup and configuration errors."""


class AlreadySetup(O11yError):
    """Raised by setup() when a process-global SDK is already installed."""

    def __init__(self, message: str = "o11y: already set up") -> None:
        super().__init__(message)


class NoServiceName(O11yError):
    """Raised when no service.name can be resolved and strict identity is enabled."""

    def __init__(
        self,
        message: str = "o11y: service name required: set service_name or OTEL_SERVICE_NAME",
    ) -> None:
        super().__init__(message)


class NoEnvironment(O11yError):
    """Raised when no deployment.environment.name can be resolved."""

    def __init__(
        self,
        message: str = (
            "o11y: deployment environment required: set environment or deployment.environment.name"
        ),
    ) -> None:
        super().__init__(message)


class InvalidEnvironment(O11yError):
    """Raised when the resolved deployment environment is not in the allowed set."""

    def __init__(
        self,
        message: str = "o11y: deployment environment not in the allowed set",
    ) -> None:
        super().__init__(message)


class PIIHashKey(O11yError):
    """Raised when pii_mode='hash' is selected without a key of at least 32 bytes."""

    def __init__(
        self,
        message: str = "o11y: PIIHash requires pii_hash_key with a key of at least 32 bytes",
    ) -> None:
        super().__init__(message)


class InvalidAppRegistry(O11yError):
    """Raised when an application registry fails parsing, validation, or collides."""

    def __init__(self, message: str = "o11y: invalid application registry") -> None:
        super().__init__(message)


class InvalidOption(O11yError):
    """Raised by init() and setup() when an option carries a value that cannot be used.

    The message names the option and says what is wrong with the value.
    """

    def __init__(self, option: str, problem: str) -> None:
        super().__init__(f"o11y: invalid option {option}: {problem}")
        self.option = option


class ForeignProvider(O11yError):
    """Raised by setup() when the host already installed its own OpenTelemetry provider.

    OpenTelemetry allows each global provider to be set once per process, so
    setup() cannot install its providers next to the host's. Nothing global
    is changed. Use init() for a handle that touches no process global.
    """

    def __init__(self, signal: str) -> None:
        super().__init__(
            f"o11y: a foreign OpenTelemetry {signal} provider is already installed: "
            "use init() and pass the handle's providers explicitly"
        )
        self.signal = signal


class UnknownPropagator(O11yError):
    """Raised when OTEL_PROPAGATORS names a propagator that cannot be resolved."""


class CanaryRejected(O11yError):
    """Raised by setup() when a log sink rejects the startup canary event."""


class UnsupportedProtocol(O11yError):
    """Raised when an unsupported exporter or OTLP protocol is requested."""


class ExporterError(O11yError):
    """Raised when constructing or configuring an exporter fails."""


class ExportFailed(O11yError):
    """An exporter did not accept a batch.

    It is never raised. Telemetry.shutdown() and Telemetry.force_flush()
    report it in ShutdownReport.errors when an exporter answers an export
    with a failure result while they run. An exception an exporter raises
    is reported as that exception.
    """

    def __init__(self, signal: str, message: str | None = None) -> None:
        super().__init__(message or f"o11y: the {signal} exporter did not accept a batch")
        self.signal = signal


class InvalidCarrier(O11yError):
    """Raised when serialized detached carrier text cannot be parsed."""

    def __init__(self, message: str = "o11y: invalid carrier") -> None:
        super().__init__(message)
