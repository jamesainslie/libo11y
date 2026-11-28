"""Redaction contract: postponed annotations, JSON, logging, pickle and copy."""

from __future__ import annotations

import copy
import dataclasses
import io
import json
import logging
import pickle
from collections.abc import Callable
from typing import Annotated, cast

import pytest

from libo11y.redact import Masked, Secret, json_default, redacted, render_redacted

# Finding 5: annotations resolve under `from __future__ import annotations`.


def test_redacted_accepts_a_self_referencing_dataclass() -> None:
    @redacted
    @dataclasses.dataclass
    class Node:
        name: Annotated[str, "mask"]
        child: Node | None = None

    assert str(Node("ab", Node("xyz"))) == "{name:XX child:{name:XXX child:None}}"


def test_redacted_accepts_a_class_defined_in_the_same_function_scope() -> None:
    @dataclasses.dataclass
    class Inner:
        pw: str

    @redacted
    @dataclasses.dataclass
    class Outer:
        inner: Annotated[Inner, "secret"]
        label: str

    assert str(Outer(Inner("hunter2"), "ok")) == "{inner:REDACTED label:ok}"


def test_redacted_accepts_a_reference_to_a_class_defined_later() -> None:
    @redacted
    @dataclasses.dataclass
    class Order:
        card: Annotated[Card, "mask"]

    @dataclasses.dataclass
    class Card:
        number: str

    assert render_redacted(Order(Card("4111"))) == {"card": {"number": "XXXX"}}


def test_redacted_rejects_an_unknown_tag_at_class_definition() -> None:
    with pytest.raises(TypeError, match="unknown redaction tag 'pii'"):

        @redacted
        @dataclasses.dataclass
        class _Bad:
            email: Annotated[str, "pii"]


def test_redacted_rejects_an_unknown_tag_beside_an_unresolved_local_type() -> None:
    with pytest.raises(TypeError, match="unknown redaction tag 'masked'"):

        @redacted
        @dataclasses.dataclass
        class _Bad:
            card: Annotated[Later, "masked"]

    @dataclasses.dataclass
    class Later:
        n: str


def test_redacted_rejects_a_tag_it_cannot_resolve_at_class_definition() -> None:
    # A postponed annotation naming a tag constant that does not exist yet.
    cls = dataclasses.make_dataclass("Bad", [("email", "Annotated[str, LATER_TAG]")])
    with pytest.raises(TypeError, match="field 'email'"):
        redacted(cls)


def test_redacted_resolves_inherited_fields_and_module_aliases() -> None:
    @redacted
    @dataclasses.dataclass
    class Base:
        token: _SecretStr

    @redacted
    @dataclasses.dataclass
    class Child(Base):
        name: Annotated[str, "mask"]

    assert str(Child("tok", "ab")) == "{token:REDACTED name:XX}"


_SecretStr = Annotated[str, "secret"]


# Finding 6: the JSON contract.


@redacted
@dataclasses.dataclass
class _Account:
    user: Annotated[str, "mask"]
    password: Annotated[str, "redact"]
    internal: Annotated[str, "omit"]
    note: str
    key: Secret[str]


@redacted
@dataclasses.dataclass
class _Wrapper:
    account: Annotated[_Account, "mask"]
    plain: _Account


def _account() -> _Account:
    return _Account("bob", "pw-raw", "int-raw", "hi", Secret("key-raw"))


_RAW_VALUES = ("bob", "pw-raw", "int-raw", "key-raw", "cardraw")


def _assert_no_raw(text: str) -> None:
    for raw in _RAW_VALUES:
        assert raw not in text


@pytest.mark.parametrize(
    "value",
    [Secret("cardraw"), Masked("cardraw"), _account()],
    ids=["secret", "masked", "redacted"],
)
def test_json_dumps_without_a_hook_fails_closed(value: object) -> None:
    with pytest.raises(TypeError):
        json.dumps(value)


