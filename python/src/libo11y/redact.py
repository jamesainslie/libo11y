"""Capture-time redaction wrappers and the @redacted dataclass decorator."""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping, Sequence
from enum import IntEnum
from typing import Annotated, Any, Final, Protocol, cast, get_args, get_origin, get_type_hints

REDACTED: Final[str] = "REDACTED"

MASK: Final[str] = "mask"
REDACT: Final[str] = "redact"
OMIT: Final[str] = "omit"
CONFIDENTIAL: Final[str] = "confidential"
SECRET: Final[str] = "secret"

_MAX_DEPTH: Final[int] = 32


class _Protection(IntEnum):
    PASSTHROUGH = 0
    MASK = 1
    REDACT = 2
    OMIT = 3


_TAG_MAP: Final[dict[str, _Protection]] = {
    "mask": _Protection.MASK,
    "confidential": _Protection.MASK,
    "redact": _Protection.REDACT,
    "secret": _Protection.REDACT,
    "omit": _Protection.OMIT,
}


def _mask_string(s: str) -> str:
    return "X" * len(s)


class _Redactable(Protocol):
    def _o11y_redact_value(self, floor: _Protection, depth: int, active: set[int]) -> object: ...


class Secret[T]:
    """Wraps a value that always renders as REDACTED across all text and log surfaces."""

    __slots__ = ("_value",)

    def __init__(self, value: T) -> None:
        self._value = value

    def reveal(self) -> T:
        """Explicitly return the wrapped sensitive value."""
        return self._value

    def __str__(self) -> str:
        return REDACTED

    def __repr__(self) -> str:
        return REDACTED

    def __format__(self, _format_spec: str) -> str:
        return REDACTED

    def _o11y_redact_value(self, floor: _Protection, depth: int, active: set[int]) -> object:
        del floor, depth, active
        return REDACTED


class Masked[T]:
    """Wraps a value that renders as a same-length run of 'X' characters."""

    __slots__ = ("_value",)

    def __init__(self, value: T) -> None:
        self._value = value

    def reveal(self) -> T:
        """Explicitly return the wrapped value."""
        return self._value

    def _masked(self) -> str:
        return _mask_string(str(self._value))

    def __str__(self) -> str:
        return self._masked()

    def __repr__(self) -> str:
        return self._masked()

    def __format__(self, _format_spec: str) -> str:
        return self._masked()

    def _o11y_redact_value(self, floor: _Protection, depth: int, active: set[int]) -> object:
        del depth, active
        if floor >= _Protection.REDACT:
            return REDACTED
        return self._masked()


def _extract_field_protection(field_name: str, annotation: object) -> _Protection:
    if get_origin(annotation) is not Annotated:
        return _Protection.PASSTHROUGH
    args = get_args(annotation)
    level = _Protection.PASSTHROUGH
    for meta in args[1:]:
        if isinstance(meta, str):
            mapped = _TAG_MAP.get(meta)
            if mapped is None:
                raise TypeError(
                    f"unknown redaction tag {meta!r} on field {field_name!r}; "
                    f"expected one of: {', '.join(sorted(_TAG_MAP))}"
                )
            if mapped > level:
                level = mapped
    return level


def _protect(value: object, floor: _Protection, depth: int, active: set[int]) -> object:
    if floor >= _Protection.REDACT or depth > _MAX_DEPTH:
        return REDACTED
    if value is None:
        return None
    if isinstance(value, (Secret, Masked)):
        return value._o11y_redact_value(floor, depth, active)  # pyright: ignore[reportPrivateUsage]
    if hasattr(value, "_o11y_redact_value"):
        return cast(_Redactable, value)._o11y_redact_value(floor, depth, active)  # pyright: ignore[reportPrivateUsage]
    if isinstance(value, bool):
        return _mask_string("true" if value else "false") if floor == _Protection.MASK else value
    if isinstance(value, (int, float)):
        return _mask_string(str(value)) if floor == _Protection.MASK else value
    if isinstance(value, str):
        return _mask_string(value) if floor == _Protection.MASK else value
    if isinstance(value, (bytes, bytearray)):
        return (
            _mask_string(value.decode("utf-8", errors="replace"))
            if floor == _Protection.MASK
            else bytes(value)
        )

    oid = id(value)
    if oid in active:
        return REDACTED
    active.add(oid)
    try:
        if isinstance(value, Mapping):
            m = cast(Mapping[object, object], value)
            return {str(k): _protect(v, floor, depth + 1, active) for k, v in m.items()}
        if isinstance(value, Sequence):
            seq = cast(Sequence[object], value)
            return [_protect(el, floor, depth + 1, active) for el in seq]
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            out: dict[str, object] = {}
            for f in dataclasses.fields(value):
                out[f.name] = _protect(getattr(value, f.name), floor, depth + 1, active)
            return out
    finally:
        active.discard(oid)

    text = str(value)
    return _mask_string(text) if floor == _Protection.MASK else text


