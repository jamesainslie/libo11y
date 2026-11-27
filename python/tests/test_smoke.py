"""Smoke tests for the libo11y package skeleton."""

from __future__ import annotations

import libo11y


def test_package_imports() -> None:
    assert hasattr(libo11y, "__all__")
