"""SQL query sanitization and operation/collection summarization matching go/o11ysql."""

from __future__ import annotations

from enum import Enum
from typing import Final


class Dialect(Enum):
    """Lexical SQL dialect selecting literal and comment rules."""

    STANDARD = "standard"
    MYSQL = "mysql"
    SQLITE = "sqlite"


MAX_COLLECTION_LEN: Final[int] = 128
MAX_QUERY_TEXT_BYTES: Final[int] = 4096

_OPERATIONS: Final[frozenset[str]] = frozenset(
    {
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "MERGE",
        "REPLACE",
        "UPSERT",
        "CREATE",
        "ALTER",
        "DROP",
        "TRUNCATE",
        "CALL",
        "EXEC",
        "EXECUTE",
        "BEGIN",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "PRAGMA",
        "VACUUM",
        "ANALYZE",
        "EXPLAIN",
        "SHOW",
        "SET",
    }
)

_UPDATE_CLAUSE: Final[frozenset[str]] = frozenset(
    {"FOR", "KEY", "DO", "THEN", "OR", "BEFORE", "AFTER", "OF"}
)

_TABLE_MODIFIERS: Final[frozenset[str]] = frozenset({"ONLY", "LOW_PRIORITY", "IGNORE"})


def _is_digit(c: str) -> bool:
    return "0" <= c <= "9"


def _is_ident_start(c: str) -> bool:
    o = ord(c)
    return c == "_" or ("a" <= c <= "z") or ("A" <= c <= "Z") or o >= 0x80


def _is_ident_part(c: str) -> bool:
    return _is_ident_start(c) or _is_digit(c)


def _is_ident_cont(c: str) -> bool:
    return _is_ident_part(c) or c == "$"


def _is_name_start(c: str) -> bool:
    return _is_ident_start(c) or c in ('"', "`")


def _is_space(c: str) -> bool:
    return c in (" ", "\t", "\n", "\f", "\r")


def _next(s: str, i: int) -> str:
    return s[i + 1] if i + 1 < len(s) else ""


def _skip_ident(s: str, i: int) -> int:
    i += 1
    n = len(s)
    while i < n and _is_ident_cont(s[i]):
        i += 1
    return i


def _skip_digits(s: str, i: int) -> int:
    n = len(s)
    while i < n and _is_digit(s[i]):
        i += 1
    return i


def _skip_quoted(s: str, i: int, quote: str, backslash: bool) -> tuple[int, bool]:
    j = i + 1
    n = len(s)
    while j < n:
        ch = s[j]
        if ch == "\\" and backslash:
            j += 2
            continue
        if ch == quote:
            if j + 1 < n and s[j + 1] == quote:
                j += 2
                continue
            return j + 1, True
        j += 1
    return n, False


def _skip_quoted_name(s: str, i: int) -> tuple[int, bool]:
    if s[i] != "[":
        return _skip_quoted(s, i, s[i], False)
    end = s.find("]", i + 1)
    if end >= 0:
        return end + 1, True
    return len(s), False


def _mysql_dash_comment(s: str, i: int) -> bool:
    if i + 2 >= len(s):
        return True
    o = ord(s[i + 2])
    return o <= 0x20 or o == 0x7F


def _skip_line(s: str, i: int) -> int:
    end = s.find("\n", i)
    return end if end >= 0 else len(s)


def _skip_block(s: str, i: int, nested: bool) -> int:
    depth = 0
    j = i
    n = len(s)
    while j + 1 < n:
        if s[j] == "/" and s[j + 1] == "*" and (nested or depth == 0):
            depth += 1
            j += 2
        elif s[j] == "*" and s[j + 1] == "/":
            depth -= 1
            j += 2
            if depth == 0:
                return j
        else:
            j += 1
    return n


def _skip_versioned_open(s: str, i: int) -> tuple[int, bool]:
    j = i + 2
    n = len(s)
    if j < n and s[j] == "M":
        j += 1
    if j >= n or s[j] != "!":
        return 0, False
    return _skip_digits(s, j + 1), True


