"""yaml.v3-compatible YAML parser and scalar resolver for application registries.

Subclasses PyYAML's pure-Python SafeLoader to align escape handling with Go's
gopkg.in/yaml.v3 (accepting \\' and rejecting \\/ and lone surrogates), builds
a lazy alias-preserving node tree from PyYAML's event stream so alias bombs are
stopped by yaml.v3's alias expansion budget, and resolves scalar tags using
yaml.v3's rules rather than YAML 1.1.
"""

from __future__ import annotations

import base64
import math
import re
from dataclasses import dataclass, field
from typing import Final

import yaml
from yaml.error import Mark, YAMLError
from yaml.events import (
    AliasEvent,
    DocumentEndEvent,
    DocumentStartEvent,
    Event,
    MappingEndEvent,
    MappingStartEvent,
    ScalarEvent,
    SequenceEndEvent,
    SequenceStartEvent,
    StreamEndEvent,
    StreamStartEvent,
)
from yaml.loader import SafeLoader
from yaml.scanner import ScannerError


class YamlSyntaxError(Exception):
    """A fatal YAML error matching Go conformance's `parse: syntax`."""


# yaml.v3's reader accepts tab, LF, CR, printable ASCII, NEL, and BMP/astral
# except surrogates, U+FFFE and U+FFFF.
_INVALID_CHAR_RE: Final[re.Pattern[str]] = re.compile(
    r"[^\t\n\r\x20-\x7e\x85\xa0-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]"
)


def decode_input(raw: bytes) -> str:
    """Decode UTF-8, or UTF-16 after a BOM, as yaml.v3's reader does."""
    if raw.startswith(b"\xff\xfe"):
        try:
            text = raw[2:].decode("utf-16-le")
        except UnicodeDecodeError as exc:
            raise YamlSyntaxError("invalid UTF-16 input") from exc
    elif raw.startswith(b"\xfe\xff"):
        try:
            text = raw[2:].decode("utf-16-be")
        except UnicodeDecodeError as exc:
            raise YamlSyntaxError("invalid UTF-16 input") from exc
    elif raw.startswith(b"\xef\xbb\xbf"):
        try:
            text = raw[3:].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise YamlSyntaxError("invalid UTF-8 input") from exc
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise YamlSyntaxError("invalid UTF-8 input") from exc
    check_characters(text)
    return text


def check_characters(text: str) -> None:
    """Reject control characters and surrogates that yaml.v3's reader rejects."""
    m = _INVALID_CHAR_RE.search(text)
    if m is not None:
        cp = ord(m.group(0))
        raise YamlSyntaxError(f"control characters are not allowed: U+{cp:04X}")


class _YamlV3Loader(SafeLoader):
    """Pure-Python PyYAML loader with yaml.v3's double-quoted escape table."""

    ESCAPE_REPLACEMENTS = {  # pyright: ignore[reportGeneralTypeIssues]
        k: v for k, v in SafeLoader.ESCAPE_REPLACEMENTS.items() if k != "/"
    } | {"'": "'"}

    def scan_flow_scalar_non_spaces(self, double: bool, start_mark: Mark) -> list[str]:
        # Delegate to PyYAML's scanner, then verify no surrogate code points
        # were produced from \\uXXXX escapes (PyYAML allows \\ud800).
        chunks: list[str] = super().scan_flow_scalar_non_spaces(double, start_mark)  # pyright: ignore[reportUnknownMemberType, reportAttributeAccessIssue]
        if double:
            for chunk in chunks:
                for ch in chunk:
                    cp = ord(ch)
                    if 0xD800 <= cp <= 0xDFFF or cp > 0x10FFFF:
                        raise ScannerError(
                            "while scanning a double-quoted scalar",
                            start_mark,
                            "found invalid Unicode character escape code",
                            self.get_mark(),
                        )
        return chunks


def _empty_nodes() -> list[YamlNode]:
    return []


def _empty_pairs() -> list[tuple[YamlNode, YamlNode]]:
    return []


# Lazy AST nodes preserving anchors and aliases without expanding them.
@dataclass(slots=True)
class ScalarNode:
    tag: str | None
    value: str
    style: str | None
    anchor: str | None = None


@dataclass(slots=True)
class SequenceNode:
    tag: str | None
    items: list[YamlNode] = field(default_factory=_empty_nodes)
    anchor: str | None = None


