"""Capture-time redaction wrappers and the @redacted dataclass decorator."""

from __future__ import annotations

import builtins
import dataclasses
import inspect
import sys
from collections.abc import Mapping, Sequence
from enum import IntEnum
from typing import Annotated, Any, Final, ForwardRef, Protocol, cast, get_args, get_origin

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


class _Unresolved:
    """Base of the stand-ins for names an annotation uses before they exist.

    ``@redacted`` runs while the class is being defined, so under postponed
    annotations a field may name the class itself or a class defined later
    in the same function. Those names evaluate to subclasses of this type,
    which is enough to read a field's ``Annotated`` metadata.
    """

    __slots__ = ()

    def __class_getitem__(cls, params: object) -> _UnresolvedAlias:
        if isinstance(params, tuple):
            return _UnresolvedAlias(cls, cast(tuple[object, ...], params))
        return _UnresolvedAlias(cls, (params,))


class _UnresolvedAlias:
    """A subscripted stand-in, such as ``LocalBox[int]`` before LocalBox exists."""

    __slots__ = ("args", "origin")

    def __init__(self, origin: type[_Unresolved], args: tuple[object, ...]) -> None:
        self.origin = origin
        self.args = args

    def __call__(self) -> None:
        # Callable, so typing accepts it as the first argument of Annotated.
        raise TypeError(f"{self.origin.__name__} is not defined yet")

    def __or__(self, other: object) -> _UnresolvedAlias:
        return self

    def __ror__(self, other: object) -> _UnresolvedAlias:
        return self


class _AnnotationNamespace(dict[str, object]):
    """Evaluation locals resolving names from a module, then builtins, then stand-ins."""

    def __init__(self, module_globals: Mapping[str, object], cls: type) -> None:
        super().__init__({cls.__name__: cls})
        self._globals = module_globals

    def __missing__(self, key: str) -> object:
        if key in self._globals:
            return self._globals[key]
        if hasattr(builtins, key):
            return cast(object, getattr(builtins, key))
        stand_in = type(key, (_Unresolved,), {"__slots__": ()})
        self[key] = stand_in
        return stand_in


def _field_owner(cls: type, name: str) -> type:
    """Return the class in cls's MRO that declares the field name."""
    for base in cls.__mro__:
        if base is object:
            break
        try:
            annotations = inspect.get_annotations(base)
        except NameError:
            continue
        if name in annotations:
            return base
    return cls


def _field_annotation(cls: type, field: dataclasses.Field[object]) -> object:
    """Return a field's annotation, evaluating a postponed one leniently."""
    ann: object = field.type
    if isinstance(ann, ForwardRef):
        ann = ann.__forward_arg__
    if not isinstance(ann, str):
        return ann
    owner = _field_owner(cls, field.name)
    module = sys.modules.get(owner.__module__)
    module_globals: Mapping[str, object] = vars(module) if module is not None else {}
    try:
        return cast(
            object, eval(ann, dict(module_globals), _AnnotationNamespace(module_globals, owner))
        )
    except Exception as exc:
        raise TypeError(
            f"cannot evaluate the annotation {ann!r} of field {field.name!r} "
            "to read its redaction tags"
        ) from exc


def _is_unresolved(value: object) -> bool:
    return isinstance(value, _UnresolvedAlias) or (
        isinstance(value, type) and issubclass(value, _Unresolved)
    )


def _extract_field_protection(field_name: str, annotation: object) -> _Protection:
    if isinstance(annotation, _UnresolvedAlias):
        # An undefined generic: it may be Annotated under another name, so a
        # string argument could be a tag that would otherwise be ignored.
        if any(isinstance(arg, str) for arg in annotation.args):
            raise TypeError(
                f"cannot resolve {annotation.origin.__name__!r} in the annotation of field "
                f"{field_name!r} to read its redaction tags"
            )
        return _Protection.PASSTHROUGH
    if get_origin(annotation) is not Annotated:
        return _Protection.PASSTHROUGH
    args = get_args(annotation)
    level = _Protection.PASSTHROUGH
    for meta in args[1:]:
        if _is_unresolved(meta):
            raise TypeError(
                f"redaction metadata {meta!r} on field {field_name!r} names something "
                "that is not defined when the class is defined"
            )
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


def json_default(value: object) -> object:
    """Render a protected value for ``json.dumps(obj, default=json_default)``.

    ``json.dumps`` cannot serialize a Secret, a Masked, or a ``@redacted``
    instance on its own and raises TypeError, so it never emits a raw value.
    With this hook, a Secret becomes ``"REDACTED"``, a Masked becomes its
    run of ``X``, and a ``@redacted`` instance becomes an object of its
    protected fields: omitted fields are absent, and the strictest
    protection in scope wins through nesting, as in ``str()``. Any other
    value json.dumps cannot serialize raises TypeError, as it does without
    a hook.
    """
    if contains_redactable(value):
        return render_redacted(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


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

    ``str()``, ``repr()``, ``format()`` and the logging handler render the
    protected form, and ``json_default`` renders it for ``json.dumps``. Tags
    are validated when the class is defined: an unknown string tag raises
    TypeError immediately at import time rather than leaking at runtime.
    Postponed annotations may name the class itself or a class defined later
    in the same scope; a tag given by a name that is not defined yet raises
    TypeError.

    Functions that read fields directly see the raw values:
    ``dataclasses.asdict``, ``dataclasses.astuple``, ``vars()``, ``pickle``
    and ``copy`` all return or keep them. Use ``to_redacted_dict`` for the
    protected mapping.
    """
    if not dataclasses.is_dataclass(cls):
        raise TypeError("@redacted must decorate a dataclass")

    field_plans: list[tuple[str, _Protection]] = []
    for f in dataclasses.fields(cls):
        ann = _field_annotation(cls, f)
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
    "json_default",
    "redacted",
    "render_redacted",
    "to_redacted_dict",
]
