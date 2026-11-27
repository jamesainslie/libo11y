"""Canonical PII rendering and HMAC-SHA256 tokenization matching Go's policy.go."""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
from collections.abc import Mapping, Sequence
from typing import Final, cast

MAX_COMPOSITE_DEPTH: Final[int] = 16
MAX_COMPOSITE_NODES: Final[int] = 2048
CANONICAL_TRUNCATED: Final[str] = "truncated"
MIN_PII_HASH_KEY_LEN: Final[int] = 32


def canonical_float(value: float) -> str:
    """Format a float64 as Go's strconv.FormatFloat(f, 'g', -1, 64)."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "+Inf" if value > 0 else "-Inf"
    if value == 0.0:
        return "-0" if math.copysign(1.0, value) < 0 else "0"

    neg = value < 0
    s = repr(-value if neg else value)
    if "e" in s or "E" in s:
        mant, exp_str = s.lower().split("e")
        exp = int(exp_str)
    else:
        mant = s
        exp = 0

    if "." in mant:
        int_part, frac_part = mant.split(".")
        digits_raw = int_part + frac_part
        # Strip leading zeros and adjust exponent.
        stripped = digits_raw.lstrip("0")
        leading_zeros = len(digits_raw) - len(stripped)
        if int_part == "0":
            exp -= leading_zeros
        else:
            exp += len(int_part) - 1
        digits = stripped.rstrip("0")
    else:
        exp += len(mant) - 1
        digits = mant.rstrip("0")

    if not digits:
        return "-0" if neg else "0"

    prefix = "-" if neg else ""
    if exp < -4 or exp >= 6:
        # Scientific notation: d[.ddd]e[+-]dd
        body = digits if len(digits) == 1 else f"{digits[0]}.{digits[1:]}"
        sign = "+" if exp >= 0 else "-"
        abs_exp = abs(exp)
        exp_fmt = f"{abs_exp:02d}" if abs_exp < 100 else str(abs_exp)
        return f"{prefix}{body}e{sign}{exp_fmt}"

    # Fixed notation.
    if exp < 0:
        return f"{prefix}0.{'0' * (-exp - 1)}{digits}"
    if exp + 1 >= len(digits):
        return f"{prefix}{digits}{'0' * (exp + 1 - len(digits))}"
    split = exp + 1
    return f"{prefix}{digits[:split]}.{digits[split:]}"


class _Walk:
    __slots__ = ("_active", "_remaining")

    def __init__(self) -> None:
        self._remaining = MAX_COMPOSITE_NODES
        self._active: set[int] = set()

    def spend(self) -> bool:
        if self._remaining <= 0:
            return False
        self._remaining -= 1
        return True

    def enter(self, obj: object) -> bool:
        oid = id(obj)
        if oid in self._active:
            return False
        self._active.add(oid)
        return True

    def leave(self, obj: object) -> None:
        self._active.discard(id(obj))


type _Node = str | list[_Node] | dict[str, _Node]


def _encode_json_string(s: str) -> str:
    """Encode a JSON string matching Go's encoding/json + conformance vectors."""
    out: list[str] = ['"']
    for ch in s:
        cp = ord(ch)
        if ch == '"':
            out.append(r"\"")
        elif ch == "\\":
            out.append(r"\\")
        elif ch == "\b":
            out.append(r"\b")
        elif ch == "\f":
            out.append(r"\f")
        elif ch == "\n":
            out.append(r"\n")
        elif ch == "\r":
            out.append(r"\r")
        elif ch == "\t":
            out.append(r"\t")
        elif ch == "<":
            out.append(r"\u003c")
        elif ch == ">":
            out.append(r"\u003e")
        elif ch == "&":
            out.append(r"\u0026")
        elif cp == 0x2028:
            out.append(r"\u2028")
        elif cp == 0x2029:
            out.append(r"\u2029")
        elif cp < 0x20:
            out.append(f"\\u{cp:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _render_json_node(node: _Node) -> str:
    if isinstance(node, str):
        return _encode_json_string(node)
    if isinstance(node, list):
        return "[" + ",".join(_render_json_node(el) for el in node) + "]"
    # dict keys are already inserted in UTF-8 byte order.
    items = (f"{_encode_json_string(k)}:{_render_json_node(v)}" for k, v in node.items())
    return "{" + ",".join(items) + "}"


def _build_node(value: object, depth: int, walk: _Walk) -> _Node:
    if depth > MAX_COMPOSITE_DEPTH or not walk.spend():
        return CANONICAL_TRUNCATED
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return canonical_float(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, memoryview):
        return base64.b64encode(value.tobytes()).decode("ascii")
    if isinstance(value, Mapping):
        mapping_val = cast(Mapping[object, object], value)
        if not walk.enter(mapping_val):
            return CANONICAL_TRUNCATED
        try:
            # Sort keys by UTF-8 byte order (identical to Python str code point order
            # for valid Unicode without surrogates; encode explicitly for safety).
            pairs: list[tuple[bytes, str, object]] = []
            for k, v in mapping_val.items():
                ks = k if isinstance(k, str) else str(k)
                pairs.append((ks.encode("utf-8", errors="replace"), ks, v))
            pairs.sort(key=lambda item: item[0])
            obj: dict[str, _Node] = {}
            for _, ks, v in pairs:
                obj[ks] = _build_node(v, depth + 1, walk)
            return obj
        finally:
            walk.leave(mapping_val)
    if isinstance(value, Sequence):
        seq_val = cast(Sequence[object], value)
        if not walk.enter(seq_val):
            return CANONICAL_TRUNCATED
        try:
            return [_build_node(el, depth + 1, walk) for el in seq_val]
        finally:
            walk.leave(seq_val)
    return str(value)


def canonical_value(value: object) -> str:
    """Render any attribute value into the canonical text hashed for PII tokens."""
    node = _build_node(value, 0, _Walk())
    if isinstance(node, str):
        return node
    return _render_json_node(node)


def pii_token(key: bytes, value: object) -> str:
    """Compute the keyed HMAC-SHA256 PII token for value (truncated to 128 bits)."""
    canonical = canonical_value(value)
    digest = hmac.new(key, canonical.encode("utf-8"), hashlib.sha256).digest()[:16]
    return "hmac-sha256:" + digest.hex()