@dataclass(slots=True)
class MappingNode:
    tag: str | None
    pairs: list[tuple[YamlNode, YamlNode]] = field(default_factory=_empty_pairs)
    anchor: str | None = None


@dataclass(slots=True)
class AliasNode:
    anchor: str


type YamlNode = ScalarNode | SequenceNode | MappingNode | AliasNode


@dataclass(slots=True)
class Document:
    root: YamlNode
    explicit_start: bool
    version: tuple[int, int] | None
    aliases: dict[int, YamlNode]


_LONG_TAG_PREFIX: Final[str] = "tag:yaml.org,2002:"
_NULL: Final[str] = "!!null"
_BOOL: Final[str] = "!!bool"
_STR: Final[str] = "!!str"
_INT: Final[str] = "!!int"
_FLOAT: Final[str] = "!!float"
_TIMESTAMP: Final[str] = "!!timestamp"
_BINARY: Final[str] = "!!binary"
_MERGE: Final[str] = "!!merge"
_RESOLVABLE: Final[frozenset[str]] = frozenset({"", _STR, _BOOL, _INT, _FLOAT, _NULL, _TIMESTAMP})
_MERGE_TAGS: Final[frozenset[str]] = frozenset({"", "!", _MERGE})

_RESOLVE_MAP: Final[dict[str, str]] = {
    **{s: _BOOL for s in ("true", "True", "TRUE", "false", "False", "FALSE")},
    **{s: _NULL for s in ("", "~", "null", "Null", "NULL")},
    **{
        s: _FLOAT
        for s in (
            ".nan",
            ".NaN",
            ".NAN",
            ".inf",
            ".Inf",
            ".INF",
            "+.inf",
            "+.Inf",
            "+.INF",
            "-.inf",
            "-.Inf",
            "-.INF",
        )
    },
    "<<": _MERGE,
}

_INT64_MAX: Final[int] = (1 << 63) - 1
_UINT64_MAX: Final[int] = (1 << 64) - 1
_YAML_STYLE_FLOAT_RE: Final[re.Pattern[str]] = re.compile(
    r"^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$"
)
_DOT_FLOAT_RE: Final[re.Pattern[str]] = re.compile(r"^\.[0-9]+([eE][-+]?[0-9]+)?$")
_BASE64_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
)
_TIMESTAMP_RES: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(
        r"^(\d{4})-(\d\d?)-(\d\d?)T(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))$"
    ),
    re.compile(
        r"^(\d{4})-(\d\d?)-(\d\d?)t(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))$"
    ),
    re.compile(r"^(\d{4})-(\d\d?)-(\d\d?) (\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?$"),
    re.compile(r"^(\d{4})-(\d\d?)-(\d\d?)$"),
)


def short_tag(tag: str | None) -> str:
    if tag is None:
        return ""
    if tag.startswith(_LONG_TAG_PREFIX):
        return "!!" + tag[len(_LONG_TAG_PREFIX) :]
    return tag


def _hint(s: str) -> str:
    if not s:
        return "N"
    c = s[0]
    if c in ("+", "-"):
        return "S"
    if "0" <= c <= "9":
        return "D"
    if c in "yYnNtTfFoO~":
        return "M"
    return "." if c == "." else ""


def _parse_digits(s: str, base: int) -> int | None:
    if not s:
        return None
    n = 0
    for ch in s:
        if "0" <= ch <= "9":
            d = ord(ch) - ord("0")
        elif "a" <= ch <= "z":
            d = ord(ch) - ord("a") + 10
        elif "A" <= ch <= "Z":
            d = ord(ch) - ord("A") + 10
        else:
            return None
        if d >= base:
            return None
        n = n * base + d
    return n


def _go_parse_uint(s: str, base: int) -> int | None:
    if not s:
        return None
    b = base
    digits = s
    if base == 0:
        b = 10
        if s[0] == "0":
            p = s[1].lower() if len(s) > 1 else ""
            if len(s) >= 3 and p == "b":
                b, digits = 2, s[2:]
            elif len(s) >= 3 and p == "o":
                b, digits = 8, s[2:]
            elif len(s) >= 3 and p == "x":
                b, digits = 16, s[2:]
            else:
                b, digits = 8, s[1:]
                if not digits and s == "0":
                    return 0
    n = _parse_digits(digits, b)
    if n is None or n > _UINT64_MAX:
        return None
    return n


