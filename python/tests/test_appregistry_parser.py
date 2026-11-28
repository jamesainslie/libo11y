"""Application registry parser: document order and nesting depth match yaml.v3.

Every expected kind in this file was taken from Go's ``internal/appregistry``
parser on gopkg.in/yaml.v3 v3.0.1 for the same input.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from libo11y._internal import yamlv3
from libo11y.spec.appregistry import (
    AppRegistryParseError,
    AppRegistryParseKind,
    parse_app_registry,
)

# PyYAML's scanner is quadratic in nesting depth, so the boundary tests run
# with the limit lowered to this value. Structure, not size, decides the
# result, and the boundaries below were taken from yaml.v3 at its real limit.
_TEST_DEPTH = 40


def _parse_kind(text: str) -> AppRegistryParseKind | None:
    try:
        parse_app_registry(text)
    except AppRegistryParseError as exc:
        return exc.kind
    return None


def _flow_sequences(key: str, depth: int) -> str:
    return f"{key}: {'[' * depth}{']' * depth}\n"


def _flow_mappings(key: str, depth: int) -> str:
    return f"{key}: {'{a: ' * depth}x{'}' * depth}\n"


def _block_mappings(key: str, depth: int) -> str:
    lines = [f"{key}:"]
    lines.extend(" " * (i + 1) + f"k{i}:" for i in range(depth))
    lines.append(" " * (depth + 1) + "v")
    return "\n".join(lines) + "\n"


def _block_sequences(key: str, depth: int) -> str:
    lines = [f"{key}:"]
    lines.extend(" " * (i + 1) + "-" for i in range(depth))
    return "\n".join(lines) + "\n"


def _alias_chain(key: str, length: int) -> str:
    lines = [f"{key}:", "  a0: &a0 [x]"]
    lines.extend(f"  a{i}: &a{i} [*a{i - 1}]" for i in range(1, length))
    return "\n".join(lines) + "\n"


@pytest.mark.parametrize(
    ("text", "want"),
    [
        pytest.param("schema: x\nbogus: 1\n---\n[unclosed\n", "unknown-key", id="unknown-key"),
        pytest.param("bogus: 1\nbogus: 2\n---\n[unclosed\n", "duplicate-key", id="duplicate"),
        pytest.param("schema: [1]\n---\n{unclosed\n", "type", id="type"),
    ],
)
def test_first_document_problem_wins_over_malformed_second_document(
    text: str, want: AppRegistryParseKind
) -> None:
    assert _parse_kind(text) == want


def test_malformed_second_document_after_clean_first_is_syntax() -> None:
    assert _parse_kind("schema: x\n---\n[unclosed\n") == "syntax"


def test_well_formed_second_document_after_clean_first_is_second_document() -> None:
    assert _parse_kind("schema: x\n---\nschema: y\n") == "second-document"


def test_control_character_in_second_document_is_syntax_as_in_yaml_v3() -> None:
    # yaml.v3 checks characters as it reads its input buffer, before decoding.
    assert _parse_kind("schema: x\nbogus: 1\n---\na: \x00\n") == "syntax"


@pytest.mark.parametrize(
    ("text", "want"),
    [
        pytest.param(_flow_sequences("schema", 1100), "type", id="flow-seq-in-string"),
        pytest.param(_flow_sequences("bogus", 1100), "unknown-key", id="flow-seq-unknown"),
        pytest.param(_flow_sequences("attributes", 1100), "type", id="flow-seq-attributes"),
        pytest.param(_flow_mappings("attributes", 1100), "unknown-key", id="flow-map-attributes"),
        pytest.param(_block_mappings("bogus", 1100), "unknown-key", id="block-map-unknown"),
        pytest.param(_block_mappings("schema", 1100), "type", id="block-map-in-string"),
        pytest.param(_block_mappings("attributes", 1100), "unknown-key", id="block-map-attr"),
        pytest.param(_block_sequences("bogus", 1100), "unknown-key", id="block-seq-unknown"),
        pytest.param(_alias_chain("bogus", 1100), "unknown-key", id="alias-chain-unknown"),
        pytest.param(_alias_chain("attributes", 1100), "type", id="alias-chain-attributes"),
    ],
)
def test_deep_nesting_decodes_to_the_yaml_v3_kind(text: str, want: AppRegistryParseKind) -> None:
    assert _parse_kind(text) == want


def test_max_depth_is_yaml_v3_limit() -> None:
    assert yamlv3.MAX_DEPTH == 10_000


@pytest.mark.parametrize(
    ("build", "depth", "want"),
    [
        pytest.param(_flow_sequences, _TEST_DEPTH, "unknown-key", id="flow-at"),
        pytest.param(_flow_sequences, _TEST_DEPTH + 1, "syntax", id="flow-past"),
        pytest.param(_flow_mappings, _TEST_DEPTH + 1, "syntax", id="flow-map-past"),
        # The root mapping holds one block indent, so limit - 1 nested levels reach it.
        pytest.param(_block_mappings, _TEST_DEPTH - 1, "unknown-key", id="block-at"),
        pytest.param(_block_mappings, _TEST_DEPTH, "syntax", id="block-past"),
        pytest.param(_block_sequences, _TEST_DEPTH - 1, "unknown-key", id="block-seq-at"),
        pytest.param(_block_sequences, _TEST_DEPTH, "syntax", id="block-seq-past"),
    ],
)
def test_nesting_past_max_depth_is_syntax(
    monkeypatch: pytest.MonkeyPatch,
    build: Callable[[str, int], str],
    depth: int,
    want: AppRegistryParseKind,
) -> None:
    monkeypatch.setattr(yamlv3, "MAX_DEPTH", _TEST_DEPTH)
    assert _parse_kind(build("bogus", depth)) == want


def test_depth_error_in_second_document_loses_to_first_document_problem(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(yamlv3, "MAX_DEPTH", _TEST_DEPTH)
    text = "schema: x\nbogus: 1\n---\n" + _flow_sequences("a", _TEST_DEPTH + 1)
    assert _parse_kind(text) == "unknown-key"