def render_redacted(value: object) -> object:
    """Render any value with capture-time redaction applied (Secret, Masked, @redacted)."""
    return _protect(value, _Protection.PASSTHROUGH, 0, set())


def _format_protected_mapping(data: Mapping[str, object]) -> str:
    parts: list[str] = []
    for k, v in data.items():
        if isinstance(v, Mapping):
            parts.append(f"{k}:{_format_protected_mapping(cast(Mapping[str, object], v))}")
        else:
            parts.append(f"{k}:{v}")
    return "{" + " ".join(parts) + "}"


def redacted[C: type](cls: C) -> C:
    """Dataclass decorator enforcing Annotated field redaction tags on every surface.

    Tags are validated when the class is defined: an unknown string tag raises
    TypeError immediately at import time rather than leaking at runtime.
    """
    if not dataclasses.is_dataclass(cls):
        raise TypeError("@redacted must decorate a dataclass")

    hints = get_type_hints(cls, include_extras=True)
    field_plans: list[tuple[str, _Protection]] = []
    for f in dataclasses.fields(cls):
        ann = hints.get(f.name, f.type)
        prot = _extract_field_protection(f.name, ann)
        field_plans.append((f.name, prot))
    plans_tuple = tuple(field_plans)

    def _redact_value(
        self: object,
        floor: _Protection,
        depth: int,
        active: set[int],
    ) -> object:
        if floor >= _Protection.REDACT or depth > _MAX_DEPTH:
            return REDACTED
        oid = id(self)
        if oid in active:
            return REDACTED
        active.add(oid)
        try:
            out: dict[str, object] = {}
            for fname, fprot in plans_tuple:
                eff = fprot if fprot > floor else floor
                if eff == _Protection.OMIT:
                    continue
                val = getattr(self, fname)
                if eff == _Protection.REDACT:
                    out[fname] = REDACTED
                else:
                    out[fname] = _protect(val, eff, depth + 1, active)
            return out
        finally:
            active.discard(oid)

    def _to_str(self: object) -> str:
        rendered = _redact_value(self, _Protection.PASSTHROUGH, 0, set())
        if isinstance(rendered, Mapping):
            return _format_protected_mapping(cast(Mapping[str, object], rendered))
        return str(rendered)

    def _to_format(self: object, _spec: str) -> str:
        return _to_str(self)

    target: Any = cls
    target._o11y_redact_plans = plans_tuple
    target._o11y_redact_value = _redact_value
    target.__str__ = _to_str
    target.__repr__ = _to_str
    target.__format__ = _to_format
    return cast(C, target)


def contains_redactable(value: object) -> bool:
    """Fast check for whether value is a Secret, Masked, or @redacted instance."""
    return isinstance(value, (Secret, Masked)) or hasattr(value, "_o11y_redact_value")


def to_redacted_dict(obj: Any) -> dict[str, object]:
    """Return the protected dict representation of a @redacted dataclass instance."""
    rendered = render_redacted(obj)
    if not isinstance(rendered, dict):
        raise TypeError("expected a @redacted dataclass instance")
    return cast(dict[str, object], rendered)


__all__ = [
    "CONFIDENTIAL",
    "MASK",
    "OMIT",
    "REDACT",
    "REDACTED",
    "SECRET",
    "Masked",
    "Secret",
    "redacted",
    "render_redacted",
    "to_redacted_dict",
]
