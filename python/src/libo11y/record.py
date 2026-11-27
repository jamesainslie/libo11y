"""Wide-event Record accumulator for canonical log lines."""

from __future__ import annotations

import threading
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

_CURRENT_RECORD: ContextVar[Record | None] = ContextVar("libo11y_record", default=None)


class Record:
    """Thread-safe accumulator for per-request wide events (canonical log lines)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._attrs: dict[str, Any] = {}

    def set(self, key: str | None = None, value: Any = None, **kwargs: Any) -> None:
        """Set one key/value pair or multiple attributes via keyword arguments."""
        with self._lock:
            if key is not None:
                self._attrs[key] = value
            for k, v in kwargs.items():
                self._attrs[k] = v

    def set_many(self, attrs: Mapping[str, Any]) -> None:
        """Record or overwrite multiple attributes from a mapping."""
        with self._lock:
            for k, v in attrs.items():
                self._attrs[k] = v

    def add(self, key: str, delta: int) -> None:
        """Increment an integer counter on the record, creating it at delta if absent."""
        with self._lock:
            cur = self._attrs.get(key)
            base = cur if isinstance(cur, int) and not isinstance(cur, bool) else 0
            self._attrs[key] = base + delta

    def max(self, key: str, value: float) -> None:
        """Record the larger of the existing float value and value for key."""
        with self._lock:
            cur = self._attrs.get(key)
            if isinstance(cur, (int, float)) and not isinstance(cur, bool) and cur >= value:
                return
            self._attrs[key] = float(value)

    def snapshot(self) -> dict[str, Any]:
        """Return a copy of the accumulated attributes in insertion order."""
        with self._lock:
            return dict(self._attrs)

    def emit_event(
        self,
        telemetry: Telemetry | None,
        name: str,
        attributes: Mapping[str, Any] | None = None,
    ) -> None:
        """Flush the accumulated attributes as a registered event through telemetry."""
        if telemetry is None:
            return
        merged = self.snapshot()
        if attributes:
            merged.update(attributes)
        telemetry.event(name, merged)


@contextmanager
def start_record() -> Generator[Record]:
    """Context manager attaching a fresh wide-event Record to the current context."""
    rec = Record()
    token = _CURRENT_RECORD.set(rec)
    try:
        yield rec
    finally:
        _CURRENT_RECORD.reset(token)


def current_record() -> Record:
    """Return the active Record, or a detached no-op Record if none is attached."""
    rec = _CURRENT_RECORD.get()
    return rec if rec is not None else Record()
