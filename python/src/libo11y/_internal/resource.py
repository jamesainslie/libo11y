"""Service identity validation and Resource composition."""

from __future__ import annotations

import importlib.metadata
import platform
import re
import socket
import sys
from pathlib import Path
from typing import Any

from opentelemetry.sdk.resources import Resource

from libo11y._internal.env import EnvView, parse_resource_attributes
from libo11y._internal.identity import derive_instance_id, random_instance_id
from libo11y._internal.policy import SensitivityPolicy, ViolationRecorder
from libo11y.buildinfo import read_build_info
from libo11y.errors import InvalidEnvironment, NoEnvironment, NoServiceName, O11yError
from libo11y.options import Options
from libo11y.spec import (
    ATTR_BUILD_MODIFIED,
    ATTR_BUILD_TIME,
    ATTR_CONTAINER_ID,
    ATTR_HOST_NAME,
    ATTR_K8S_NAMESPACE_NAME,
    ATTR_K8S_POD_NAME,
    ATTR_K8S_POD_UID,
    ATTR_PROCESS_RUNTIME_NAME,
    ATTR_PROCESS_RUNTIME_VERSION,
    ATTR_VCS_REF_HEAD_REVISION,
    ENVIRONMENT_VALUES,
    SCHEMA_URL,
    Signal,
)
from libo11y.spec._goquote import go_quote

_CONTAINER_ID_RE = re.compile(r"[0-9a-fA-F]{64}")

# Recorded, with a flag in the startup summary, when no version resolves. A
# missing version degrades telemetry and never blocks startup.
SERVICE_VERSION_FALLBACK = "0.0.0-unknown"

# Rules counted on o11y.schema.violations (signal "resource") when strict
# identity is off and the tier-0 identity contract is not met.
RULE_IDENTITY_SERVICE_NAME = "identity_service_name"
RULE_IDENTITY_ENVIRONMENT = "identity_environment"
RULE_IDENTITY_ENVIRONMENT_INVALID = "identity_environment_invalid"

_UNKNOWN_SERVICE = "unknown_service"


def _detect_container_id() -> str | None:
    if not sys.platform.startswith("linux"):
        return None
    for path in ("/proc/self/mountinfo", "/proc/self/cgroup"):
        try:
            text = Path(path).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        m = _CONTAINER_ID_RE.search(text)
        if m is not None:
            return m.group(0).lower()
    return None


def _detect_sdk_version() -> str:
    try:
        return importlib.metadata.version("libo11y")
    except importlib.metadata.PackageNotFoundError:
        return "0.0.0"


