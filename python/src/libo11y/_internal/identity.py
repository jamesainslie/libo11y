"""service.instance.id derivation matching conformance/vectors/instance-id.json."""

from __future__ import annotations

import uuid
from typing import Final

INSTANCE_ID_NAMESPACE: Final[uuid.UUID] = uuid.UUID("4d63009a-8d0f-11ee-aad7-4c796ed8e320")


def derive_instance_id(
    pod_uid: str = "",
    pod_name: str = "",
    namespace: str = "",
) -> str | None:
    """Derive a deterministic service.instance.id from Kubernetes pod identity.

    Returns None when neither pod_uid nor pod_name is set; callers then fall back
    to random_instance_id().
    """
    if pod_uid:
        return str(uuid.uuid5(INSTANCE_ID_NAMESPACE, pod_uid))
    if pod_name:
        return str(uuid.uuid5(INSTANCE_ID_NAMESPACE, f"{namespace}/{pod_name}"))
    return None


def random_instance_id() -> str:
    """Generate a random RFC 9562 UUIDv4 service.instance.id."""
    return str(uuid.uuid4())
