"""Single key-based sensitivity policy shared across traces, metrics, logs, and resource."""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping, Sequence
from enum import Enum
from pathlib import Path
from typing import Any, Final, cast

from libo11y._internal.pii import (
    MAX_COMPOSITE_DEPTH,
    MAX_COMPOSITE_NODES,
    MIN_PII_HASH_KEY_LEN,
    pii_token,
)
from libo11y.errors import InvalidAppRegistry, PIIHashKey
from libo11y.options import AttrReplacer, PIIMode
from libo11y.redact import contains_redactable, render_redacted
from libo11y.spec import (
    SENSITIVITY_OF,
    AppRegistryError,
    AppRegistryParseError,
    CompiledAppRegistry,
    Sensitivity,
    Signal,
    load_app_registry,
)

RULE_SECRET: Final[str] = "secret_attribute"
RULE_PII: Final[str] = "pii_attribute"

type ViolationCallback = Callable[[Signal, str], None]


class Action(Enum):
    KEEP = 0
    REWRITE = 1
    DROP = 2


class ViolationRecorder:
    """Buffers violations before the meter provider exists, then records to the counter."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: list[tuple[Signal, str]] = []
        self._sink: ViolationCallback | None = None

    def attach(self, sink: ViolationCallback) -> None:
        with self._lock:
            self._sink = sink
            pending = self._pending
            self._pending = []
        for sig, rule in pending:
            sink(sig, rule)

    def record(self, signal: Signal, rule: str) -> None:
        with self._lock:
            sink = self._sink
            if sink is None:
                self._pending.append((signal, rule))
                return
        sink(signal, rule)


def load_app_registries(
    spec_paths: str | Path | tuple[str | Path, ...] | None,
) -> dict[str, Sensitivity]:
    """Load and validate one or more app registry files, rejecting duplicate namespaces."""
    if spec_paths is None:
        return {}
    paths = (spec_paths,) if isinstance(spec_paths, (str, Path)) else spec_paths
    by_ns: dict[str, str] = {}
    classes: dict[str, Sensitivity] = {}
    for p in paths:
        try:
            compiled: CompiledAppRegistry = load_app_registry(p)
        except (OSError, AppRegistryParseError, AppRegistryError) as exc:
            raise InvalidAppRegistry(f"o11y: invalid application registry: {exc}") from exc
        prev = by_ns.get(compiled.namespace)
        if prev is not None:
            raise InvalidAppRegistry(
                f"o11y: invalid application registry: duplicate namespace "
                f"{compiled.namespace!r} declared in {prev} and {p}"
            )
        by_ns[compiled.namespace] = str(p)
        classes.update(compiled.classes)
    return classes


class SensitivityPolicy:
    """Enforces specification + app-registry sensitivity across all signals."""

    def __init__(
        self,
        *,
        pii_mode: PIIMode = PIIMode.DROP,
        pii_hash_key: bytes | None = None,
        app_classes: Mapping[str, Sensitivity] | None = None,
        recorder: ViolationRecorder | None = None,
    ) -> None:
        if pii_mode is PIIMode.HASH and (
            pii_hash_key is None or len(pii_hash_key) < MIN_PII_HASH_KEY_LEN
        ):
            raise PIIHashKey()
        self.pii_mode = pii_mode
        self._key = pii_hash_key or b""
        self._app = dict(app_classes) if app_classes else {}
        self._recorder = recorder

    def silent(self) -> SensitivityPolicy:
        """Return a clone that makes identical decisions without counting violations."""
        clone = SensitivityPolicy.__new__(SensitivityPolicy)
        clone.pii_mode = self.pii_mode
        clone._key = self._key
        clone._app = self._app
        clone._recorder = None
        return clone

    def lookup(self, key: str) -> Sensitivity | None:
        cls = SENSITIVITY_OF.get(key)
        if cls is not None:
            return cls
        return self._app.get(key)

    def action_for(self, cls: Sensitivity | None) -> Action:
        if cls is Sensitivity.SECRET:
            return Action.DROP
        if cls is Sensitivity.PII:
            if self.pii_mode is PIIMode.ALLOW:
                return Action.KEEP
            if self.pii_mode is PIIMode.HASH:
                return Action.REWRITE
            return Action.DROP
        return Action.KEEP

    def decide(self, signal: Signal, key: str) -> Action:
        cls = self.lookup(key)
        act = self.action_for(cls)
        if act is not Action.KEEP and self._recorder is not None:
            rule = RULE_SECRET if cls is Sensitivity.SECRET else RULE_PII
            self._recorder.record(signal, rule)
        return act

    def metric_keep(self, key: str) -> bool:
        """Report whether a metric attribute may be exported (PII dropped even in hash mode)."""
        cls = self.lookup(key)
        if cls is Sensitivity.SECRET:
            return False
        if cls is Sensitivity.PII:
            return self.pii_mode is PIIMode.ALLOW
        return True

    def tokenize(self, value: object) -> str:
        return pii_token(self._key, value)

    def classify_flat(
        self,
        signal: Signal,
        attrs: Mapping[str, Any] | None,
    ) -> tuple[dict[str, Any], bool]:
        """Classify a flat attribute mapping (spans, events, links, resource)."""
        if not attrs:
            return {}, False
        changed = False
        out: dict[str, Any] = {}
        for k, v in attrs.items():
            act = self.decide(signal, k)
            if act is Action.DROP:
                changed = True
                continue
            if act is Action.REWRITE:
                changed = True
                out[k] = self.tokenize(v)
            else:
                out[k] = v
        return out, changed

    def classify_log_attributes(
        self,
        attrs: Mapping[str, Any],
        replacer: AttrReplacer | None = None,
    ) -> dict[str, Any]:
        """Apply capture-time redaction, the user replacer and the policy to log attributes.

        Nested mappings and sequences are walked so every member is judged on
        its dotted effective key, as go/logredact.go does. The walk fails
        closed: one budget of 2048 nodes is shared by the whole call and spent
        before a node is examined, a mapping whose effective key has more than
        16 parts or a sequence nested 16 deep is not entered, and a reference
        back into the current path (the root mapping included) is cut. What
        the walk did not examine is dropped, and so is a mapping or sequence
        that classification emptied.
        """
        budget = [MAX_COMPOSITE_NODES]
        active = {id(attrs)}
        out, _ = self._walk_mapping(attrs, (), budget, active, replacer)
        return out

    def _spend(self, budget: list[int]) -> bool:
        """Take one node from the walk's budget and report whether any remained."""
        if budget[0] <= 0:
            return False
        budget[0] -= 1
        return True

    def _walk_mapping(
        self,
        mapping: Mapping[str, Any],
        groups: tuple[str, ...],
        budget: list[int],
        active: set[int],
        replacer: AttrReplacer | None,
    ) -> tuple[dict[str, Any], bool]:
        """Classify one mapping's members: what survives, and whether any member was dropped."""
        out: dict[str, Any] = {}
        changed = False
        for raw_k, raw_v in mapping.items():
            if not self._spend(budget):
                return out, True  # the budget is spent: drop the remaining members
            k = str(raw_k)
            # Capture-time redaction first so the user replacer never sees a raw Secret or Masked.
            val: Any = render_redacted(raw_v) if contains_redactable(raw_v) else raw_v

            if replacer is not None:
                replaced = replacer(groups, k, val)
                if replaced is None or not replaced[0]:
                    changed = True
                    continue
                k, val = replaced

            full_key = ".".join((*groups, k))
            act = self.decide(Signal.LOGS, full_key)
            if act is Action.DROP:
                changed = True
                continue
            if act is Action.REWRITE:
                out[k] = self.tokenize(val)
                continue

            member, keep, member_changed = self._walk_value(
                val, (*groups, k), 0, budget, active, replacer
            )
            changed = changed or member_changed
            if keep:
                out[k] = member
        return out, changed

    def _walk_value(
        self,
        value: Any,
        path: tuple[str, ...],
        depth: int,
        budget: list[int],
        active: set[int],
        replacer: AttrReplacer | None,
    ) -> tuple[Any, bool, bool]:
        """Classify one value held under the effective key path.

        Returns the classified value, whether to keep it, and whether
        classification dropped anything. depth counts sequence nesting, and a
        mapping member starts again at zero, so mappings are bounded by the
        length of their effective key and sequences by their nesting.
        """
        if contains_redactable(value):
            value = render_redacted(value)
        if isinstance(value, (bool, int, float, str)) or value is None:
            return value, True, False
        if isinstance(value, (bytes, bytearray)):
            return bytes(value), True, False
        if not isinstance(value, (Mapping, Sequence)):
            return str(value), True, False

        oid = id(cast(object, value))
        if (
            depth >= MAX_COMPOSITE_DEPTH
            or len(path) > MAX_COMPOSITE_DEPTH
            or not self._spend(budget)
            or oid in active
        ):
            return None, False, True
        active.add(oid)
        try:
            if isinstance(value, Mapping):
                m = cast(Mapping[str, Any], value)
                out, changed = self._walk_mapping(m, path, budget, active, replacer)
                return out, bool(out) or not changed, changed
            seq = cast(Sequence[Any], value)
            kept: list[Any] = []
            changed = False
            for el in seq:
                if not self._spend(budget):
                    changed = True  # the budget is spent: drop the remaining elements
                    break
                member, keep, member_changed = self._walk_value(
                    el, path, depth + 1, budget, active, replacer
                )
                changed = changed or member_changed
                if keep:
                    kept.append(member)
            return kept, bool(kept) or not changed, changed
        finally:
            active.discard(oid)