def _skip_dollar_quoted(s: str, i: int) -> tuple[int, bool]:
    j = i + 1
    n = len(s)
    if j < n and _is_ident_start(s[j]):
        j += 1
        while j < n and _is_ident_part(s[j]):
            j += 1
    if j >= n or s[j] != "$":
        return 0, False
    tag = s[i : j + 1]
    body = j + 1
    end = s.find(tag, body)
    if end >= 0:
        return end + len(tag), True
    return n, True


def _skip_sqlite_parameter(s: str, i: int) -> tuple[int, bool]:
    j = i + 1
    count = 0
    n = len(s)
    while j < n:
        ch = s[j]
        if _is_ident_cont(ch):
            count += 1
            j += 1
        elif ch == "(" and count > 0:
            j += 1
            while j < n and s[j] != ")" and not _is_space(s[j]):
                j += 1
            if j < n and s[j] == ")":
                j += 1
            return j, False
        elif ch == ":" and _next(s, j) == ":":
            j += 2
        else:
            if count == 0:
                return i + 1, True
            return j, True
    if count == 0:
        return i + 1, True
    return j, True


def _skip_number(s: str, i: int) -> int:
    is_hex = s[i] == "0" and _next(s, i) in ("x", "X")
    i += 1
    n = len(s)
    while i < n:
        ch = s[i]
        if not is_hex and ch in ("e", "E") and _next(s, i) == "'":
            return i
        if (
            _is_ident_part(ch)
            or ch == "."
            or (ch in ("+", "-") and s[i - 1] in ("e", "E") and _is_digit(_next(s, i)))
        ):
            i += 1
        else:
            return i
    return i


def sanitize(query: str, dialect: Dialect = Dialect.STANDARD) -> str:
    """Replace every SQL literal with '?' and every comment with a single space."""
    out: list[str] = []
    mysql = dialect is Dialect.MYSQL
    sqlite = dialect is Dialect.SQLITE
    pg = not mysql and not sqlite
    in_versioned = False
    i = 0
    n = len(query)

    while i < n:
        c = query[i]
        if c == "'":
            i, _ = _skip_quoted(query, i, "'", mysql)
            out.append("?")
        elif pg and c in ("E", "e") and _next(query, i) == "'":
            i, _ = _skip_quoted(query, i + 1, "'", True)
            out.append("?")
        elif c == '"' and not pg:
            i, _ = _skip_quoted(query, i, '"', mysql)
            out.append("?")
        elif c == '"' or (c == "`" and not pg) or (c == "[" and sqlite):
            end, closed = _skip_quoted_name(query, i)
            out.append(query[i:end] if closed else "?")
            i = end
        elif (
            c == "-" and _next(query, i) == "-" and (not mysql or _mysql_dash_comment(query, i))
        ) or (c == "#" and mysql):
            i = _skip_line(query, i)
            out.append(" ")
        elif c == "/" and _next(query, i) == "*":
            end_v, ok_v = _skip_versioned_open(query, i)
            if ok_v and mysql:
                in_versioned = True
                i = end_v
            else:
                i = _skip_block(query, i, pg)
            out.append(" ")
        elif in_versioned and c == "*" and _next(query, i) == "/":
            in_versioned = False
            i += 2
            out.append(" ")
        elif pg and c == "$":
            end_d, ok_d = _skip_dollar_quoted(query, i)
            if ok_d:
                out.append("?")
                i = end_d
                continue
            end = _skip_digits(query, i + 1)
            out.append(query[i:end])
            i = end
        elif sqlite and c in ("$", "@", ":", "#"):
            end, plain = _skip_sqlite_parameter(query, i)
            if end == i + 1:
                out.append(c)
            elif plain:
                out.append(query[i:end])
            else:
                out.append("?")
            i = end
        elif sqlite and c == "?":
            end = _skip_digits(query, i + 1)
            out.append(query[i:end])
            i = end
        elif _is_ident_start(c) or (mysql and c == "$"):
            end = _skip_ident(query, i)
            out.append(query[i:end])
            i = end
        elif _is_digit(c) or (c == "." and _is_digit(_next(query, i))):
            i = _skip_number(query, i)
            out.append("?")
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _skip_name(s: str, i: int) -> int:
    n = len(s)
    while True:
        if s[i] in ('"', "`"):
            i, _ = _skip_quoted(s, i, s[i], False)
        else:
            i = _skip_ident(s, i)
        if i + 1 < n and s[i] == "." and _is_name_start(s[i + 1]):
            i += 1
            continue
        return i