@pytest.mark.parametrize(
    "value",
    [Secret("cardraw"), Masked("cardraw"), _account()],
    ids=["secret", "masked", "redacted"],
)
def test_json_dumps_inside_a_container_without_a_hook_fails_closed(value: object) -> None:
    with pytest.raises(TypeError):
        json.dumps({"nested": [value]})


def test_json_default_renders_secret_and_masked() -> None:
    out = json.dumps({"s": Secret("cardraw"), "m": Masked("cardraw")}, default=json_default)
    assert json.loads(out) == {"s": "REDACTED", "m": "XXXXXXX"}


def test_json_default_renders_a_redacted_dataclass_with_omitted_fields_absent() -> None:
    out = json.dumps(_account(), default=json_default)
    _assert_no_raw(out)
    assert json.loads(out) == {
        "user": "XXX",
        "password": "REDACTED",
        "note": "hi",
        "key": "REDACTED",
    }


def test_json_default_applies_the_strictest_protection_through_nesting() -> None:
    out = json.dumps(_Wrapper(_account(), _account()), default=json_default)
    _assert_no_raw(out)
    assert json.loads(out) == {
        "account": {"user": "XXX", "password": "REDACTED", "note": "XX", "key": "REDACTED"},
        "plain": {"user": "XXX", "password": "REDACTED", "note": "hi", "key": "REDACTED"},
    }


def test_json_default_rejects_other_unserializable_values() -> None:
    with pytest.raises(TypeError, match="not JSON serializable"):
        json.dumps({1, 2}, default=json_default)


def test_redacted_docstring_says_asdict_returns_raw_values() -> None:
    assert redacted.__doc__ is not None
    assert "dataclasses.asdict" in redacted.__doc__


def test_dataclasses_asdict_returns_raw_values_as_documented() -> None:
    assert dataclasses.asdict(_account())["password"] == "pw-raw"


# Logging, pickle and copy: what they do today, recorded as the contract.


@pytest.mark.parametrize(
    ("value", "want"),
    [(Secret("cardraw"), "REDACTED"), (Masked("cardraw"), "XXXXXXX")],
    ids=["secret", "masked"],
)
def test_stdlib_logging_renders_the_protected_form(value: object, want: str) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = logging.getLogger("libo11y.test.redact")
    logger.addHandler(handler)
    logger.propagate = False
    try:
        logger.warning("value=%s repr=%r", value, value)
    finally:
        logger.removeHandler(handler)
    assert stream.getvalue() == f"value={want} repr={want}\n"


def test_redacted_instance_logs_the_protected_form() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = logging.getLogger("libo11y.test.redact.dataclass")
    logger.addHandler(handler)
    logger.propagate = False
    try:
        logger.warning("%s", _account())
    finally:
        logger.removeHandler(handler)
    _assert_no_raw(stream.getvalue())


@pytest.mark.parametrize(
    "value",
    [Secret("cardraw"), Masked("cardraw")],
    ids=["secret", "masked"],
)
def test_pickle_round_trips_the_value_and_keeps_it_protected(
    value: Secret[str] | Masked[str],
) -> None:
    restored = pickle.loads(pickle.dumps(value))
    assert type(restored) is type(value)
    assert restored.reveal() == "cardraw"
    assert str(restored) == str(value)
    assert repr(restored) == repr(value)


@pytest.mark.parametrize("copier", [copy.copy, copy.deepcopy], ids=["copy", "deepcopy"])
def test_copies_keep_the_value_and_stay_protected(copier: Callable[[object], object]) -> None:
    copied = copier(Secret("cardraw"))
    assert isinstance(copied, Secret)
    secret = cast(Secret[str], copied)
    assert secret.reveal() == "cardraw"
    assert str(secret) == "REDACTED"
    account = copier(_account())
    assert isinstance(account, _Account)
    _assert_no_raw(repr(account))
