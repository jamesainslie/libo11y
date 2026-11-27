"""Explicit environment reading and OTEL_* parsing for libo11y.

All environment reads pass through EnvView so hermetic mode (Options(env=HERMETIC))
never touches os.environ, and every setting is forwarded explicitly to the SDK.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from urllib.parse import unquote

from libo11y.options import HERMETIC, is_hermetic


class EnvView:
    """Explicit view over an environment mapping (os.environ or caller-supplied)."""

    def __init__(self, env: Mapping[str, str] | None) -> None:
        self.hermetic = is_hermetic(env)
        self._env: Mapping[str, str] = {} if self.hermetic else (os.environ if env is None else env)

    def get(self, key: str, default: str = "") -> str:
        val = self._env.get(key)
        return default if val is None else val

    def get_opt(self, key: str) -> str | None:
        val = self._env.get(key)
        if val is None or val == "":
            return None
        return val

    def get_bool(self, key: str, default: bool = False) -> bool:
        raw = self.get_opt(key)
        if raw is None:
            return default
        low = raw.strip().lower()
        if low in ("true", "1", "yes"):
            return True
        if low in ("false", "0", "no"):
            return False
        return default

    def get_int(self, key: str, default: int) -> int:
        raw = self.get_opt(key)
        if raw is None:
            return default
        try:
            return int(raw.strip())
        except ValueError:
            return default

    def get_float(self, key: str, default: float) -> float:
        raw = self.get_opt(key)
        if raw is None:
            return default
        try:
            return float(raw.strip())
        except ValueError:
            return default

    def sdk_disabled(self) -> bool:
        return self.get_bool("OTEL_SDK_DISABLED", False)


def parse_baggage_pairs(raw: str) -> dict[str, str]:
    """Parse W3C/OTEL comma-separated key=value pairs (headers or resource attributes)."""
    out: dict[str, str] = {}
    if not raw.strip():
        return out
    for item in raw.split(","):
        pair = item.strip()
        if not pair or "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        key = k.strip()
        if not key:
            continue
        out[key] = unquote(v.strip())
    return out


def parse_resource_attributes(env: EnvView) -> dict[str, str]:
    """Parse OTEL_RESOURCE_ATTRIBUTES from env."""
    raw = env.get("OTEL_RESOURCE_ATTRIBUTES")
    return parse_baggage_pairs(raw)


def parse_otlp_headers(env: EnvView, signal_upper: str) -> dict[str, str]:
    """Parse OTEL_EXPORTER_OTLP_HEADERS merged with signal-specific headers."""
    headers = parse_baggage_pairs(env.get("OTEL_EXPORTER_OTLP_HEADERS"))
    sig = parse_baggage_pairs(env.get(f"OTEL_EXPORTER_OTLP_{signal_upper}_HEADERS"))
    headers.update(sig)
    return headers


__all__ = [
    "HERMETIC",
    "EnvView",
    "parse_baggage_pairs",
    "parse_otlp_headers",
    "parse_resource_attributes",
]