def _tokenize(s: str) -> list[str]:
    toks: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c in (" ", "\t", "\n", "\r"):
            i += 1
        elif _is_name_start(c):
            end = _skip_name(s, i)
            toks.append(s[i:end])
            i = end
        else:
            toks.append(c)
            i += 1
    return toks


def _names_table(keyword: str, toks: list[str], k: int) -> bool:
    prev = toks[k - 1].upper() if k > 0 else ""
    if keyword in ("JOIN", "INTO", "TABLE"):
        return True
    if keyword == "FROM":
        return prev != "DISTINCT"
    if keyword == "UPDATE":
        return prev not in _UPDATE_CLAUSE
    return False


def _skip_if_exists(toks: list[str], j: int) -> int:
    n = len(toks)
    if j >= n or toks[j].upper() != "IF":
        return j
    j += 1
    if j < n and toks[j].upper() == "NOT":
        j += 1
    if j < n and toks[j].upper() == "EXISTS":
        return j + 1
    return n


def _unquote_name(tok: str) -> str:
    if '"' not in tok and "`" not in tok:
        return tok
    out: list[str] = []
    i = 0
    n = len(tok)
    while i < n:
        q = tok[i]
        if q not in ('"', "`"):
            out.append(q)
            i += 1
            continue
        end, closed = _skip_quoted(tok, i, q, False)
        inner = tok[i + 1 : end - 1] if closed else tok[i + 1 : end]
        out.append(inner.replace(q + q, q))
        i = end
    return "".join(out)


def summarize(sanitized: str) -> tuple[str, str]:
    """Derive bounded (db.operation.name, db.collection.name) from sanitized SQL."""
    toks = _tokenize(sanitized)
    if not toks:
        return "", ""
    operation = toks[0].upper()
    if operation not in _OPERATIONS:
        return "", ""
    if operation == "SHOW":
        return operation, ""

    subquery: list[bool] = []
    collection = ""
    n = len(toks)
    for k in range(n - 1):
        tok = toks[k]
        if tok == "(":
            first = toks[k + 1].upper()
            subquery.append(first in ("SELECT", "WITH"))
            continue
        if tok == ")":
            if subquery:
                subquery.pop()
            continue
        if subquery and not subquery[-1]:
            continue

        keyword = tok.upper()
        if not _names_table(keyword, toks, k):
            continue
        j = k + 1
        if keyword == "TABLE":
            j = _skip_if_exists(toks, j)
        if keyword == "UPDATE" and j < n and toks[j].upper() == "OR":
            j += 2
        while j < n and toks[j].upper() in _TABLE_MODIFIERS:
            j += 1
        if j >= n or not toks[j] or not _is_name_start(toks[j][0]):
            return operation, ""
        if j + 1 < n and (
            toks[j + 1] == "," or (toks[j + 1] == "(" and keyword in ("FROM", "JOIN"))
        ):
            return operation, ""
        name = _unquote_name(toks[j])
        if collection and collection != name:
            return operation, ""
        collection = name

    if len(collection.encode("utf-8", errors="replace")) > MAX_COLLECTION_LEN:
        return operation, ""
    return operation, collection


def truncate_utf8(text: str, max_bytes: int = MAX_QUERY_TEXT_BYTES) -> str:
    """Ensure valid UTF-8 and truncate to at most max_bytes on a character boundary."""
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return encoded.decode("utf-8")
    cut = max_bytes
    while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
        cut -= 1
    return encoded[:cut].decode("utf-8")
