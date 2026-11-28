"""Resource detection: telemetry SDK identity, identity value types, container ID."""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.sdk.version import __version__ as otel_sdk_version

import libo11y
from libo11y._internal.resource import container_id_from_cgroup, container_id_from_mountinfo

_CID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
_OTHER = "f" * 64


def _init(**kwargs: Any) -> libo11y.Telemetry:
    options: dict[str, Any] = {
        "env": libo11y.HERMETIC,
        "service_name": "checkout",
        "environment": "production",
        "console_enabled": False,
        "runtime_metrics": False,
    }
    options.update(kwargs)
    return libo11y.init(**options)


def test_telemetry_sdk_attributes_name_the_opentelemetry_sdk() -> None:
    with _init() as tel:
        attrs = tel.resource.attributes
        assert attrs["telemetry.sdk.name"] == "opentelemetry"
        assert attrs["telemetry.sdk.language"] == "python"
        assert attrs["telemetry.sdk.version"] == otel_sdk_version


def test_no_telemetry_distro_attributes_are_set() -> None:
    with _init() as tel:
        assert not [k for k in tel.resource.attributes if k.startswith("telemetry.distro.")]


@pytest.mark.parametrize("value", [123, 1.5, True, ["checkout"]])
def test_non_string_service_name_reads_as_absent(value: object) -> None:
    with pytest.raises(libo11y.NoServiceName):
        _init(service_name=None, resource_attributes={"service.name": value})


@pytest.mark.parametrize("value", [7, False, ["production"]])
def test_non_string_environment_reads_as_absent(value: object) -> None:
    with pytest.raises(libo11y.NoEnvironment):
        _init(environment=None, resource_attributes={"deployment.environment.name": value})


def test_non_string_service_version_falls_back() -> None:
    with _init(resource_attributes={"service.version": 3}) as tel:
        assert tel.resource.attributes["service.version"] == "0.0.0-unknown"
        assert "o11y.config.service_version_fallback=true" in tel.effective_config()


def test_non_string_instance_id_is_replaced_by_a_derived_one() -> None:
    with _init(resource_attributes={"service.instance.id": 42}) as tel:
        instance_id = tel.resource.attributes["service.instance.id"]
        assert isinstance(instance_id, str)
        assert len(instance_id) == 36


@pytest.mark.parametrize(
    ("cgroup", "want"),
    [
        pytest.param(f"12:cpu,cpuacct:/docker/{_CID}\n", _CID, id="cgroup v1 docker"),
        pytest.param(
            f"11:memory:/kubepods/burstable/pod0a1b2c3d-1111-2222-3333-444455556666/{_CID}\n",
            _CID,
            id="cgroup v1 kubernetes",
        ),
        pytest.param(
            f"0::/system.slice/docker-{_CID}.scope\n", _CID, id="cgroup v2 docker systemd"
        ),
        pytest.param(
            f"0::/kubepods.slice/kubepods-burstable.slice/crio-{_CID}.scope\n",
            _CID,
            id="cgroup v2 cri-o",
        ),
        pytest.param(
            f"0::/kubepods.slice/kubepods-pod0a1b.slice/cri-containerd-{_CID}.scope\n",
            _CID,
            id="cgroup v2 containerd systemd",
        ),
        pytest.param(
            f"0::/kubepods/burstable/pod0a1b/cri-containerd:{_CID}\n",
            _CID,
            id="containerd colon form",
        ),
        pytest.param(
            f"0::/machine.slice/libpod-{_CID}.scope/container\n", _CID, id="podman payload"
        ),
        pytest.param(
            f"12:cpu:/\n3:devices:/docker/{_CID}\n2:pids:/docker/{_OTHER}\n",
            _CID,
            id="first matching line wins",
        ),
        pytest.param("0::/\n", None, id="cgroup v2 namespaced root"),
        pytest.param(
            "0::/user.slice/user-1000.slice/session-3.scope\n", None, id="host login session"
        ),
        pytest.param("0::/init.scope\n", None, id="init scope"),
        pytest.param(f"0::/docker/{_CID[:63]}\n", None, id="63 hex digits"),
        pytest.param(f"0::/docker/{_CID}0\n", None, id="65 hex digits"),
        pytest.param(f"0::/docker/{_CID.upper()}\n", None, id="upper case hex"),
        pytest.param(f"0::/docker/{_CID[:63]}g\n", None, id="not hex"),
        pytest.param("", None, id="empty file"),
    ],
)
def test_container_id_from_cgroup(cgroup: str, want: str | None) -> None:
    assert container_id_from_cgroup(cgroup) == want


def _mount(root: str, mount_point: str, *, fs: str = "ext4", source: str = "/dev/sda1") -> str:
    return f"812 795 8:1 {root} {mount_point} rw,relatime - {fs} {source} rw\n"


_OVERLAY_ROOT = (
    "795 673 0:118 / / rw,relatime master:211 - overlay overlay "
    f"rw,lowerdir=/var/lib/docker/overlay2/l/ABC,upperdir=/var/lib/docker/overlay2/{_OTHER}/diff,"
    f"workdir=/var/lib/docker/overlay2/{_OTHER}/work\n"
)


@pytest.mark.parametrize(
    ("mountinfo", "want"),
    [
        pytest.param(
            _OVERLAY_ROOT
            + _mount(f"/var/lib/docker/containers/{_CID}/resolv.conf", "/etc/resolv.conf")
            + _mount(f"/var/lib/docker/containers/{_CID}/hostname", "/etc/hostname"),
            _CID,
            id="docker",
        ),
        pytest.param(
            _mount(
                f"/containers/storage/overlay-containers/{_CID}/userdata/hostname",
                "/etc/hostname",
            ),
            _CID,
            id="podman",
        ),
        pytest.param(
            _mount(
                f"/var/lib/containerd/io.containerd.grpc.v1.cri/sandboxes/{_CID}/hostname",
                "/etc/hostname",
            ),
            _CID,
            id="containerd",
        ),
        pytest.param(_OVERLAY_ROOT, None, id="overlay layer IDs are not the container ID"),
        pytest.param(
            _mount(f"/var/lib/docker/volumes/{_OTHER}/_data", "/data"),
            None,
            id="volume IDs are not the container ID",
        ),
        pytest.param(_mount("/etc/hostname", "/etc/hostname"), None, id="host bind mount"),
        pytest.param("795 673 0:118 /\n", None, id="truncated line"),
        pytest.param("", None, id="empty file"),
    ],
)
def test_container_id_from_mountinfo(mountinfo: str, want: str | None) -> None:
    assert container_id_from_mountinfo(mountinfo) == want