def _go_parse_int(s: str, base: int) -> int | None:
    if not s:
        return None
    negative = s[0] == "-"
    body = s[1:] if s[0] in ("+", "-") else s
    n = _go_parse_uint(body, base)
    if n is None:
        return None
    limit = _INT64_MAX + 1 if negative else _INT64_MAX
    if n > limit:
        return None
    return -n if negative else n


def _finite_float(s: str) -> bool:
    try:
        return math.isfinite(float(s))
    except ValueError:
        return False


def _days_in(month: int, year: int) -> int:
    if month == 2:
        return 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _parse_timestamp(s: str) -> bool:
    if len(s) < 5 or not s[:4].isdigit() or s[4] != "-":
        return False
    for pattern in _TIMESTAMP_RES:
        m = pattern.match(s)
        if m is None:
            continue
        year = int(m.group(1))
        month = int(m.group(2))
        day = int(m.group(3))
        hour = int(m.group(4)) if m.lastindex and m.lastindex >= 4 and m.group(4) else 0
        minute = int(m.group(5)) if m.lastindex and m.lastindex >= 5 and m.group(5) else 0
        second = int(m.group(6)) if m.lastindex and m.lastindex >= 6 and m.group(6) else 0
        if not (1 <= month <= 12 and 1 <= day <= _days_in(month, year)):
            continue
        if hour > 23 or minute > 59 or second > 59:
            continue
        if (
            m.lastindex
            and m.lastindex >= 9
            and m.group(8) is not None
            and m.group(9) is not None
            and (int(m.group(8)) > 24 or int(m.group(9)) > 60)
        ):
            continue
        return True
    return False


def _classify(tag: str, s: str) -> tuple[str, bool]:
    h = _hint(s)
    if not h or tag == _STR:
        return _STR, False
    mapped = _RESOLVE_MAP.get(s)
    if mapped is not None:
        return mapped, False
    if h == "." and _DOT_FLOAT_RE.match(s) and _finite_float(s):
        return _FLOAT, False
    if h in ("D", "S"):
        if tag in ("", _TIMESTAMP) and _parse_timestamp(s):
            return _TIMESTAMP, False
        plain = s.replace("_", "")
        if _go_parse_int(plain, 0) is not None:
            return _INT, False
        if _go_parse_uint(plain, 0) is not None:
            return _INT, True
        if _YAML_STYLE_FLOAT_RE.match(plain) and _finite_float(plain):
            return _FLOAT, False
        if plain.startswith("0b"):
            if _go_parse_int(plain[2:], 2) is not None:
                return _INT, False
            if _go_parse_uint(plain[2:], 2) is not None:
                return _INT, True
        elif plain.startswith("-0b") and _go_parse_int("-" + plain[3:], 2) is not None:
            return _INT, False
        if plain.startswith("0o"):
            if _go_parse_int(plain[2:], 8) is not None:
                return _INT, False
            if _go_parse_uint(plain[2:], 8) is not None:
                return _INT, True
        elif plain.startswith("-0o") and _go_parse_int("-" + plain[3:], 8) is not None:
            return _INT, False
    return _STR, False


def _decode_base64(s: str) -> str:
    compact = s.replace("\r", "").replace("\n", "")
    if not _BASE64_RE.match(compact):
        raise YamlSyntaxError("!!binary value contains invalid base64 data")
    raw = base64.b64decode(compact)
    return raw.decode("utf-8", errors="replace")


@dataclass(frozen=True, slots=True)
class ScalarValue:
    is_null: bool
    text: str = ""
    is_string: bool = False


def resolve_scalar(tag: str | None, value: str, quoted_or_block: bool) -> ScalarValue:
    """Resolve a scalar node the way yaml.v3 does before storing it in a Go string."""
    short = short_tag(tag)
    if short == _STR or (short in ("", "!") and quoted_or_block):
        return ScalarValue(is_null=False, text=value, is_string=True)
    if short not in _RESOLVABLE:
        if short == _BINARY:
            return ScalarValue(is_null=False, text=_decode_base64(value), is_string=True)
        return ScalarValue(is_null=False, text=value, is_string=True)
    resolved_tag, unsigned = _classify(short, value)
    if short == _FLOAT and resolved_tag == _INT and not unsigned:
        resolved_tag = _FLOAT
    if short and short != resolved_tag:
        raise YamlSyntaxError(f"cannot decode {resolved_tag} `{value}` as a {short}")
    if resolved_tag == _NULL:
        return ScalarValue(is_null=True)
    return ScalarValue(
        is_null=False,
        text=value,
        is_string=resolved_tag in (_STR, _MERGE),
    )


