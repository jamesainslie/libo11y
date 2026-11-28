"""Explicit environment reading and OTEL_* parsing for libo11y.

All environment reads pass through EnvView so hermetic mode (Options(env=HERMETIC))
never touches os.environ, and every setting is forwarded explicitly to the SDK.
"""

from __future__ import annotations

import math
import os
import sys
from collections.abc import Mapping
from urllib.parse import unquote

from libo11y.options import HERMETIC, is_hermetic

SDK_DISABLED = "OTEL_SDK_DISABLED"


class EnvView:
    """Explicit view over an environment mapping (os.environ or caller-supplied).

    A variable that is empty or holds only white space is unset, for every
    reader here. An unparsable or out-of-range number uses the default, as
    the OpenTelemetry SDKs do, so a bad value never fails construction.
    """

    def __init__(self, env: Mapping[str, str] | None) -> None:
        self.hermetic = is_hermetic(env)
        # True when the process environment is read, which is when no mapping was given.
        self.ambient = env is None
        self._env: Mapping[str, str] = {} if self.hermetic else (os.environ if env is None else env)

    def get_opt(self, key: str) -> str | None:
        """Return the trimmed value of key, or None when it is unset or blank."""
        val = self._env.get(key)
        if val is None:
            return None
        trimmed = val.strip()
        return trimmed or None

    def get(self, key: str, default: str = "") -> str:
        """Return the trimmed value of key, or default when it is unset or blank."""
        val = self.get_opt(key)
        return default if val is None else val

    def first(self, *keys: str) -> str | None:
        """Return the first of keys that is set, in order."""
        for key in keys:
            val = self.get_opt(key)
            if val is not None:
                return val
        return None

    def get_bool(self, key: str, default: bool = False) -> bool:
        raw = self.get_opt(key)
        if raw is None:
            return default
        low = raw.lower()
        if low in ("true", "1", "yes"):
            return True
        if low in ("false", "0", "no"):
            return False
        return default

    def get_int(
        self, key: str, default: int, *, minimum: int | None = None, maximum: int = sys.maxsize
    ) -> int:
        """Read an integer, using the default if it cannot be parsed or is out of range."""
        raw = self.get_opt(key)
        if raw is None:
            return default
        try:
            value = int(raw)
        except ValueError:
            return default
        if value > maximum or (minimum is not None and value < minimum):
            return default
        return value

    def get_float(
        self,
        key: str,
        default: float,
        *,
        minimum: float | None = None,
        maximum: float | None = None,
    ) -> float:
        """Read a finite number. Unparsable, non-finite or out-of-range values are default."""
        raw = self.get_opt(key)
        if raw is None:
            return default
        try:
            value = float(raw)
        except ValueError:
            return default
        if not math.isfinite(value):
            return default
        if minimum is not None and value < minimum:
            return default
        if maximum is not None and value > maximum:
            return default
        return value

    def sdk_disabled(self) -> bool:
        """Report whether OTEL_SDK_DISABLED switches the SDK off.

        Only "true", in any case, does, as the OpenTelemetry specification
        defines boolean variables. Every other value, and an unset one, is false.
        """
        return self.get(SDK_DISABLED).lower() == "true"


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
    return {
        header.lower(): value
        for key in ("OTEL_EXPORTER_OTLP_HEADERS", f"OTEL_EXPORTER_OTLP_{signal_upper}_HEADERS")
        for header, value in parse_baggage_pairs(env.get(key)).items()
    }


__all__ = [
    "HERMETIC",
    "SDK_DISABLED",
    "EnvView",
    "parse_baggage_pairs",
    "parse_otlp_headers",
    "parse_resource_attributes",
]