def _detect_distribution_version(dist_name: str | None) -> str | None:
    if not dist_name:
        return None
    try:
        return importlib.metadata.version(dist_name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _allowed_environments(opts: Options) -> frozenset[str]:
    if not opts.extra_environments:
        return ENVIRONMENT_VALUES
    return ENVIRONMENT_VALUES | frozenset(opts.extra_environments)


def _text(attrs: dict[str, Any], key: str) -> str:
    value = attrs.get(key)
    return "" if value is None else str(value)


def _has_service_name(attrs: dict[str, Any]) -> bool:
    """Report whether attrs carry a usable service identity.

    A usable name is not blank after trimming and is not the SDK's
    unknown_service fallback, whichever channel supplied it.
    """
    name = _text(attrs, "service.name").strip()
    return bool(name) and name != _UNKNOWN_SERVICE and not name.startswith(f"{_UNKNOWN_SERVICE}:")


def _enforce_identity(attrs: dict[str, Any], opts: Options) -> list[str]:
    """Apply the tier-0 identity contract.

    Under strict identity a violation raises. Otherwise each violation is
    returned as a rule name, to be counted on o11y.schema.violations.
    """
    problems: list[str] = []
    if not _has_service_name(attrs):
        if opts.strict_identity:
            raise NoServiceName()
        problems.append(RULE_IDENTITY_SERVICE_NAME)

    environment = _text(attrs, "deployment.environment.name")
    allowed = _allowed_environments(opts)
    if not environment:
        if opts.strict_identity:
            raise NoEnvironment()
        problems.append(RULE_IDENTITY_ENVIRONMENT)
    elif environment not in allowed:
        if opts.strict_identity:
            raise InvalidEnvironment(
                "o11y: deployment environment not in the allowed set: "
                f"{go_quote(environment)} (allowed: {', '.join(sorted(allowed))})"
            )
        problems.append(RULE_IDENTITY_ENVIRONMENT_INVALID)
    return problems


def build_resource(
    opts: Options,
    env: EnvView,
    policy: SensitivityPolicy,
    recorder: ViolationRecorder,
) -> tuple[Resource, bool]:
    """Compose, validate, and classify the SDK Resource.

    Precedence, lowest to highest: detected attributes and build info, then
    the environment (OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME), then
    explicit options. A blank option sets nothing.

    Returns (resource, version_fallback_used).
    """
    attrs: dict[str, Any] = {
        "telemetry.sdk.name": "libo11y",
        "telemetry.sdk.language": "python",
        "telemetry.sdk.version": _detect_sdk_version(),
        ATTR_HOST_NAME: socket.gethostname(),
        ATTR_PROCESS_RUNTIME_NAME: platform.python_implementation().lower(),
        ATTR_PROCESS_RUNTIME_VERSION: platform.python_version(),
    }

    cid = _detect_container_id()
    if cid:
        attrs[ATTR_CONTAINER_ID] = cid

    # Build info file (vcs.ref.head.revision, o11y.build.time, o11y.build.modified).
    if opts.build_info is not None:
        try:
            bi = read_build_info(opts.build_info)
        except (OSError, ValueError) as exc:
            raise O11yError(f"o11y: failed to read build_info {opts.build_info}: {exc}") from exc
        if bi.revision:
            attrs[ATTR_VCS_REF_HEAD_REVISION] = bi.revision
        if bi.build_time:
            attrs[ATTR_BUILD_TIME] = bi.build_time
        attrs[ATTR_BUILD_MODIFIED] = bi.modified

    # Environment resource attributes (OTEL_RESOURCE_ATTRIBUTES + OTEL_SERVICE_NAME).
    attrs.update(parse_resource_attributes(env))
    if env_svc := env.get_opt("OTEL_SERVICE_NAME"):
        attrs["service.name"] = env_svc

    # Explicit options take the highest precedence.
    attrs.update(opts.resource_attributes)
    for key, option in (
        ("service.name", opts.service_name),
        ("service.namespace", opts.service_namespace),
        ("deployment.environment.name", opts.environment),
        ("service.version", opts.version),
    ):
        if option is not None and (value := option.strip()):
            attrs[key] = value

    if not _text(attrs, "service.version") and (
        dist_version := _detect_distribution_version(opts.distribution)
    ):
        attrs["service.version"] = dist_version

    for rule in _enforce_identity(attrs, opts):
        recorder.record(Signal.RESOURCE, rule)

    # The OpenTelemetry default, so a lenient SDK still names its resource.
    if not _text(attrs, "service.name").strip():
        attrs["service.name"] = f"{_UNKNOWN_SERVICE}:python"

    version_fallback = not _text(attrs, "service.version")
    if version_fallback:
        attrs["service.version"] = SERVICE_VERSION_FALLBACK

    # Derive service.instance.id when absent.
    if not _text(attrs, "service.instance.id").strip():
        derived = derive_instance_id(
            pod_uid=_text(attrs, ATTR_K8S_POD_UID),
            pod_name=_text(attrs, ATTR_K8S_POD_NAME),
            namespace=_text(attrs, ATTR_K8S_NAMESPACE_NAME),
        )
        attrs["service.instance.id"] = derived if derived is not None else random_instance_id()

    # Classify resource attributes once through the sensitivity policy.
    classified, _ = policy.classify_flat(Signal.RESOURCE, attrs)
    resource = Resource(attributes=classified, schema_url=SCHEMA_URL)
    return resource, version_fallback
