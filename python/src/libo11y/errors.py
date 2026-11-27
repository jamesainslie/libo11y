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


class CanaryRejected(O11yError):
    """Raised by setup() when a log sink rejects the startup canary event."""


class UnsupportedProtocol(O11yError):
    """Raised when an unsupported exporter or OTLP protocol is requested."""


class ExporterError(O11yError):
    """Raised when constructing or configuring an exporter fails."""


class InvalidCarrier(O11yError):
    """Raised when serialized detached carrier text cannot be parsed."""

    def __init__(self, message: str = "o11y: invalid carrier") -> None:
        super().__init__(message)
