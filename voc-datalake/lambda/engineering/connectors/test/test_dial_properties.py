"""Properties of the dial (connectors/dial.py): a run pushes only when the stored way of working allows it, and the
dial fails closed. Fakes instead of moto: these are about the decision, not about DynamoDB."""
from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import BotoCoreError, ClientError
from hypothesis import given
from hypothesis import strategies as st

from engineering.connectors.dial import _PERSON, PUSHING_MODES, WaysOfWorking
from engineering.connectors.hosts import Unavailable
from shared.ai_mode import MODE_AI_ASSISTED, MODE_AI_DRIVEN, MODE_HUMAN_DRIVEN, MODES, ai_mode_key
from shared.test.properties import PROPERTY

# A person's sub as Cognito writes it: a UUID, and the shapes that are not a person (an agent, a token, a plan).
PERSON_SUBS = st.uuids().map(str)
NOT_PERSONS = st.one_of(
    st.from_regex(r'agent:[a-z0-9-]{1,20}', fullmatch=True),
    st.from_regex(r'mcp:tok_[a-z0-9]{1,12}', fullmatch=True),
    st.from_regex(r'plan:[a-z0-9-]{1,20}', fullmatch=True),
    st.from_regex(r'human:[a-z0-9-]{1,20}', fullmatch=True),
    st.just(''),
)
# What a row's mode attribute can hold: the three modes, near misses a hand edit or a newer writer could leave, and
# anything at all.
STORED = st.one_of(
    st.sampled_from(MODES),
    st.sampled_from(['AI_DRIVEN', 'ai-driven', 'ai_first', ' ai_driven', 'ai_driven ', 'human', '']),
    st.text(max_size=20),
)


class Table:
    """A table holding one row for one key, reading as DynamoDB does (an absent row is an empty answer)."""

    def __init__(self, item: dict[str, Any] | None = None, error: Exception | None = None) -> None:
        self.item = item
        self.error = error
        self.requests: list[dict[str, Any]] = []

    def get_item(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return {'Item': self.item} if self.item is not None else {}


@PROPERTY
@given(person=PERSON_SUBS, stored=STORED)
def test_only_an_explicit_ai_assisted_or_ai_driven_row_lets_a_run_push(person: str, stored: str) -> None:
    """A person's run may push only when the row stores exactly ai_assisted or ai_driven; any other stored text,
    including a near miss of those two, is Human-driven (the dial fails closed)."""
    table = Table({'mode': stored})
    mode = WaysOfWorking(table).mode(person)
    assert (mode in PUSHING_MODES) == (stored in PUSHING_MODES)
    assert mode == (stored if stored in PUSHING_MODES else MODE_HUMAN_DRIVEN)


@PROPERTY
@given(person=PERSON_SUBS)
def test_a_person_with_no_row_pushes_nothing(person: str) -> None:
    """No saved way of working is Human-driven, for any person (stricter than shared/ai_mode.py's default)."""
    assert WaysOfWorking(Table(None)).mode(person) == MODE_HUMAN_DRIVEN


@PROPERTY
@given(person=st.one_of(NOT_PERSONS, st.text(max_size=140), PERSON_SUBS,
                        # Names around the 128-character bound: up to it a subject, past it not one.
                        st.from_regex(r'[A-Za-z0-9][A-Za-z0-9-]{120,135}', fullmatch=True)))
def test_what_is_not_a_person_is_human_driven_and_never_read(person: str) -> None:
    """Something that is not a person's subject (an agent, a token, a plan, an empty name, too long a name) is
    Human-driven without a read; a person's subject is read, as its own key, and nothing else is."""
    table = Table({'mode': MODE_AI_DRIVEN})
    mode = WaysOfWorking(table).mode(person)
    if _PERSON.fullmatch(person) is None:
        assert mode == MODE_HUMAN_DRIVEN
        assert table.requests == []
    else:
        assert len(table.requests) == 1
        assert table.requests[0]['Key'] == ai_mode_key(person)
        assert mode == MODE_AI_DRIVEN


@PROPERTY
@given(person=PERSON_SUBS)
def test_the_read_is_consistent_and_asks_for_the_mode_attribute_alone(person: str) -> None:
    """The broker reads the mode strongly consistently and projects only its attribute (the IAM grant allows that)."""
    table = Table({'mode': MODE_AI_ASSISTED, 'secret_note': 'x'})
    assert WaysOfWorking(table).mode(person) == MODE_AI_ASSISTED
    (request,) = table.requests
    assert request['ConsistentRead'] is True
    assert request['ProjectionExpression'] == '#mode'
    assert request['ExpressionAttributeNames'] == {'#mode': 'mode'}


@PROPERTY
@given(person=PERSON_SUBS,
       code=st.sampled_from(['ThrottlingException', 'ProvisionedThroughputExceededException', 'InternalServerError']),
       transport=st.booleans())
def test_a_failed_read_is_unavailable_never_a_pass(person: str, code: str, transport: bool) -> None:
    """Any failure of the read (a throttle, a 5xx, a lost connection) raises Unavailable: no mode is returned, so no
    push can follow from it. The agent is told, word for word, to retry; the person's subject is never in it."""
    error: Exception = (BotoCoreError() if transport
                        else ClientError({'Error': {'Code': code, 'Message': 'later'}}, 'GetItem'))
    with pytest.raises(Unavailable) as raised:
        WaysOfWorking(Table(error=error)).mode(person)
    assert str(raised.value) == 'The way of working of the person who started the run could not be read; retry.'
    assert raised.value.__cause__ is error
