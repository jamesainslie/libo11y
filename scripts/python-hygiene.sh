#!/usr/bin/env bash
# python-hygiene.sh: fail on print, breakpoint, bare except, or
# except BaseException in Python library code outside tests.
#
# Usage: python-hygiene.sh [PATH...]
#
# Each PATH is a directory searched for *.py files or a single file. The
# default is python/src. Directories named .venv, __pycache__, .pytest_cache,
# .ruff_cache, build and dist are skipped. Files under tests/ or named
# test_*.py or *_test.py are not checked.
set -euo pipefail

usage() {
	echo "usage: python-hygiene.sh [PATH...]" >&2
	exit 2
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if (($# == 0)); then
	set -- "$root/python/src"
fi

for path in "$@"; do
	[[ -n "$path" ]] || usage
	if [[ ! -e "$path" ]]; then
		echo "python-hygiene: $path: no such file or directory" >&2
		usage
	fi
done

python3 - "$@" <<'PY'
import ast
import os
import sys

SKIP_DIRS = {".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "build", "dist"}


def is_test_file(path: str, rel: str) -> bool:
    parts = rel.replace("\\", "/").split("/")
    if "tests" in parts[:-1]:
        return True
    base = os.path.basename(path)
    return base.startswith("test_") or base.endswith("_test.py")


def collect_files(paths: list[str]) -> list[str]:
    out: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            root_dir = os.path.normpath(p)
            for dirpath, dirnames, filenames in os.walk(root_dir):
                dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
                for fn in sorted(filenames):
                    if not fn.endswith(".py"):
                        continue
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, root_dir)
                    if is_test_file(full, rel):
                        continue
                    out.append(full)
        elif os.path.isfile(p):
            if p.endswith(".py") and not is_test_file(p, os.path.basename(p)):
                out.append(p)
    out.sort()
    return out


def is_base_exception(expr: ast.expr) -> bool:
    if isinstance(expr, ast.Name) and expr.id == "BaseException":
        return True
    if (
        isinstance(expr, ast.Attribute)
        and expr.attr == "BaseException"
        and isinstance(expr.value, ast.Name)
        and expr.value.id == "builtins"
    ):
        return True
    if isinstance(expr, ast.Tuple):
        return any(is_base_exception(elt) for elt in expr.elts)
    return False


def forbidden_call_name(func: ast.expr) -> str | None:
    if isinstance(func, ast.Name) and func.id in {"print", "breakpoint"}:
        return func.id
    if (
        isinstance(func, ast.Attribute)
        and func.attr in {"print", "breakpoint"}
        and isinstance(func.value, ast.Name)
        and func.value.id == "builtins"
    ):
        return f"builtins.{func.attr}"
    return None


files = collect_files(sys.argv[1:])
violations: list[str] = []

for path in files:
    with open(path, encoding="utf-8") as fh:
        source = fh.read()
    lines = source.splitlines()
    tree = ast.parse(source, filename=path)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = forbidden_call_name(node.func)
            if name is not None:
                lineno = node.lineno
                text = lines[lineno - 1].strip() if 1 <= lineno <= len(lines) else ""
                violations.append(f"{path}:{lineno}: {name} outside a test: {text}")
        elif isinstance(node, ast.ExceptHandler):
            lineno = node.lineno
            text = lines[lineno - 1].strip() if 1 <= lineno <= len(lines) else ""
            if node.type is None:
                violations.append(f"{path}:{lineno}: bare except outside a test: {text}")
            elif is_base_exception(node.type):
                violations.append(f"{path}:{lineno}: except BaseException outside a test: {text}")

if violations:
    for v in violations:
        print(v, file=sys.stderr)
    print(f"python-hygiene: {len(violations)} forbidden construct(s) outside tests", file=sys.stderr)
    sys.exit(1)

print(f"python-hygiene: no forbidden constructs outside tests in {len(files)} files")
PY
