"""The libo11y command-line tool, run as ``python -m libo11y``.

``python -m libo11y registry check FILE...`` validates application attribute
registries against the libo11y policy rules, for use in a consumer's CI. It
matches the Go binary (``go/cmd/libo11y``) line for line.

Exit status: 0 when every file is valid, 1 when a file breaks a policy rule,
2 on a usage, read, or parse error. With several files the highest status
wins.
"""

from __future__ import annotations

import errno
import sys
from collections.abc import Sequence
from typing import Final, TextIO

from libo11y.spec.appregistry import (
    AppRegistryParseError,
    parse_app_registry_bytes,
    validate_app_registry,
)

USAGE: Final[str] = "usage: libo11y registry check FILE..."

# Go's os.ReadFile error for an errno: the operation that failed and its reason.
_GO_READ_ERRORS: Final[dict[int, tuple[str, str]]] = {
    errno.ENOENT: ("open", "no such file or directory"),
    errno.EACCES: ("open", "permission denied"),
    errno.EPERM: ("open", "operation not permitted"),
    errno.EISDIR: ("read", "is a directory"),
}


def _read_error(path: str, exc: OSError) -> str:
    """Render a failed read as Go's os.ReadFile error reads."""
    known = _GO_READ_ERRORS.get(exc.errno) if exc.errno is not None else None
    if known is not None:
        return f"{known[0]} {path}: {known[1]}"
    reason = exc.strerror or str(exc)
    return f"open {path}: {reason[:1].lower()}{reason[1:]}"


def _check_file(path: str, stdout: TextIO, stderr: TextIO) -> int:
    """Validate one registry file and return its exit status."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        stderr.write(f"{_read_error(path, exc)}\n")
        return 2
    try:
        reg = parse_app_registry_bytes(raw)
    except AppRegistryParseError as exc:
        stderr.write(f"{path}: {exc}\n")
        return 2
    violations = validate_app_registry(reg)
    for v in violations:
        stdout.write(f"{path}: {v}\n")
    if violations:
        return 1
    n = len(reg.attributes)
    noun = "attribute" if n == 1 else "attributes"
    stdout.write(f"{path}: ok ({n} {noun} in namespace {reg.namespace})\n")
    return 0


def main(
    argv: Sequence[str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Run the command line and return its exit status.

    argv defaults to ``sys.argv[1:]``, and the streams to ``sys.stdout`` and
    ``sys.stderr``.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    if len(args) == 1 and args[0] in ("-h", "--help", "help"):
        out.write(f"{USAGE}\n")
        return 0
    if len(args) < 3 or args[0] != "registry" or args[1] != "check":
        err.write(f"{USAGE}\n")
        return 2
    status = 0
    for path in args[2:]:
        status = max(status, _check_file(path, out, err))
    return status


if __name__ == "__main__":
    # Go writes UTF-8 whatever the locale, and so does this command.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    raise SystemExit(main())
