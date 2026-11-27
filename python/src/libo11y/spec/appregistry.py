"""Application attribute registry parsing, validation, and compilation."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Final, Literal

from libo11y._internal.yamlv3 import (
    AliasNode,
    MappingNode,
    ScalarNode,
    ScalarValue,
    SequenceNode,
    YamlNode,
    YamlSyntaxError,
    allowed_alias_ratio,
    decode_input,
    is_merge_key,
    parse_documents,
    resolve_scalar,
)
from libo11y.spec._generated.tables import (
    APP_REGISTRY_SCHEMA,
    APP_RESERVED_NAMESPACES,
    Sensitivity,
)
from libo11y.spec._goquote import go_quote

AppRegistryParseKind = Literal[
    "empty",
    "second-document",
    "duplicate-key",
    "unknown-key",
    "type",
    "syntax",
]

_PARSE_MESSAGES: Final[dict[AppRegistryParseKind, str]] = {
    "empty": "the file holds no YAML document",
    "second-document": "an application registry holds one YAML document, found a second",
    "duplicate-key": "a mapping repeats a key",
    "unknown-key": "a key the schema does not define",
    "type": "a value of the wrong YAML type",
    "syntax": "the file is not valid YAML",
}


@dataclass(frozen=True, slots=True)
class AppRegistryAttribute:
    """One declared application attribute."""

    type: str = ""
    sensitivity: str = ""
    cardinality: str = ""
    values: tuple[str, ...] = ()
    brief: str = ""


@dataclass(frozen=True, slots=True)
class AppRegistry:
    """A parsed application registry."""

    schema: str
    namespace: str
    attributes: Mapping[str, AppRegistryAttribute]


@dataclass(frozen=True, slots=True)
class AppRegistryViolation:
    """One rule a registry breaks."""

    rule_id: str
    attribute: str | None
    detail: str

    def __str__(self) -> str:
        if self.attribute is None:
            return f"{self.rule_id}: {self.detail}"
        return f"{self.rule_id}: attribute {self.attribute}: {self.detail}"


@dataclass(frozen=True, slots=True)
class CompiledAppRegistry:
    """A validated registry compiled into its key -> Sensitivity lookup table."""

    namespace: str
    classes: Mapping[str, Sensitivity]
    source: str | None = None


class AppRegistryParseError(ValueError):
    """Raised when an application registry YAML file fails to decode."""

    def __init__(self, kind: AppRegistryParseKind, detail: str | None = None) -> None:
        msg = detail if detail is not None else _PARSE_MESSAGES[kind]
        super().__init__(f"parsing application registry: {kind}: {msg}")
        self.kind: AppRegistryParseKind = kind


class AppRegistryError(ValueError):
    """Raised when a parsed application registry violates policy rules."""

    def __init__(self, violations: tuple[AppRegistryViolation, ...]) -> None:
        summary = "; ".join(str(v) for v in violations)
        super().__init__(f"invalid application registry: {summary}")
        self.violations: tuple[AppRegistryViolation, ...] = violations


_REGISTRY_FIELDS: Final[frozenset[str]] = frozenset({"schema", "namespace", "attributes"})
_ATTRIBUTE_FIELDS: Final[frozenset[str]] = frozenset(
    {"type", "sensitivity", "cardinality", "values", "brief"}
)

_NAMESPACE_RE: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
_NAME_RE: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$"
)
_ATTRIBUTE_TYPES: Final[frozenset[str]] = frozenset(
    {"string", "boolean", "int", "double", "string[]", "boolean[]", "int[]", "double[]"}
)
_SENSITIVITIES: Final[frozenset[str]] = frozenset({"public", "internal", "pii", "secret"})
_CARDINALITIES: Final[frozenset[str]] = frozenset({"enum", "bounded", "unbounded"})

# Go's strings.TrimSpace (Unicode White_Space): includes U+0085, excludes U+FEFF and 0x1C-0x1F.
_GO_WHITESPACE: Final[str] = (
    "\t\n\x0b\x0c\r \x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)


def _go_trim_space(s: str) -> str:
    return s.strip(_GO_WHITESPACE)


class _Decoder:
    def __init__(self, aliases: dict[int, YamlNode]) -> None:
        self._aliases = aliases
        self._expanding: set[int] = set()
        self._decodes = 0
        self._alias_decodes = 0
        self._alias_depth = 0
        self.duplicate = False
        self.unknown = False
        self.wrong_type = False

    def count(self) -> None:
        self._decodes += 1
        if self._alias_depth > 0:
            self._alias_decodes += 1
        if (
            self._alias_decodes > 100
            and self._decodes > 1000
            and (self._alias_decodes / self._decodes) > allowed_alias_ratio(self._decodes)
        ):
            raise YamlSyntaxError("document contains excessive aliasing")

    def _decode[T](self, raw: YamlNode, fn: Callable[[YamlNode], T]) -> T:
        self.count()
        if not isinstance(raw, AliasNode):
            return fn(raw)
        aid = id(raw)
        if aid in self._expanding:
            raise YamlSyntaxError(f"anchor '{raw.anchor}' value contains itself")
        target = self._aliases[aid]
        self._expanding.add(aid)
        self._alias_depth += 1
        try:
            return self._decode(target, fn)
        finally:
            self._alias_depth -= 1
            self._expanding.discard(aid)

    def _scalar(self, node: ScalarNode) -> ScalarValue:
        return resolve_scalar(node.tag, node.value, node.style is not None)

    def _null_or_wrong_scalar(self, node: YamlNode) -> bool:
        if not isinstance(node, ScalarNode):
            return False
        if not self._scalar(node).is_null:
            self.wrong_type = True
        return True

    def _identity(self, node: YamlNode) -> str:
        if isinstance(node, ScalarNode):
            return f"scalar:{node.value}"
        if isinstance(node, AliasNode):
            return f"alias:{node.anchor}"
        return "map:" if isinstance(node, MappingNode) else "seq:"

    def _has_duplicates(self, mp: MappingNode) -> bool:
        seen: set[str] = set()
        for k, _ in mp.pairs:
            ident = self._identity(k)
            if ident in seen:
                self.duplicate = True
                return True
            seen.add(ident)
        return False

    def decode_string(self, raw: YamlNode) -> str | None:
        def _inner(node: YamlNode) -> str | None:
            if isinstance(node, ScalarNode):
                v = self._scalar(node)
                return None if v.is_null else v.text
            if not (isinstance(node, MappingNode) and self._has_duplicates(node)):
                self.wrong_type = True
            return None

        return self._decode(raw, _inner)

    def decode_strings(self, raw: YamlNode) -> tuple[str, ...] | None:
        def _inner(node: YamlNode) -> tuple[str, ...] | None:
            if self._null_or_wrong_scalar(node):
                return None
            if not isinstance(node, SequenceNode):
                if not (isinstance(node, MappingNode) and self._has_duplicates(node)):
                    self.wrong_type = True
                return None
            out: list[str] = []
            for item in node.items:
                s = self.decode_string(item)
                if s is not None:
                    out.append(s)
            return tuple(out)

        return self._decode(raw, _inner)

    def decode_mapping(
        self,
        raw: YamlNode,
        on_key: Callable[[str, YamlNode], None],
        merged: set[str] | None = None,
    ) -> None:
        def _inner(node: YamlNode) -> None:
            if self._null_or_wrong_scalar(node):
                return
            if not isinstance(node, MappingNode):
                self.wrong_type = True
                return
            if self._has_duplicates(node):
                return
            merge_node: YamlNode | None = None
            has_merge = False
            for k, v in node.pairs:
                if is_merge_key(k):
                    merge_node = v
                    has_merge = True
                    continue
                name = self.decode_string(k)
                if name is None:
                    continue
                if merged is not None:
                    if name in merged:
                        continue
                    merged.add(name)
                on_key(name, v)
            if has_merge and merge_node is not None:
                self._merge(node, merge_node, on_key, merged)

        self._decode(raw, _inner)

    def _merge(
        self,
        parent: MappingNode,
        source: YamlNode,
        on_key: Callable[[str, YamlNode], None],
        merged: set[str] | None,
    ) -> None:
        keys = set[str]() if merged is None else merged
        if merged is None:
            for k, _ in parent.pairs:

                def _key_str(n: YamlNode) -> str | None:
                    if not isinstance(n, ScalarNode):
                        return None
                    v = self._scalar(n)
                    return v.text if (not v.is_null and v.is_string) else None

                ks = self._decode(k, _key_str)
                if ks is not None:
                    keys.add(ks)

        def _is_map(n: YamlNode) -> bool:
            target = self._aliases[id(n)] if isinstance(n, AliasNode) else n
            return isinstance(target, MappingNode)

        if isinstance(source, SequenceNode):
            for item in source.items:
                if not _is_map(item):
                    raise YamlSyntaxError("map merge requires map or sequence of maps as the value")
                self.decode_mapping(item, on_key, keys)
            return
        if not _is_map(source):
            raise YamlSyntaxError("map merge requires map or sequence of maps as the value")
        self.decode_mapping(source, on_key, keys)

    def decode_struct(
        self,
        raw: YamlNode,
        fields: frozenset[str],
        on_field: Callable[[str, YamlNode], None],
    ) -> None:
        done: set[str] = set()

        def _on_key(name: str, val: YamlNode) -> None:
            if name not in fields:
                self.unknown = True
                return
            if name in done:
                self.wrong_type = True
                return
            done.add(name)
            on_field(name, val)

        self.decode_mapping(raw, _on_key)

    def decode_attribute(self, raw: YamlNode) -> AppRegistryAttribute:
        attr_type = ""
        sensitivity = ""
        cardinality = ""
        values: tuple[str, ...] = ()
        brief = ""

        def _set(field_name: str, val: YamlNode) -> None:
            nonlocal attr_type, sensitivity, cardinality, values, brief
            if field_name == "values":
                parsed_vals = self.decode_strings(val)
                if parsed_vals is not None:
                    values = parsed_vals
                return
            s = self.decode_string(val)
            if s is None:
                return
            if field_name == "type":
                attr_type = s
            elif field_name == "sensitivity":
                sensitivity = s
            elif field_name == "cardinality":
                cardinality = s
            elif field_name == "brief":
                brief = s

        self.decode_struct(raw, _ATTRIBUTE_FIELDS, _set)
        return AppRegistryAttribute(
            type=attr_type,
            sensitivity=sensitivity,
            cardinality=cardinality,
            values=values,
            brief=brief,
        )

    def decode_attributes(self, raw: YamlNode) -> dict[str, AppRegistryAttribute]:
        out: dict[str, AppRegistryAttribute] = {}

        def _on_attr(name: str, val: YamlNode) -> None:
            out[name] = self.decode_attribute(val)

        self.decode_mapping(raw, _on_attr)
        return out

    def decode_registry(self, raw: YamlNode) -> AppRegistry:
        schema = ""
        namespace = ""
        attributes: dict[str, AppRegistryAttribute] = {}

        def _set(field_name: str, val: YamlNode) -> None:
            nonlocal schema, namespace, attributes
            if field_name == "attributes":
                attributes = self.decode_attributes(val)
                return
            s = self.decode_string(val)
            if s is None:
                return
            if field_name == "schema":
                schema = s
            else:
                namespace = s

        self.decode_struct(raw, _REGISTRY_FIELDS, _set)
        return AppRegistry(
            schema=schema,
            namespace=namespace,
            attributes=MappingProxyType(attributes),
        )

    def problem(self) -> AppRegistryParseKind | None:
        if self.duplicate:
            return "duplicate-key"
        if self.unknown:
            return "unknown-key"
        if self.wrong_type:
            return "type"
        return None


def parse_app_registry(text: str) -> AppRegistry:
    """Decode an application registry YAML document strictly."""
    try:
        docs = parse_documents(text)
        if not docs:
            raise AppRegistryParseError("empty")
        first = docs[0]
        decoder = _Decoder(first.aliases)
        decoder.count()  # yaml.v3 counts the document node, then its content.
        reg = decoder.decode_registry(first.root)
        problem = decoder.problem()
        if problem is not None:
            raise AppRegistryParseError(problem)
        if len(docs) > 1:
            raise AppRegistryParseError("second-document")
        return reg
    except YamlSyntaxError as exc:
        raise AppRegistryParseError("syntax", str(exc)) from exc


def parse_app_registry_bytes(raw: bytes) -> AppRegistry:
    """Decode raw UTF-8 or UTF-16 registry bytes strictly."""
    try:
        text = decode_input(raw)
    except YamlSyntaxError as exc:
        raise AppRegistryParseError("syntax", str(exc)) from exc
    return parse_app_registry(text)


def validate_app_registry(reg: AppRegistry) -> tuple[AppRegistryViolation, ...]:
    """Validate reg against every policy rule, returning violations in Go's exact order."""
    violations: list[AppRegistryViolation] = []

    def fail(rule: str, attr: str | None, detail: str) -> None:
        violations.append(AppRegistryViolation(rule_id=rule, attribute=attr, detail=detail))

    if reg.schema != APP_REGISTRY_SCHEMA:
        fail(
            "libo11y_app_schema_unknown",
            None,
            f"schema {go_quote(reg.schema)}, want {go_quote(APP_REGISTRY_SCHEMA)}",
        )
    if not _NAMESPACE_RE.match(reg.namespace):
        fail(
            "libo11y_app_namespace_invalid",
            None,
            f"namespace {go_quote(reg.namespace)} is not one snake_case segment",
        )
    elif reg.namespace in APP_RESERVED_NAMESPACES:
        fail(
            "libo11y_app_namespace_reserved",
            None,
            f"namespace {go_quote(reg.namespace)} belongs to libo11y, OpenTelemetry, or semconv",
        )

    names = sorted(reg.attributes.keys(), key=lambda s: s.encode("utf-8"))
    if not names:
        fail("libo11y_app_attributes_empty", None, "the registry declares no attributes")

    for name in names:
        a = reg.attributes[name]
        if not name.startswith(f"{reg.namespace}."):
            fail(
                "libo11y_app_attr_outside_namespace",
                name,
                f"not under the {reg.namespace} namespace",
            )
        if not _NAME_RE.match(name):
            fail(
                "libo11y_attr_naming",
                name,
                "not a dotted snake_case name with at least two segments",
            )
        if a.type not in _ATTRIBUTE_TYPES:
            fail("libo11y_app_type_unknown", name, f"type {go_quote(a.type)}")

        if not a.sensitivity:
            fail("libo11y_sensitivity_missing", name, "no sensitivity class")
        elif a.sensitivity not in _SENSITIVITIES:
            fail("libo11y_sensitivity_unknown", name, f"sensitivity {go_quote(a.sensitivity)}")

        if not a.cardinality:
            fail("libo11y_cardinality_missing", name, "no cardinality budget")
        elif a.cardinality not in _CARDINALITIES:
            fail("libo11y_cardinality_unknown", name, f"cardinality {go_quote(a.cardinality)}")

        if a.cardinality == "enum" and not a.values:
            fail("libo11y_app_enum_values_missing", name, "an enum declares its values")
        elif a.cardinality != "enum" and a.values:
            fail("libo11y_app_values_without_enum", name, "values need cardinality enum")

        seen: set[str] = set()
        for v in a.values:
            trimmed = _go_trim_space(v)
            if v != trimmed:
                fail("libo11y_enum_value_whitespace", name, f"value {go_quote(v)}")
            if trimmed in seen:
                fail("libo11y_enum_duplicate_value", name, f"value {go_quote(v)}")
            seen.add(trimmed)

    return tuple(violations)


def compile_app_registry(reg: AppRegistry, *, source: str | None = None) -> CompiledAppRegistry:
    """Validate reg and compile it into an immutable Sensitivity lookup table."""
    violations = validate_app_registry(reg)
    if violations:
        raise AppRegistryError(violations)
    classes: dict[str, Sensitivity] = {
        name: Sensitivity(reg.attributes[name].sensitivity)
        for name in sorted(reg.attributes.keys(), key=lambda s: s.encode("utf-8"))
    }
    return CompiledAppRegistry(
        namespace=reg.namespace,
        classes=MappingProxyType(classes),
        source=source,
    )


def load_app_registry(path: str | Path) -> CompiledAppRegistry:
    """Read, parse, validate, and compile an application registry YAML file."""
    p = Path(path)
    reg = parse_app_registry_bytes(p.read_bytes())
    return compile_app_registry(reg, source=str(p))
