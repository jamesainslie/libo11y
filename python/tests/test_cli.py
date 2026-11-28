"""Tests for the ``python -m libo11y registry check`` command and the build-info command."""

from __future__ import annotations

import io
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

import libo11y
from libo11y.__main__ import USAGE, main

CONFORMANCE = Path(__file__).resolve().parents[2] / "conformance" / "appregistry"
CASES = sorted(CONFORMANCE.glob("*.yaml"))

VALID_ONE = (
    "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n"
    "  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n"
)
VALID_TWO = VALID_ONE + (
    "  lor.user.role: {type: string, sensitivity: public, cardinality: enum,"
    " values: [studio, client]}\n"
)
RESERVED = (
    "schema: libo11y.app-registry/v1\nnamespace: http\nattributes:\n"
    "  http.thing: {type: string, sensitivity: public, cardinality: bounded}\n"
)
BROKEN = "schema: [\n"


def _write(tmp_path: Path, name: str, body: str) -> str:
    path = tmp_path / name
    path.write_text(body, encoding="utf-8")
    return str(path)


def _run(*args: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = main(list(args), out, err)
    return code, out.getvalue(), err.getvalue()


def test_valid_registry_prints_ok_with_a_singular_attribute(tmp_path: Path) -> None:
    path = _write(tmp_path, "one.yaml", VALID_ONE)
    assert _run("registry", "check", path) == (
        0,
        f"{path}: ok (1 attribute in namespace lor)\n",
        "",
    )


def test_valid_registry_prints_ok_with_plural_attributes(tmp_path: Path) -> None:
    path = _write(tmp_path, "two.yaml", VALID_TWO)
    assert _run("registry", "check", path) == (
        0,
        f"{path}: ok (2 attributes in namespace lor)\n",
        "",
    )


def test_violations_print_one_line_each_on_stdout_and_exit_one(tmp_path: Path) -> None:
    path = _write(tmp_path, "reserved.yaml", RESERVED)
    code, out, err = _run("registry", "check", path)
    assert code == 1
    assert err == ""
    lines = out.splitlines()
    assert lines
    assert lines[0].startswith(f"{path}: libo11y_app_namespace_reserved: ")
    attribute_line = re.compile(rf"^{re.escape(path)}: [a-z0-9_]+: attribute [a-z0-9_.]+: .+$")
    registry_line = re.compile(rf"^{re.escape(path)}: [a-z0-9_]+: .+$")
    assert all(attribute_line.match(ln) or registry_line.match(ln) for ln in lines)


def test_unparsable_registry_reports_on_stderr_and_exits_two(tmp_path: Path) -> None:
    path = _write(tmp_path, "broken.yaml", BROKEN)
    code, out, err = _run("registry", "check", path)
    assert (code, out) == (2, "")
    assert err.startswith(f"{path}: parsing application registry: ")
    assert err.endswith("\n")


def test_missing_file_reports_go_read_error(tmp_path: Path) -> None:
    path = str(tmp_path / "nope.yaml")
    assert _run("registry", "check", path) == (
        2,
        "",
        f"open {path}: no such file or directory\n",
    )


def test_directory_reports_go_read_error(tmp_path: Path) -> None:
    assert _run("registry", "check", str(tmp_path)) == (
        2,
        "",
        f"read {tmp_path}: is a directory\n",
    )


def test_highest_status_wins_across_files(tmp_path: Path) -> None:
    valid = _write(tmp_path, "valid.yaml", VALID_ONE)
    reserved = _write(tmp_path, "reserved.yaml", RESERVED)
    broken = _write(tmp_path, "broken.yaml", BROKEN)
    code, out, err = _run("registry", "check", valid, reserved, broken, valid)
    assert code == 2
    assert out.splitlines()[0] == f"{valid}: ok (1 attribute in namespace lor)"
    assert f"{reserved}: libo11y_app_namespace_reserved: " in out
    assert out.splitlines()[-1] == f"{valid}: ok (1 attribute in namespace lor)"
    assert err.startswith(f"{broken}: parsing application registry: ")

    assert _run("registry", "check", valid, reserved)[0] == 1


@pytest.mark.parametrize(
    "args",
    [(), ("registry",), ("registry", "check"), ("lint",), ("registry", "lint", "x.yaml")],
)
def test_usage_errors_print_usage_on_stderr_and_exit_two(args: tuple[str, ...]) -> None:
    assert _run(*args) == (2, "", f"{USAGE}\n")


@pytest.mark.parametrize("flag", ["-h", "--help", "help"])
def test_help_prints_usage_on_stdout_and_exits_zero(flag: str) -> None:
    assert _run(flag) == (0, f"{USAGE}\n", "")


def test_usage_text_matches_the_go_binary() -> None:
    assert USAGE == "usage: libo11y registry check FILE..."


def _module(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(
        [sys.executable, "-m", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
        cwd=cwd,
        env=env,
    )


def test_python_dash_m_libo11y_runs_the_command(tmp_path: Path) -> None:
    valid = _write(tmp_path, "valid.yaml", VALID_ONE)
    reserved = _write(tmp_path, "reserved.yaml", RESERVED)
    res = _module("libo11y", "registry", "check", valid, reserved)
    assert res.returncode == 1
    assert res.stdout.splitlines()[0] == f"{valid}: ok (1 attribute in namespace lor)"
    assert res.stdout.splitlines()[1].startswith(f"{reserved}: libo11y_app_namespace_reserved: ")
    assert res.stderr == ""


def test_python_dash_m_libo11y_without_arguments_is_a_usage_error() -> None:
    res = _module("libo11y")
    assert (res.returncode, res.stdout, res.stderr) == (2, "", f"{USAGE}\n")


def _expected(case: Path) -> tuple[int, list[str]]:
    want = case.with_suffix(".want").read_text(encoding="utf-8").splitlines()
    path = str(case)
    if want[0].startswith("parse: "):
        return 2, []
    if len(want) == 1 and (m := re.fullmatch(r"ok (\d+) (\S+)", want[0])):
        n = int(m.group(1))
        noun = "attribute" if n == 1 else "attributes"
        return 0, [f"{path}: ok ({n} {noun} in namespace {m.group(2)})"]
    return 1, [f"{path}: {line}" for line in want]


@pytest.mark.parametrize("case", CASES, ids=[c.stem for c in CASES])
def test_command_matches_the_conformance_case(case: Path) -> None:
    want_code, want_lines = _expected(case)
    code, out, err = _run("registry", "check", str(case))
    assert code == want_code
    assert out.splitlines() == want_lines
    if want_code == 2:
        assert err.startswith(f"{case}: parsing application registry: ")
    else:
        assert err == ""


def test_conformance_cases_are_present() -> None:
    assert len(CASES) > 10


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, timeout=30, text=True)


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "--quiet", "--initial-branch=main")
    # git background maintenance can lose a fresh commit in a throwaway repository.
    _git(repo, "config", "gc.auto", "0")
    _git(repo, "config", "maintenance.auto", "false")
    _git(repo, "config", "user.name", "libo11y test")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "commit.gpgsign", "false")
    _git(repo, "config", "core.hooksPath", str(tmp_path / "no-hooks"))
    (repo / "app.txt").write_text("v1\n", encoding="utf-8")
    _git(repo, "add", "app.txt")
    _git(repo, "commit", "--quiet", "-m", "initial")
    return repo


@pytest.mark.parametrize("dirty", [False, True])
def test_buildinfo_command_stamps_the_resource(git_repo: Path, tmp_path: Path, dirty: bool) -> None:
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=git_repo,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout.strip()
    if dirty:
        (git_repo / "app.txt").write_text("v2\n", encoding="utf-8")
    out = tmp_path / "build-info.json"

    res = _module("libo11y.buildinfo", str(out), cwd=git_repo)
    assert (res.returncode, res.stdout) == (0, "")

    tel = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="buildinfo-cli",
        environment="test",
        build_info=out,
        console_enabled=False,
        runtime_metrics=False,
        log_export=False,
    )
    try:
        attrs = tel.resource.attributes
        assert attrs["vcs.ref.head.revision"] == head
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", str(attrs["o11y.build.time"]))
        assert attrs["o11y.build.modified"] is dirty
    finally:
        tel.shutdown(timeout=5.0)
