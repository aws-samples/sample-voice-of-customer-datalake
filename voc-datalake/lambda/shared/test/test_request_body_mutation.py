"""Mutation hardening for `shared/request_body.py`.

Until now `json_object_body` was pinned only through the handlers that call it
(`test_projects_handler.py`, `test_projects_prioritization_ballots.py`), and
those tests look at an HTTP response: a 400 whose error merely CONTAINS
``'JSON'``. A mutation run of the helper itself found what that cannot see:

* the two refusals are DIFFERENT messages, and the handler tests accept either
  for both cases. ``'must be JSON'`` names a body that never parsed;
  ``'must be a JSON object'`` names one that parsed to the wrong shape. The
  Settings and Projects pages print `str(exc)` as the 400 body, so each wording
  is pinned here as a literal, for the exact input that earns it.
* the ``is None`` test is the whole point of the module (``or {}`` would wave
  ``[]``, ``false``, ``0`` and ``""`` through as "no body"), so the accepted
  side and the refused side of that check are both asserted on the helper's
  OWN return value — the absent cases come back as exactly ``{}``, an object
  body comes back as the very object that was parsed, and every falsy
  non-object is a refusal.
* the refusal for unparseable JSON chains the decoder's error (``from e``), so
  the log keeps the position the parser failed at.

A later confirmation run (7 mutants, 2 survivors) added one more: the
``@property`` decorators on the two Protocols. They have no runtime effect, so
no call can observe their removal, but they are what make the real resolver and
event classes satisfy the Protocols under pyright — pinned through the class
dictionaries.
"""
import json
from dataclasses import dataclass
from typing import Any

import pytest
from aws_lambda_powertools.utilities.data_classes import APIGatewayProxyEvent

from shared import request_body
from shared.exceptions import ValidationError
from shared.request_body import json_object_body


@dataclass(frozen=True)
class _App:
    """A stand-in for the handler's resolver (it satisfies `CurrentEventSource`)."""
    current_event: Any


def _app_with_body(raw_body: str | None) -> _App:
    """A stand-in for the handler's resolver: all the helper reads is
    `app.current_event.json_body`, and a real `APIGatewayProxyEvent` is what
    makes that read behave as it does in production (including returning None
    for a zero-length body without parsing it)."""
    return _App(current_event=APIGatewayProxyEvent({'body': raw_body}))


class TestAnAbsentBodyDefaultsToAnEmptyObject:
    @pytest.mark.parametrize('raw_body', [
        None,    # no body at all
        'null',  # a literal JSON null
        '',      # Content-Length: 0 — powertools returns None without parsing
    ], ids=['absent', 'json_null', 'zero_length'])
    def test_the_default_is_exactly_an_empty_dict(self, raw_body):
        assert json_object_body(_app_with_body(raw_body)) == {}

    def test_an_object_body_is_returned_as_parsed_not_copied(self):
        app = _app_with_body('{"doc_type": "prd", "n": 2}')

        body = json_object_body(app)

        assert body == {'doc_type': 'prd', 'n': 2}
        # The same object `json_body` cached: the helper neither copies nor rewrites it.
        assert body is app.current_event.json_body

    def test_an_empty_object_is_returned_empty(self):
        assert json_object_body(_app_with_body('{}')) == {}


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize('raw_body', [
        '{not json',
        '   ',          # whitespace only is truthy, so it IS parsed, and fails
        '{"a": 1,}',    # a trailing comma
        "{'a': 1}",     # single quotes
    ], ids=['malformed', 'whitespace', 'trailing_comma', 'single_quotes'])
    def test_a_body_that_does_not_parse_is_refused_as_not_json(self, raw_body):
        with pytest.raises(ValidationError) as exc_info:
            json_object_body(_app_with_body(raw_body))

        assert str(exc_info.value) == 'the request body must be JSON'
        assert exc_info.value.message == 'the request body must be JSON'
        assert exc_info.value.status_code == 400
        # Chained from the decoder's error, so the log keeps where parsing failed.
        assert isinstance(exc_info.value.__cause__, json.JSONDecodeError)

    @pytest.mark.parametrize('raw_body', [
        '[]',        # falsy: an `or {}` guard would have accepted it as "no body"
        'false',
        '0',
        '""',
        '[1, 2]',    # truthy non-objects
        '"hi"',
        '1.5',
        'true',
    ], ids=[
        'empty_list', 'false', 'zero', 'empty_string',
        'list', 'string', 'number', 'true',
    ])
    def test_a_body_that_parses_to_a_non_object_is_refused_by_shape(self, raw_body):
        with pytest.raises(ValidationError) as exc_info:
            json_object_body(_app_with_body(raw_body))

        assert str(exc_info.value) == 'the request body must be a JSON object'
        assert exc_info.value.message == 'the request body must be a JSON object'
        assert exc_info.value.status_code == 400
        # Not a parse failure: nothing is chained, the body was valid JSON.
        assert exc_info.value.__cause__ is None

    def test_the_two_refusals_are_distinguishable(self):
        """The handler tests accept ``'JSON' in error`` for both cases; the page
        reads two different sentences, so the two wordings must differ."""
        with pytest.raises(ValidationError) as unparseable:
            json_object_body(_app_with_body('{not json'))
        with pytest.raises(ValidationError) as wrong_shape:
            json_object_body(_app_with_body('[]'))

        assert str(unparseable.value) != str(wrong_shape.value)

    def test_a_non_json_error_from_the_event_is_not_disguised_as_a_request_fault(self):
        """Only `ValueError` (which `JSONDecodeError` is) is the caller's mistake.
        Anything else raised while reading the body is this service's problem
        and must keep its own type for the catch-all to count as a 500."""
        class _BrokenEvent:
            @property
            def json_body(self):
                raise RuntimeError('event store unavailable')

        with pytest.raises(RuntimeError, match='event store unavailable'):
            json_object_body(_App(current_event=_BrokenEvent()))


class TestTheProtocolsDeclareAttributesNotMethods:
    """`CurrentEventSource` and `_JsonBodyEvent` type the helper's parameter.
    Their members are declared as read-only PROPERTIES: that is what lets a
    Powertools resolver (`current_event` is an instance attribute) and the real
    `APIGatewayProxyEvent` (`json_body` is a cached_property) satisfy them, and
    what lets the frozen dataclass above stand in for the resolver. Declared as
    methods instead, every real caller would stop type-checking — a change the
    runtime cannot see, so it is pinned here through the class dictionaries."""

    @pytest.mark.parametrize(('protocol', 'member'), [
        (request_body._JsonBodyEvent, 'json_body'),
        (request_body.CurrentEventSource, 'current_event'),
    ])
    def test_the_member_is_a_property(self, protocol, member):
        assert isinstance(vars(protocol)[member], property)
