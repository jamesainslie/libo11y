"""OTLP endpoint sanitization matching Go's net/url.Parse and URL.String()."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Final

WITHHELD: Final[str] = "unparseable"

_HEX_UPPER: Final[str] = "0123456789ABCDEF"
_HOST_OK: Final[frozenset[int]] = frozenset(b"!$&'()*+,;=:<>\"" + b"[]")
_GEN_DELIMS: Final[frozenset[int]] = frozenset(b"$&+,/:;=?@")
_UNRESERVED_PUNCT: Final[frozenset[int]] = frozenset(b"-_.~")
_FRAG_OK: Final[frozenset[int]] = frozenset(b"!()*")
_USERINFO_PUNCT: Final[frozenset[int]] = frozenset(b"-._:~!$&'()*+,;=%@")
_VALID_ENC_EXTRA: Final[frozenset[int]] = frozenset(b"!$&'()*+,;=:@[]%")


class _Mode(Enum):
    PATH = 1
    HOST = 2
    ZONE = 3
    USER_PASSWORD = 4
    FRAGMENT = 5


class _InvalidURLError(Exception):
    pass


@dataclass
class _Url:
    scheme: str = ""
    opaque_text: bytes = b""
    has_user: bool = False
    host: bytes = b""
    path: bytes = b""
    raw_path: bytes = b""
    omit_host: bool = False


def _is_alnum(c: int) -> bool:
    return (0x30 <= c <= 0x39) or (0x41 <= c <= 0x5A) or (0x61 <= c <= 0x7A)


def _is_hex(c: int) -> bool:
    return (0x30 <= c <= 0x39) or (0x41 <= c <= 0x46) or (0x61 <= c <= 0x66)


def _unhex(c: int) -> int:
    if 0x30 <= c <= 0x39:
        return c - 0x30
    if 0x61 <= c <= 0x66:
        return c - 0x61 + 10
    return c - 0x41 + 10


def _should_escape(c: int, mode: _Mode) -> bool:
    if _is_alnum(c):
        return False
    if mode in (_Mode.HOST, _Mode.ZONE) and c in _HOST_OK:
        return False
    if c in _UNRESERVED_PUNCT:
        return False
    if c in _GEN_DELIMS:
        if mode is _Mode.PATH:
            return c == ord("?")
        if mode is _Mode.USER_PASSWORD:
            return c in (ord("@"), ord("/"), ord("?"), ord(":"))
        return mode is not _Mode.FRAGMENT
    return not (mode is _Mode.FRAGMENT and c in _FRAG_OK)


def _unescape(s: bytes, mode: _Mode) -> bytes:
    n = 0
    i = 0
    length = len(s)
    while i < length:
        c = s[i]
        if c == 0x25:  # '%'
            n += 1
            if i + 2 >= length or not _is_hex(s[i + 1]) or not _is_hex(s[i + 2]):
                raise _InvalidURLError
            pct25 = s[i : i + 3] == b"%25"
            if mode is _Mode.HOST and _unhex(s[i + 1]) < 8 and not pct25:
                raise _InvalidURLError
            if mode is _Mode.ZONE:
                v = (_unhex(s[i + 1]) << 4) | _unhex(s[i + 2])
                if not pct25 and v != 0x20 and _should_escape(v, _Mode.HOST):
                    raise _InvalidURLError
            i += 3
        else:
            if mode in (_Mode.HOST, _Mode.ZONE) and c < 0x80 and _should_escape(c, mode):
                raise _InvalidURLError
            i += 1
    if n == 0:
        return s
    out = bytearray(length - 2 * n)
    j = 0
    i = 0
    while i < length:
        if s[i] == 0x25:
            out[j] = (_unhex(s[i + 1]) << 4) | _unhex(s[i + 2])
            i += 3
        else:
            out[j] = s[i]
            i += 1
        j += 1
    return bytes(out)


def _escape(s: bytes, mode: _Mode) -> bytes:
    count = sum(1 for c in s if _should_escape(c, mode))
    if count == 0:
        return s
    out = bytearray(len(s) + 2 * count)
    j = 0
    for c in s:
        if _should_escape(c, mode):
            out[j] = 0x25
            out[j + 1] = ord(_HEX_UPPER[c >> 4])
            out[j + 2] = ord(_HEX_UPPER[c & 0x0F])
            j += 3
        else:
            out[j] = c
            j += 1
    return bytes(out)


def _valid_encoded(s: bytes, mode: _Mode) -> bool:
    for c in s:
        if c in _VALID_ENC_EXTRA:
            continue
        if _should_escape(c, mode):
            return False
    return True


def _valid_optional_port(port: bytes) -> bool:
    if not port:
        return True
    if port[0] != ord(":"):
        return False
    return all(0x30 <= c <= 0x39 for c in port[1:])


def _valid_userinfo(s: bytes) -> bool:
    return all(_is_alnum(c) or c in _USERINFO_PUNCT for c in s)


def _get_scheme(raw: bytes) -> tuple[bytes, bytes]:
    for i, c in enumerate(raw):
        if (0x41 <= c <= 0x5A) or (0x61 <= c <= 0x7A):
            continue
        if (0x30 <= c <= 0x39) or c in (ord("+"), ord("-"), ord(".")):
            if i == 0:
                return b"", raw
            continue
        if c == ord(":"):
            if i == 0:
                raise _InvalidURLError
            return raw[:i], raw[i + 1 :]
        return b"", raw
    return b"", raw


def _valid_ipv4(s: bytes) -> bool:
    val = 0
    pos = 0
    dig_len = 0
    length = len(s)
    for i, c in enumerate(s):
        if 0x30 <= c <= 0x39:
            if dig_len == 1 and val == 0:
                return False
            val = val * 10 + (c - 0x30)
            dig_len += 1
            if val > 255:
                return False
        elif c == ord("."):
            if i == 0 or i == length - 1 or s[i - 1] == ord("."):
                return False
            if pos == 3:
                return False
            pos += 1
            val = 0
            dig_len = 0
        else:
            return False
    return pos == 3


def _parse_ipv6(data: bytes) -> bool:
    s = data
    pct = s.find(b"%")
    if pct != -1:
        if pct + 1 == len(s):
            return False
        s = s[:pct]
    ellipsis: int | None = None
    if len(s) >= 2 and s[0] == ord(":") and s[1] == ord(":"):
        ellipsis = 0
        s = s[2:]
        if not s:
            return True
    i = 0
    while i < 16:
        off = 0
        acc = 0
        while off < len(s):
            c = s[off]
            if not _is_hex(c):
                break
            acc = (acc << 4) + _unhex(c)
            if off > 3 or acc > 0xFFFF:
                return False
            off += 1
        if off == 0:
            return False
        if off < len(s) and s[off] == ord("."):
            if ellipsis is None and i != 12:
                return False
            if i + 4 > 16 or not _valid_ipv4(s):
                return False
            s = b""
            i += 4
            break
        i += 2
        s = s[off:]
        if not s:
            break
        if s[0] != ord(":") or len(s) == 1:
            return False
        s = s[1:]
        if s[0] == ord(":"):
            if ellipsis is not None:
                return False
            ellipsis = i
            s = s[1:]
            if not s:
                break
    if s:
        return False
    return (i < 16) == (ellipsis is not None)


def _is_ipv6_literal(s: bytes) -> bool:
    for c in s:
        if c in (ord("."), ord("%")):
            return False
        if c == ord(":"):
            return _parse_ipv6(s)
    return False


def _parse_host(scheme: str, host: bytes) -> bytes:
    open_idx = host.rfind(b"[")
    if open_idx != -1:
        if open_idx > 0:
            raise _InvalidURLError
        close_idx = host.rfind(b"]")
        if close_idx == -1:
            raise _InvalidURLError
        colon_port = host[close_idx + 1 :]
        if not _valid_optional_port(colon_port):
            raise _InvalidURLError
        port = _unescape(colon_port, _Mode.HOST)
        hostname = host[1:close_idx]
        zone = hostname.find(b"%25")
        if zone != -1:
            unescaped = _unescape(hostname[:zone], _Mode.HOST) + _unescape(
                hostname[zone:], _Mode.ZONE
            )
        else:
            unescaped = _unescape(hostname, _Mode.HOST)
        if not _is_ipv6_literal(unescaped):
            raise _InvalidURLError
        return b"[" + unescaped + b"]" + port
    first = host.find(b":")
    if first != -1:
        idx = first
        last = host.rfind(b":")
        if last != first and scheme not in ("http", "https"):
            idx = last
        if not _valid_optional_port(host[idx:]):
            raise _InvalidURLError
    return _unescape(host, _Mode.HOST)


def _parse_authority(url: _Url, authority: bytes) -> None:
    at = authority.rfind(b"@")
    url.host = _parse_host(url.scheme, authority[at + 1 :] if at != -1 else authority)
    if at == -1:
        return
    userinfo = authority[:at]
    if not _valid_userinfo(userinfo):
        raise _InvalidURLError
    colon = userinfo.find(b":")
    if colon != -1:
        _unescape(userinfo[:colon], _Mode.USER_PASSWORD)
        _unescape(userinfo[colon + 1 :], _Mode.USER_PASSWORD)
    else:
        _unescape(userinfo, _Mode.USER_PASSWORD)
    url.has_user = True


def _parse_reference(raw: bytes) -> _Url:
    for c in raw:
        if c < 0x20 or c == 0x7F:
            raise _InvalidURLError
    url = _Url()
    if raw == b"*":
        url.path = b"*"
        return url
    scheme_bytes, rest = _get_scheme(raw)
    url.scheme = scheme_bytes.decode("ascii").lower()
    if rest.endswith(b"?") and rest.count(b"?") == 1:
        rest = rest[:-1]
    else:
        q = rest.find(b"?")
        if q != -1:
            rest = rest[:q]
    if not rest.startswith(b"/"):
        if url.scheme:
            url.opaque_text = rest
            return url
        slash = rest.find(b"/")
        segment = rest[:slash] if slash != -1 else rest
        if b":" in segment:
            raise _InvalidURLError
    if (url.scheme or not rest.startswith(b"///")) and rest.startswith(b"//"):
        authority = rest[2:]
        rest = b""
        slash = authority.find(b"/")
        if slash != -1:
            rest = authority[slash:]
            authority = authority[:slash]
        _parse_authority(url, authority)
    elif url.scheme and rest.startswith(b"/"):
        url.omit_host = True
    url.path = _unescape(rest, _Mode.PATH)
    escaped = _escape(url.path, _Mode.PATH)
    url.raw_path = b"" if rest == escaped else rest
    return url


def _parse(raw: bytes) -> _Url:
    h = raw.find(b"#")
    url = _parse_reference(raw[:h] if h != -1 else raw)
    if h != -1 and h + 1 < len(raw):
        _unescape(raw[h + 1 :], _Mode.FRAGMENT)
    return url


def _escaped_path(url: _Url) -> bytes:
    if url.raw_path and _valid_encoded(url.raw_path, _Mode.PATH):
        try:
            p = _unescape(url.raw_path, _Mode.PATH)
        except _InvalidURLError:
            p = None
        if p == url.path:
            return url.raw_path
    if url.path == b"*":
        return b"*"
    return _escape(url.path, _Mode.PATH)


def _format(url: _Url) -> bytes:
    out = bytearray()
    if url.scheme:
        out.extend(url.scheme.encode("ascii"))
        out.append(ord(":"))
    if url.opaque_text:
        out.extend(url.opaque_text)
        return bytes(out)
    if (url.scheme or url.host) and not (url.omit_host and not url.host):
        if url.host or url.path:
            out.extend(b"//")
        if url.host:
            out.extend(_escape(url.host, _Mode.HOST))
    path = _escaped_path(url)
    if path and path[0] != ord("/") and url.host:
        out.append(ord("/"))
    if not out:
        slash = path.find(b"/")
        segment = path[:slash] if slash != -1 else path
        if b":" in segment:
            out.extend(b"./")
    out.extend(path)
    return bytes(out)


def sanitize_endpoint(raw: str) -> str:
    """Strip userinfo, query, and fragment from an OTLP endpoint, matching Go.

    Any ambiguous or malformed value returns "unparseable" so credentials are
    never echoed.
    """
    return sanitize_endpoint_bytes(raw.encode("utf-8"))


def sanitize_endpoint_bytes(raw: bytes) -> str:
    """Byte-level implementation of sanitize_endpoint matching Go's net/url."""
    schemeless = b"://" not in raw
    data = b"//" + raw if schemeless else raw
    try:
        url = _parse(data)
    except _InvalidURLError:
        return WITHHELD
    if not url.host:
        return WITHHELD
    ats = data.count(b"@")
    if ats > 1 or (ats == 1 and not url.has_user):
        return WITHHELD
    out = _format(url)
    if b"@" in out:
        return WITHHELD
    if schemeless and out.startswith(b"//"):
        out = out[2:]
    return out.decode("ascii")
