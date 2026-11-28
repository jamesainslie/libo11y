"""Packaging contract: metadata, the pytest plugin entry point, and the built artifacts."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path
from typing import Any, cast

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent
PYPROJECT: dict[str, Any] = tomllib.loads((PYTHON_DIR / "pyproject.toml").read_text("utf-8"))
PROJECT = cast(dict[str, Any], PYPROJECT["project"])


def test_pytest_plugin_loads_without_importing_libo11y() -> None:
    script = (
        "import importlib.metadata, sys\n"
        "(ep,) = [e for e in importlib.metadata.entry_points(group='pytest11')"
        " if e.name == 'libo11y']\n"
        "ep.load()\n"
        "loaded = sorted(m for m in sys.modules if m == 'libo11y' or m.startswith('libo11y.'))\n"
        "sys.stdout.write(repr(loaded))\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=60, check=True
    )
    assert out.stdout == "[]"


def test_classifiers_name_the_platforms_ci_covers() -> None:
    classifiers = cast(list[str], PROJECT["classifiers"])
    assert "Operating System :: OS Independent" not in classifiers
    assert "Operating System :: POSIX :: Linux" in classifiers
    assert "Operating System :: MacOS" in classifiers


def test_python_classifiers_match_requires_python() -> None:
    assert PROJECT["requires-python"] == ">=3.12"
    versions = sorted(
        c.rsplit(" :: ", 1)[1]
        for c in cast(list[str], PROJECT["classifiers"])
        if c.startswith("Programming Language :: Python :: 3.")
    )
    assert versions == ["3.12", "3.13", "3.14"]


def test_license_text_ships_from_the_project_directory() -> None:
    assert PROJECT["license"] == "Apache-2.0"
    assert PROJECT["license-files"] == ["LICENSE"]
    text = (PYTHON_DIR / "LICENSE").read_text("utf-8")
    assert "Apache License" in text
    assert "Version 2.0" in text


@pytest.fixture(scope="module")
def dist(tmp_path_factory: pytest.TempPathFactory) -> Path:
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not on PATH")
    out = tmp_path_factory.mktemp("dist")
    subprocess.run(
        [uv, "build", "--offline", "--quiet", "--out-dir", str(out), str(PYTHON_DIR)],
        check=True,
        timeout=300,
        capture_output=True,
    )
    return out


def _wheel_names(dist: Path) -> list[str]:
    (wheel,) = dist.glob("libo11y-*.whl")
    with zipfile.ZipFile(wheel) as zf:
        return zf.namelist()


def _sdist_names(dist: Path) -> list[str]:
    (sdist,) = dist.glob("libo11y-*.tar.gz")
    with tarfile.open(sdist, "r:gz") as tf:
        return tf.getnames()


def test_wheel_ships_license_typing_marker_and_plugin(dist: Path) -> None:
    names = _wheel_names(dist)
    assert any(n.endswith(".dist-info/licenses/LICENSE") for n in names)
    assert "libo11y/py.typed" in names
    assert "_libo11y_pytest.py" in names
    assert "libo11y/__main__.py" in names


def test_wheel_ships_no_tests_or_conformance_files(dist: Path) -> None:
    names = _wheel_names(dist)
    assert [n for n in names if n.split("/")[0] in {"tests", "conformance"}] == []
    assert [n for n in names if "/conformance/" in n] == []


def test_sdist_ships_license_and_no_tests_or_conformance_files(dist: Path) -> None:
    names = _sdist_names(dist)
    root = names[0].split("/")[0]
    assert f"{root}/LICENSE" in names
    assert f"{root}/src/libo11y/py.typed" in names
    assert f"{root}/src/_libo11y_pytest.py" in names
    assert [n for n in names if {"tests", "conformance"} & set(n.split("/"))] == []
