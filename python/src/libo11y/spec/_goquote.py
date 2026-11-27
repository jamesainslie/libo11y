"""Go %q quoting (strconv.Quote) using specgen's GO_PRINT_RANGES table."""

from __future__ import annotations

from bisect import bisect_left

from libo11y.spec._generated.goprint import GO_PRINT_RANGES

_SHORT_ESCAPES: dict[str, str] = {
    "\x07": r"\a",
    "\b": r"\b",
    "\f": r"\f",
    "\n": r"\n",
    "\r": r"\r",
    "\t": r"\t",
    "\v": r"\v",
}


def is_go_print(cp: int) -> bool:
    """Report whether code point cp lies in Go's unicode.IsPrint table."""
    idx = bisect_left(GO_PRINT_RANGES, cp)
    return idx < len(GO_PRINT_RANGES) and (idx % 2 == 1 or GO_PRINT_RANGES[idx] == cp)


def go_quote(s: str) -> str:
    """Quote s as Go's fmt %q verb (strconv.Quote) does."""
    parts: list[str] = ['"']
    for ch in s:
        cp = ord(ch)
        if ch in ('"', "\\"):
            parts.append("\\" + ch)
        elif is_go_print(cp):
            parts.append(ch)
        elif ch in _SHORT_ESCAPES:
            parts.append(_SHORT_ESCAPES[ch])
        elif cp < 0x20 or cp == 0x7F:
            parts.append(f"\\x{cp:02x}")
        elif cp < 0x10000:
            parts.append(f"\\u{cp:04x}")
        else:
            parts.append(f"\\U{cp:08x}")
    parts.append('"')
    return "".join(parts)
