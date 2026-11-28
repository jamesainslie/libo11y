"""The classifying log attribute walk: bounds, cycles and fail-closed drops.

These mirror go/logredact.go (classifyComposite): one node budget shared by
the whole walk, spent before a node is examined; a depth bound on mappings by
effective key length and on sequences by nesting; cycle detection that
includes the root mapping; and what the walk did not examine is dropped,
never replaced by a placeholder.
"""

from __future__ import annotations

from typing import Any

import pytest

from libo11y._internal.pii import CANONICAL_TRUNCATED, MAX_COMPOSITE_DEPTH, MAX_COMPOSITE_NODES
from libo11y._internal.policy import SensitivityPolicy
from libo11y.options import PIIMode
from libo11y.spec import Sensitivity

_HASH_KEY = b"k" * 32


def _contains_placeholder(value: Any) -> bool:
    if value == CANONICAL_TRUNCATED:
        return True
    if isinstance(value, dict):
        return any(_contains_placeholder(v) for v in value.values())  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
    if isinstance(value, list):
        return any(_contains_placeholder(v) for v in value)  # pyright: ignore[reportUnknownVariableType]
    return False


def _nested_mappings(levels: int) -> dict[str, Any]:
    """Top-level attributes whose innermost mapping sits at an effective key of `levels` parts."""
    inner: dict[str, Any] = {"leaf": 1}
    for _ in range(levels - 1):
        inner = {"k": inner}
    return {"k": inner}


def _nested_sequences(levels: int) -> dict[str, Any]:
    """Top-level attribute holding `levels` nested lists around one scalar."""
    inner: list[Any] = [1]
    for _ in range(levels - 1):
        inner = [inner]
    return {"s": inner}


def test_wide_top_level_mapping_keeps_only_the_budgeted_members() -> None:
    attrs = {f"app.k{i:04d}": i for i in range(MAX_COMPOSITE_NODES + 12)}

    out = SensitivityPolicy().classify_log_attributes(attrs)

    assert len(out) == MAX_COMPOSITE_NODES
    assert list(out) == list(attrs)[:MAX_COMPOSITE_NODES]
    assert not _contains_placeholder(out)


def test_wide_nested_mapping_spends_budget_on_holder_and_entry() -> None:
    wide = {f"k{i:04d}": i for i in range(MAX_COMPOSITE_NODES + 12)}

    out = SensitivityPolicy().classify_log_attributes({"m": wide})

    # One node for the member "m", one for entering its mapping.
    assert len(out["m"]) == MAX_COMPOSITE_NODES - 2
    assert not _contains_placeholder(out)


def test_replacer_is_not_called_past_the_budget() -> None:
    calls = 0

    def replacer(groups: tuple[str, ...], key: str, val: Any) -> tuple[str, Any] | None:
        del groups
        nonlocal calls
        calls += 1
        return (key, val)

    attrs = {f"app.k{i:04d}": i for i in range(MAX_COMPOSITE_NODES + 12)}

    SensitivityPolicy().classify_log_attributes(attrs, replacer)

    assert calls == MAX_COMPOSITE_NODES


def test_hash_mode_spends_budget_on_rewritten_members() -> None:
    keys = [f"app.pii{i:04d}" for i in range(MAX_COMPOSITE_NODES + 12)]
    policy = SensitivityPolicy(
        pii_mode=PIIMode.HASH,
        pii_hash_key=_HASH_KEY,
        app_classes=dict.fromkeys(keys, Sensitivity.PII),
    )

    out = policy.classify_log_attributes({k: "someone" for k in keys})

    assert len(out) == MAX_COMPOSITE_NODES
    assert all(v == policy.tokenize("someone") for v in out.values())


def test_mapping_at_the_depth_bound_is_walked() -> None:
    out = SensitivityPolicy().classify_log_attributes(_nested_mappings(MAX_COMPOSITE_DEPTH))

    node: Any = out
    for _ in range(MAX_COMPOSITE_DEPTH):
        node = node["k"]
    assert node == {"leaf": 1}


def test_mapping_past_the_depth_bound_is_dropped_with_its_emptied_holders() -> None:
    out = SensitivityPolicy().classify_log_attributes(_nested_mappings(MAX_COMPOSITE_DEPTH + 1))

    assert out == {}


def test_sequence_at_the_depth_bound_is_walked() -> None:
    attrs = _nested_sequences(MAX_COMPOSITE_DEPTH)

    out = SensitivityPolicy().classify_log_attributes(attrs)

    assert out == attrs


def test_sequence_past_the_depth_bound_is_dropped_with_its_emptied_holders() -> None:
    out = SensitivityPolicy().classify_log_attributes(_nested_sequences(MAX_COMPOSITE_DEPTH + 1))

    assert out == {}


def test_top_level_self_reference_is_dropped() -> None:
    attrs: dict[str, Any] = {"app.a": 1}
    attrs["self"] = attrs

    out = SensitivityPolicy().classify_log_attributes(attrs)

    assert out == {"app.a": 1}


def test_nested_self_reference_is_dropped() -> None:
    inner: dict[str, Any] = {"x": 1}
    inner["back"] = inner

    out = SensitivityPolicy().classify_log_attributes({"m": inner})

    assert out == {"m": {"x": 1}}


def test_sequence_self_reference_is_dropped() -> None:
    seq: list[Any] = [1]
    seq.append(seq)

    out = SensitivityPolicy().classify_log_attributes({"s": seq})

    assert out == {"s": [1]}


def test_shared_reference_that_is_not_a_cycle_is_kept() -> None:
    shared = {"v": 1}

    out = SensitivityPolicy().classify_log_attributes({"a": shared, "b": [shared, shared]})

    assert out == {"a": {"v": 1}, "b": [{"v": 1}, {"v": 1}]}


def test_mixed_containers_drop_classified_members_and_emptied_holders() -> None:
    attrs = {"device": [{"id": "d-1"}, {"id": "d-2", "model": "m"}], "app.n": 1}

    out = SensitivityPolicy().classify_log_attributes(attrs)

    assert out == {"device": [{"model": "m"}], "app.n": 1}


def test_mapping_emptied_by_classification_is_dropped() -> None:
    out = SensitivityPolicy().classify_log_attributes({"device": {"id": "d-1"}, "app.n": 1})

    assert out == {"app.n": 1}


@pytest.mark.parametrize("empty", [{}, []], ids=["mapping", "sequence"])
def test_container_the_caller_left_empty_is_kept(empty: dict[str, Any] | list[Any]) -> None:
    out = SensitivityPolicy().classify_log_attributes({"app.e": empty})

    assert out == {"app.e": empty}


def test_budget_exhausted_inside_a_sequence_drops_the_remaining_elements() -> None:
    seq = list(range(MAX_COMPOSITE_NODES + 12))

    out = SensitivityPolicy().classify_log_attributes({"s": seq})

    # One node for the member "s", one for entering the sequence.
    assert out["s"] == seq[: MAX_COMPOSITE_NODES - 2]