def _compose_documents(text: str) -> list[Document]:
    """Parse text via _YamlV3Loader's event stream into lazy alias-preserving Documents."""
    try:
        events: list[Event] = list(yaml.parse(text, Loader=_YamlV3Loader))
    except (YAMLError, RecursionError) as exc:
        raise YamlSyntaxError(str(exc)) from exc

    pos = 0
    total = len(events)
    if pos < total and isinstance(events[pos], StreamStartEvent):
        pos += 1

    docs: list[Document] = []
    max_depth = 10_000

    while pos < total:
        ev = events[pos]
        if isinstance(ev, StreamEndEvent):
            break
        if not isinstance(ev, DocumentStartEvent):
            raise YamlSyntaxError(f"unexpected event {ev!r}")
        version = ev.version
        if version is not None and version != (1, 1):
            raise YamlSyntaxError("found incompatible YAML document")
        explicit_start = bool(ev.explicit)
        pos += 1

        anchors: dict[str, YamlNode] = {}
        aliases: dict[int, YamlNode] = {}

        def compose_node(
            depth: int,
            doc_anchors: dict[str, YamlNode] = anchors,
            doc_aliases: dict[int, YamlNode] = aliases,
        ) -> YamlNode:
            nonlocal pos
            if depth > max_depth:
                raise YamlSyntaxError("the document nests too deeply")
            cur = events[pos]
            pos += 1
            if isinstance(cur, AliasEvent):
                if cur.anchor is None:
                    raise YamlSyntaxError("alias without anchor name")
                target = doc_anchors.get(cur.anchor)
                if target is None:
                    raise YamlSyntaxError(f"unknown anchor '{cur.anchor}' referenced")
                node = AliasNode(anchor=cur.anchor)
                doc_aliases[id(node)] = target
                return node
            if isinstance(cur, ScalarEvent):
                node = ScalarNode(
                    tag=cur.tag,
                    value=cur.value,
                    style=cur.style,
                    anchor=cur.anchor,
                )
                if cur.anchor is not None:
                    doc_anchors[cur.anchor] = node
                return node
            if isinstance(cur, SequenceStartEvent):
                seq = SequenceNode(tag=cur.tag, anchor=cur.anchor)
                if cur.anchor is not None:
                    doc_anchors[cur.anchor] = seq
                while pos < total and not isinstance(events[pos], SequenceEndEvent):
                    seq.items.append(compose_node(depth + 1))
                pos += 1  # consume SequenceEndEvent
                return seq
            if isinstance(cur, MappingStartEvent):
                mp = MappingNode(tag=cur.tag, anchor=cur.anchor)
                if cur.anchor is not None:
                    doc_anchors[cur.anchor] = mp
                while pos < total and not isinstance(events[pos], MappingEndEvent):
                    k = compose_node(depth + 1)
                    v = compose_node(depth + 1)
                    mp.pairs.append((k, v))
                pos += 1  # consume MappingEndEvent
                return mp
            raise YamlSyntaxError(f"unexpected event {cur!r}")

        root = compose_node(0)
        if pos < total and isinstance(events[pos], DocumentEndEvent):
            pos += 1
        docs.append(
            Document(
                root=root,
                explicit_start=explicit_start,
                version=version,
                aliases=aliases,
            )
        )
    return docs


def parse_documents(text: str) -> list[Document]:
    """Validate characters and compose all YAML documents lazily."""
    check_characters(text)
    return _compose_documents(text)


# yaml.v3 alias expansion budget (decode.go allowedAliasRatio).
_ALIAS_RATIO_LOW: Final[int] = 400_000
_ALIAS_RATIO_HIGH: Final[int] = 4_000_000


def allowed_alias_ratio(decodes: int) -> float:
    if decodes <= _ALIAS_RATIO_LOW:
        return 0.99
    if decodes >= _ALIAS_RATIO_HIGH:
        return 0.10
    return 0.99 - 0.89 * ((decodes - _ALIAS_RATIO_LOW) / (_ALIAS_RATIO_HIGH - _ALIAS_RATIO_LOW))


def is_merge_key(node: YamlNode) -> bool:
    return (
        isinstance(node, ScalarNode)
        and node.style is None
        and node.value == "<<"
        and short_tag(node.tag) in _MERGE_TAGS
    )
