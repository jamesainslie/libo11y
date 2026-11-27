"""Cross-language conformance suite for libo11y Python (P1)."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from libo11y._internal.endpoint import sanitize_endpoint, sanitize_endpoint_bytes
from libo11y._internal.identity import derive_instance_id, random_instance_id
from libo11y._internal.pii import canonical_float, canonical_value, pii_token
from libo11y.spec import (
    APP_REGISTRY_SCHEMA,
    ENVIRONMENT_VALUES,
    SCHEMA_URL,
    SEMCONV_VERSION,
    SENSITIVITY_OF,
    SPEC_VERSION,
    AppRegistryError,
    AppRegistryParseError,
    Environment,
    Sensitivity,
    compile_app_registry,
    load_app_registry,
    parse_app_registry,
    parse_app_registry_bytes,
    validate_app_registry,
)
from libo11y.spec._goquote import go_quote

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFORMANCE_DIR = REPO_ROOT / "conformance"
APPREGISTRY_DIR = CONFORMANCE_DIR / "appregistry"
VECTORS_DIR = CONFORMANCE_DIR / "vectors"


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def test_generated_spec_sanity() -> None:
    assert SCHEMA_URL.endswith(f"/{SPEC_VERSION}")
    assert SEMCONV_VERSION
    assert Environment.PRODUCTION == "production"
    assert "production" in ENVIRONMENT_VALUES
    assert SENSITIVITY_OF["service.name"] == Sensitivity.PUBLIC


def test_instance_id_vectors() -> None:
    cases: list[dict[str, str]] = _load_json(VECTORS_DIR / "instance-id.json")
    assert len(cases) > 0
    for c in cases:
        got = derive_instance_id(
            pod_uid=c["k8s_pod_uid"],
            pod_name=c["k8s_pod_name"],
            namespace=c["k8s_namespace_name"],
        )
        assert got == c["want"], c["name"]
    assert derive_instance_id() is None
    assert derive_instance_id(namespace="ns-only") is None
    rid = random_instance_id()
    assert len(rid) == 36
    assert rid[14] == "4"


def test_endpoint_sanitize_vectors() -> None:
    cases: list[dict[str, str]] = _load_json(VECTORS_DIR / "endpoint-sanitize.json")
    assert len(cases) > 0
    for c in cases:
        assert sanitize_endpoint(c["in"]) == c["want"], c["in"]


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("https://[fe80::1%25en0]:4318/v1", "https://[fe80::1%25en0]:4318/v1"),
        ("https://[::ffff:10.0.0.1]/", "https://[::ffff:10.0.0.1]/"),
        ("https://[10.0.0.1]/", "unparseable"),
        ("https://[::1/", "unparseable"),
        ("https://x[::1]/", "unparseable"),
        ("https://host:43a8", "unparseable"),
        ("https://host:1:2", "unparseable"),
        ("otel://host:1:2", "otel://host:1:2"),
        ("https://host:", "https://host:"),
        ("https://ho%41st", "unparseable"),
        ("https://ho%C3%BCst/", "https://ho%C3%BCst/"),
        ("https://host/%7e%2Fa", "https://host/%7e%2Fa"),
        ("https://host/a?b#c", "https://host/a"),
        ("https://host/#%zz", "unparseable"),
        ("https://host/\x07", "unparseable"),
        ("https://host/a%zz", "unparseable"),
        ("https:/path-only", "https:/path-only"),
        ("mailto:someone", "unparseable"),
        ("/relative", "unparseable"),
        ("https://user@", "unparseable"),
        ("https://us er:p@host", "unparseable"),
        ("https://u%zz:p@host", "unparseable"),
        ("HtTp://Host:80/", "http://Host:80/"),
        ("host:4317/v1/traces", "host:4317/v1/traces"),
        ("https://host/a:b", "https://host/a:b"),
        ("https://host/a;b,c=d&e", "https://host/a;b,c=d&e"),
        ("https://[::1%25]/", "unparseable"),
        ("https://[1::2::3]/", "unparseable"),
        ("https://[1:2:3:4:5:6:7:8:9]/", "unparseable"),
        ("https://[::1.2.3.4]/", "https://[::1.2.3.4]/"),
        ("https://[1:2:3:4:5:6:1.2.3.4]/", "https://[1:2:3:4:5:6:1.2.3.4]/"),
        ("https://[1:2:3:4:5:6:7:1.2.3.4]/", "unparseable"),
        ("https://[::01.2.3.4]/", "unparseable"),
        ("https://[12345::]/", "unparseable"),
        ("https://[1:2:3:4:5:6:7::]/", "https://[1:2:3:4:5:6:7::]/"),
        ("https://[1:2:3:4:5:6:7:8::]/", "unparseable"),
        ("https://[::]/", "https://[::]/"),
        ("https://[:1]/", "unparseable"),
        ("https://[1:]/", "unparseable"),
        ("https://[fe80::1%25%41]/", "https://[fe80::1%25A]/"),
        ("https://[fe80::1%25en%200]/", "https://[fe80::1%25en%200]/"),
        ("a b:1", "unparseable"),
        ("//x", "unparseable"),
        ("x:1/a:b", "x:1/a:b"),
        ("https://host/a%2fb%20c", "https://host/a%2fb%20c"),
        ("https://host/é", "https://host/%C3%A9"),
        ("https://host/%e9", "https://host/%e9"),
        ("https://host/*", "https://host/*"),
        ("*", "*"),
        ("https://host:80:", "unparseable"),
        ("h:1:2", "h:1:2"),
        ("https://[::1]x", "unparseable"),
        ("https://host/#\x07", "https://host/"),
        ("https://host/#", "https://host/"),
        ("https://host#a%zz", "unparseable"),
        ("https://host/a\x7f", "unparseable"),
        ("https://[fe80::1%25%0a]/", "unparseable"),
        ("https://[fe80::1%25eth0.1]/", "https://[fe80::1%25eth0.1]/"),
        ("https://[::1]:/", "https://[::1]:/"),
        ("https://[::1]:x/", "unparseable"),
        ("https://[1:2:3:4:5:6:7:8]/", "https://[1:2:3:4:5:6:7:8]/"),
        ("https://[::12345]/", "unparseable"),
        ("https://[::1.2.3.256]/", "unparseable"),
        ("https://[::1.2.3]/", "unparseable"),
        ("https://host/%41 b", "https://host/A%20b"),
        ("https://host/a%3Fb", "https://host/a%3Fb"),
        ("https://host/?x=1@y", "unparseable"),
        ("https://host/a#@", "unparseable"),
        ("https://u%40x:p@host", "https://host"),
        ("https://:p@host:1", "https://host:1"),
        ("1http://host", "unparseable"),
        ("a:b://c", "unparseable"),
        ("https:///path", "unparseable"),
        ("host", "host"),
        ("[::1]:4317", "[::1]:4317"),
        ("h<o>st:1", "h<o>st:1"),
        ("ho st:1", "unparseable"),
    ],
)
def test_endpoint_sanitize_go_edge_cases(raw: str, want: str) -> None:
    assert sanitize_endpoint(raw) == want


def test_endpoint_sanitize_raw_non_utf8_byte() -> None:
    assert sanitize_endpoint_bytes(b"https://host\xff/") == "https://host%FF/"


def test_pii_hash_vectors() -> None:
    data: dict[str, Any] = _load_json(VECTORS_DIR / "pii-hash.json")
    key = bytes.fromhex(data["key_hex"])
    cases: list[dict[str, Any]] = data["cases"]
    assert len(cases) > 0
    for c in cases:
        kind: str = c["kind"]
        val: Any = c["value"]
        if kind == "bytes":
            val = base64.b64decode(val)
        elif kind == "float":
            val = float(val)
        elif kind == "float_array":
            val = [float(x) for x in val]
        assert canonical_value(val) == c["canonical"], c["name"]
        assert pii_token(key, val) == c["token"], c["name"]


def test_pii_special_floats_and_cycles() -> None:
    assert canonical_float(float("nan")) == "NaN"
    assert canonical_float(float("inf")) == "+Inf"
    assert canonical_float(float("-inf")) == "-Inf"
    assert canonical_float(-0.0) == "-0"
    assert canonical_float(0.0) == "0"
    assert canonical_float(1.0) == "1"

    cyclic_list: list[Any] = []
    cyclic_list.append(cyclic_list)
    assert canonical_value(cyclic_list) == '["truncated"]'

    cyclic_map: dict[str, Any] = {}
    cyclic_map["self"] = cyclic_map
    assert canonical_value(cyclic_map) == '{"self":"truncated"}'


def test_go_quote_escapes() -> None:
    assert go_quote("abc") == '"abc"'
    assert go_quote("\x07\b\f\n\r\t\v") == r'"\a\b\f\n\r\t\v"'
    assert go_quote("\x00\x7f\u0085\U000e0001") == r'"\x00\x7f\u0085\U000e0001"'
    assert go_quote('a"b\\c') == r'"a\"b\\c"'
    assert go_quote("café") == '"café"'


_APPREGISTRY_CASES = sorted(p.stem for p in APPREGISTRY_DIR.glob("*.yaml"))


@pytest.mark.parametrize("case_name", _APPREGISTRY_CASES)
def test_appregistry_conformance(case_name: str) -> None:
    yaml_bytes = (APPREGISTRY_DIR / f"{case_name}.yaml").read_bytes()
    want = (APPREGISTRY_DIR / f"{case_name}.want").read_text(encoding="utf-8").strip()

    try:
        reg = parse_app_registry_bytes(yaml_bytes)
    except AppRegistryParseError as exc:
        assert f"parse: {exc.kind}" == want, f"{case_name}: got {exc!s}, want {want!r}"
        return

    violations = validate_app_registry(reg)
    if violations:
        got = "\n".join(str(v) for v in violations)
        assert got == want, f"{case_name}: violations mismatch"
        with pytest.raises(AppRegistryError):
            compile_app_registry(reg)
    else:
        got = f"ok {len(reg.attributes)} {reg.namespace}"
        assert got == want, f"{case_name}: ok mismatch"
        compiled = compile_app_registry(reg, source=f"{case_name}.yaml")
        assert compiled.namespace == reg.namespace
        assert len(compiled.classes) == len(reg.attributes)


def test_load_app_registry_from_file(tmp_path: Path) -> None:
    p = tmp_path / "reg.yaml"
    p.write_text(
        f"schema: {APP_REGISTRY_SCHEMA}\n"
        "namespace: billing\n"
        "attributes:\n"
        "  billing.invoice.id:\n"
        "    type: string\n"
        "    sensitivity: internal\n"
        "    cardinality: unbounded\n",
        encoding="utf-8",
    )
    compiled = load_app_registry(p)
    assert compiled.namespace == "billing"
    assert compiled.classes["billing.invoice.id"] == Sensitivity.INTERNAL
    assert compiled.source == str(p)


@settings(max_examples=100, deadline=None)
@given(st.binary(max_size=256))
def test_property_parse_app_registry_bytes_never_crashes(raw: bytes) -> None:
    try:
        reg = parse_app_registry_bytes(raw)
    except AppRegistryParseError:
        return
    validate_app_registry(reg)


@settings(max_examples=50, deadline=None)
@given(
    st.from_regex(r"[a-z][a-z0-9]{1,8}", fullmatch=True).filter(
        lambda ns: ns not in {"o11y", "otel", "service", "http", "db", "rpc", "url", "host", "user"}
    ),
    st.from_regex(r"[a-z][a-z0-9]{1,8}", fullmatch=True),
    st.sampled_from(["string", "int", "double", "boolean"]),
    st.sampled_from(["public", "internal", "pii", "secret"]),
    st.sampled_from(["bounded", "unbounded"]),
)
def test_property_valid_app_registry_roundtrips(
    ns: str,
    field_name: str,
    attr_type: str,
    sensitivity: str,
    cardinality: str,
) -> None:
    text = (
        f"schema: {APP_REGISTRY_SCHEMA}\n"
        f"namespace: {ns}\n"
        "attributes:\n"
        f"  {ns}.{field_name}:\n"
        f"    type: {attr_type}\n"
        f"    sensitivity: {sensitivity}\n"
        f"    cardinality: {cardinality}\n"
    )
    reg = parse_app_registry(text)
    violations = validate_app_registry(reg)
    if violations:
        # Only reserved namespace could trigger a violation for random namespaces.
        assert all(v.rule_id == "libo11y_app_namespace_reserved" for v in violations)
    else:
        compiled = compile_app_registry(reg)
        assert compiled.classes[f"{ns}.{field_name}"] == Sensitivity(sensitivity)
