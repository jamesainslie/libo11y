"""Service identity validation and Resource composition."""

from __future__ import annotations

import importlib.metadata
import os
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
    ATTR_HOST_ARCH,
    ATTR_HOST_NAME,
    ATTR_K8S_NAMESPACE_NAME,
    ATTR_K8S_POD_NAME,
    ATTR_K8S_POD_UID,
    ATTR_OS_TYPE,
    ATTR_PROCESS_PID,
    ATTR_PROCESS_RUNTIME_NAME,
    ATTR_PROCESS_RUNTIME_VERSION,
    ATTR_VCS_REF_HEAD_REVISION,
    ENVIRONMENT_VALUES,
    SCHEMA_URL,
    Signal,
)

_CONTAINER_ID_RE = re.compile(r"[0-9a-fA-F]{64}")


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


def _os_type() -> str:
    sys_name = platform.system().lower()
    if sys_name == "darwin":
        return "darwin"
    if sys_name == "windows":
        return "windows"
    if sys_name == "linux":
        return "linux"
    return sys_name or "unknown"


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


def build_resource(
    opts: Options,
    env: EnvView,
    policy: SensitivityPolicy,
    recorder: ViolationRecorder,
) -> tuple[Resource, bool]:
    """Compose, validate, and classify the SDK Resource.

    Returns (resource, version_fallback_used).
    """
    attrs: dict[str, Any] = {
        "telemetry.sdk.name": "libo11y",
        "telemetry.sdk.language": "python",
        "telemetry.sdk.version": _detect_sdk_version(),
        ATTR_HOST_NAME: socket.gethostname(),
        ATTR_HOST_ARCH: platform.machine(),
        ATTR_OS_TYPE: _os_type(),
        ATTR_PROCESS_PID: os.getpid(),
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
    env_attrs = parse_resource_attributes(env)
    attrs.update(env_attrs)
    if env_svc := env.get_opt("OTEL_SERVICE_NAME"):
        attrs["service.name"] = env_svc

    # Explicit resource attributes override environment.
    for k, v in opts.resource_attributes.items():
        attrs[k] = v

    # Explicit top-level identity options take highest precedence.
    if opts.service_name is not None:
        attrs["service.name"] = opts.service_name
    if opts.service_namespace is not None:
        attrs["service.namespace"] = opts.service_namespace
    if opts.environment is not None:
        attrs["deployment.environment.name"] = opts.environment

    version_fallback = False
    if opts.version is not None:
        attrs["service.version"] = opts.version
    elif "service.version" not in attrs:
        dist_ver = _detect_distribution_version(opts.distribution)
        if dist_ver:
            attrs["service.version"] = dist_ver
        elif opts.build_info is not None and attrs.get(ATTR_VCS_REF_HEAD_REVISION):
            attrs["service.version"] = str(attrs[ATTR_VCS_REF_HEAD_REVISION])
            version_fallback = True

    # Validate service.name (Tier 0).
    svc_name = str(attrs.get("service.name", "")).strip()
    if not svc_name or svc_name.startswith("unknown_service"):
        if opts.strict_identity:
            raise NoServiceName()
        recorder.record(Signal.RESOURCE, "missing_service_name")
        if not svc_name:
            attrs["service.name"] = "unknown_service:python"
    else:
        attrs["service.name"] = svc_name

    # Validate deployment.environment.name (Tier 0).
    dep_env = str(attrs.get("deployment.environment.name", "")).strip()
    allowed = _allowed_environments(opts)
    if not dep_env:
        if opts.strict_identity:
            raise NoEnvironment()
        recorder.record(Signal.RESOURCE, "missing_environment")
    elif dep_env not in allowed:
        if opts.strict_identity:
            allowed_list = ", ".join(sorted(allowed))
            raise InvalidEnvironment(
                f"o11y: deployment environment not in the allowed set: "
                f"{dep_env!r} (allowed: {allowed_list})"
            )
        recorder.record(Signal.RESOURCE, "invalid_environment")
    else:
        attrs["deployment.environment.name"] = dep_env

    # Derive service.instance.id when absent.
    if not str(attrs.get("service.instance.id", "")).strip():
        derived = derive_instance_id(
            pod_uid=str(attrs.get(ATTR_K8S_POD_UID, "")),
            pod_name=str(attrs.get(ATTR_K8S_POD_NAME, "")),
            namespace=str(attrs.get(ATTR_K8S_NAMESPACE_NAME, "")),
        )
        attrs["service.instance.id"] = derived if derived is not None else random_instance_id()

    # Classify resource attributes once through the sensitivity policy.
    classified, _ = policy.classify_flat(Signal.RESOURCE, attrs)
    resource = Resource(attributes=classified, schema_url=SCHEMA_URL)
    return resource, version_fallback
