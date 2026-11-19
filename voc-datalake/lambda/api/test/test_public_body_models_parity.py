"""The API Gateway request models of the public write routes are never stricter than their handlers.

`lib/stacks/api-request-models.ts` declares the JSON Schema (draft 4) models API Gateway checks before
`POST /feedback-forms/{form_id}/submit` and `POST /voting-sessions/{session_id}/submit` reach their Lambda.
A model that refuses a body its handler accepts breaks the embeddable widget or the ballot page with a gateway 400
nobody sees in the Lambda logs. The synthesized models are pinned in ``schemas/public-body-models.json`` (by
`lib/stacks/api-request-validation.test.ts`); here every body of a boundary table goes through BOTH the handler's
own validation and a draft-4 validator of that model, and a body the handler takes must pass the model.

Equal constants (the lockstep in api-request-validation.test.ts) do not prove equal semantics: this does, for
bounds (exact and one over), types (a numeric string, a boolean, a list), nulls, blanks and non-ASCII text, where a
length counts code points in both (a probe of the deployed gateway on 2026-11-03: 150 emoji, 300 UTF-16 units,
passed `maxLength: 200`). The model may be LOOSER; those cases are listed so that a tightening shows up here.
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from jsonschema import Draft4Validator

from shared.exceptions import ValidationError
from shared.test.repo_paths import repo_root

MODELS = json.loads((repo_root() / 'schemas' / 'public-body-models.json').read_text())
FORM_MODEL = Draft4Validator(MODELS['FeedbackFormSubmission'])
EVENT_MODEL = Draft4Validator(MODELS['FeedbackFormEvent'])
BALLOT_MODEL = Draft4Validator(MODELS['BallotSubmission'])

EMOJI = '\U0001f600'


def _form_bodies(h: Any) -> list[dict]:
    """Boundary bodies for the form submission, built from the handler's own constants."""
    long_value = 'v' * h.MAX_CUSTOM_FIELD_VALUE_CHARS
    full = {f'k{n}': 'x' for n in range(h.MAX_CUSTOM_FIELDS)}
    bodies: list[dict] = [
        {'text': 'ok'}, {'text': '  padded  '}, {'text': '   '}, {'text': None}, {'text': ''}, {'text': 5},
        {'text': EMOJI * h.MAX_SUBMISSION_TEXT_CHARS}, {'text': 'a' * (h.MAX_SUBMISSION_TEXT_CHARS + 1)},
        {'text': 'ok', 'participant_token': 'tok', 'pin': {'x': 1}},
    ]
    ratings = (None, 1, 1.5, h.MAX_SUBMISSION_RATING, 0, h.MAX_SUBMISSION_RATING + 1, '5', True, -1)
    bodies += [{'text': 'ok', 'rating': rating} for rating in ratings]
    bounded = (('name', h.MAX_SUBMITTER_NAME_CHARS), ('email', h.MAX_SUBMITTER_EMAIL_CHARS),
               ('page_url', h.MAX_PAGE_URL_CHARS))
    bodies += [{'text': 'ok', field: value} for field, bound in bounded
               for value in (None, '', 'a' * bound, EMOJI * bound, 'a' * (bound + 1), 7, ['a'])]
    custom = [None, {}, full, {**full, 'extra': 'x'}, {'': 'x'}, {'k' * h.MAX_CUSTOM_FIELD_KEY_CHARS: 'x'},
              {'k' * (h.MAX_CUSTOM_FIELD_KEY_CHARS + 1): 'x'}, {'a': long_value}, {'a': long_value + 'v'},
              {'a': EMOJI * h.MAX_CUSTOM_FIELD_VALUE_CHARS}, {'a': 3}, {'a': 2.5}, {'a': False}, {'a': None},
              {'a': ['x']}, {'a': {'b': 1}}, 'text', []]
    bodies += [{'text': 'ok', 'custom_fields': value} for value in custom]
    dims = {f'd{n}': 'v' for n in range(h.MAX_WIDGET_DIMENSIONS)}
    bodies += [{'text': 'ok', 'dimensions': value}
               for value in (None, {}, dims, {**dims, 'extra': 'v'}, {'d': 5}, {'d': ['v']}, 'region', [])]
    return bodies + _v2_bodies(h)


def _v2_bodies(h: Any) -> list[dict]:
    """Schema version 2 responses at their envelope bounds, and a beacon sent to submit (7.55.00)."""
    full = {f'q_{n}': 'x' for n in range(h.MAX_FORM_ANSWERS)}
    hidden = {f'h{n}': 'v' for n in range(h.MAX_HIDDEN_FIELDS)}
    answers = [{}, {'q_a': 1}, full, {**full, 'q_extra': 1}, {'Q1': 1}, {'q_' + 'a' * 40: 'x'}, {'q_' + 'a' * 41: 'x'},
               [], 'x', None]
    bodies: list[dict] = [{'answers': value} for value in answers]
    bodies += [{'answers': {'q_a': 1}, 'hidden': value} for value in (
        None, {}, hidden, {**hidden, 'h_extra': 'v'}, {'user_id': 'x' * 300}, {'user_id': None}, {'1x': 'v'},
        {'user_id': 5}, [])]
    bodies += [{'answers': {'q_a': 1}, field: value} for field, values in (
        ('form_revision', (None, 1, 7, 0, -1, 1.5, True, '2')),
        ('language', (None, 'pl', 'en', 'it', 'PL', 5)),
        ('ending_id', (None, 'end_a', 'e' * h.MAX_FORM_ID_CHARS, 'e' * (h.MAX_FORM_ID_CHARS + 1), 5)),
        ('form_id', (None, 'ff_1', 'f' * h.FORM_ID_MAX_LENGTH, 'f' * (h.FORM_ID_MAX_LENGTH + 1))),
        ('test', (None, 't' * h.MAX_TEST_TOKEN_CHARS, 't' * (h.MAX_TEST_TOKEN_CHARS + 1), 5)),
        ('page_url', (None, 'https://x.example', 'u' * 4097)),
        ('participant_token', ('tok',)), ('is_test', (True,)),
    ) for value in values]
    bodies += [{'answers': {'q_a': 1}, 'session': value} for value in (
        None, '0123456789abcdef01234567', 'abcdefgh', 'short', 'a' * 64, 'a' * 65, 'not a session', 5)]
    bodies += [{'answers': {'q_a': 1}, 'channel': value} for value in (
        None, 'link', 'iframe', 'script', 'app', 'LINK', '', 5)]
    # A beacon is the events route's: the submit refuses one (its limit is for responses only).
    bodies += [{'event': {'kind': 'opened', 'session': '0123456789abcdef01234567'}}]
    return bodies


def _event_bodies(h: Any) -> list[dict]:
    """The widget's beacons (POST …/events) at their bounds."""
    event = {'kind': 'left', 'question_id': 'q_a', 'session': '0123456789abcdef01234567'}
    opened = {'kind': 'opened', 'session': '0123456789abcdef01234567'}
    bodies: list[dict] = [{'event': value} for value in (
        event, {**event, 'session': 'abcdefgh', 'revision': 2}, {**event, 'session': 'short'},
        {'kind': 'left', 'question_id': 'q_a'}, {**event, 'session': 'a' * 65}, {**event, 'session': None},
        {**event, 'revision': 0}, {**event, 'extra': 1}, {'kind': 'open'}, {'kind': 'left'}, {**event, 'kind': 'step'},
        'left', None, opened, {**opened, 'revision': 3}, {'kind': 'opened'}, {**opened, 'question_id': 'q_a'},
        {**opened, 'revision': 0}, {'kind': 'left', 'session': '0123456789abcdef01234567'})]
    bodies += [{'event': opened, 'test': value}
               for value in (None, 'tok', 't' * h.MAX_TEST_TOKEN_CHARS, 't' * (h.MAX_TEST_TOKEN_CHARS + 1), 5)]
    return [*bodies, {}, {'event': event, 'answers': {}}, {'event': event, 'session': 'x'}]


def _handler_accepts(validate: Any, body: dict) -> bool:
    try:
        validate(body)
    except ValidationError:  # the handlers' 400; any other exception is a test bug and propagates
        return False
    return True


def _form_handler_validation(h: Any) -> Any:
    """What the submit route checks before it reads the form: no beacon, then a version 2 body's envelope
    (shared/forms_v2_responses.py check_envelope) or the version 1 widget's fields."""
    def validate(body: dict) -> None:
        if 'event' in body:
            raise ValidationError('A beacon goes to POST /feedback-forms/{id}/events, not to submit')
        h._validated_envelope(body, h.fresp.is_v2_response(body))
        h._widget_dimensions(body)
    return validate


def test_form_model_accepts_every_body_the_handler_accepts(feedback_form_handler):
    bodies = _form_bodies(feedback_form_handler)
    validate = _form_handler_validation(feedback_form_handler)
    refused_by_model_only = [body for body in bodies
                             if _handler_accepts(validate, body) and not FORM_MODEL.is_valid(body)]
    assert refused_by_model_only == []


def test_form_model_is_looser_than_the_handler_only_where_documented(feedback_form_handler):
    """The model refuses what the handler refuses, except the documented looser cases, listed by name.

    Looser on purpose (module docstring of api-request-models.ts): a `text` the handler judges after stripping
    (blank, or over its bound), a `custom_fields` key over the handler's length (draft 4 has no
    `propertyNames`), an extra top-level field on a version 2 body, and a beacon sent to submit (the events route's).
    A new looser case fails here and must be added to the list on purpose; a case the model starts refusing fails too,
    so a tightening is reviewed against the parity test above.
    """
    h = feedback_form_handler
    bodies = _form_bodies(h)
    validate = _form_handler_validation(h)
    refused = [body for body in bodies if not _handler_accepts(validate, body)]
    looser = [body for body in refused if FORM_MODEL.is_valid(body)]
    assert len(refused) > 20  # vacuity: the table exercises the refusals
    expected = [
        {'text': '   '},
        {'text': 'a' * (h.MAX_SUBMISSION_TEXT_CHARS + 1)},
        {'text': 'ok', 'custom_fields': {'k' * (h.MAX_CUSTOM_FIELD_KEY_CHARS + 1): 'x'}},
        # Extra top-level fields stay allowed (the version 1 widget's participant_token, a pin's pin): the handler
        # refuses a version 2 body's unknown keys, and a beacon (POST …/events takes it).
        {'answers': {'q_a': 1}, 'is_test': True},
        {'event': {'kind': 'opened', 'session': '0123456789abcdef01234567'}},
    ]
    # Compared as a set: the order of the boundary table is not what this test is about.
    assert sorted(map(json.dumps, looser)) == sorted(map(json.dumps, expected))


def test_event_model_accepts_every_beacon_the_handler_accepts(feedback_form_handler):
    h = feedback_form_handler
    bodies = _event_bodies(h)
    refused_by_model_only = [body for body in bodies
                             if _handler_accepts(h._validated_event, body) and not EVENT_MODEL.is_valid(body)]
    assert refused_by_model_only == []
    assert sum(_handler_accepts(h._validated_event, body) for body in bodies) >= 4  # vacuity


def test_event_model_is_strict_and_looser_only_per_kind(feedback_form_handler):
    """The beacons' model refuses an unknown field (unlike the submission's): no older widget sends anything else
    there. One event shape in draft 4 (no `oneOf`): the handler alone requires a `left`'s question_id and refuses an
    `opened`'s."""
    h = feedback_form_handler
    refused = [body for body in _event_bodies(h) if not _handler_accepts(h._validated_event, body)]
    looser = [body for body in refused if EVENT_MODEL.is_valid(body)]
    assert sorted(map(json.dumps, looser)) == sorted(map(json.dumps, [
        {'event': {'kind': 'opened', 'session': '0123456789abcdef01234567', 'question_id': 'q_a'}},
        {'event': {'kind': 'left', 'session': '0123456789abcdef01234567'}},
    ]))
    assert not EVENT_MODEL.is_valid({'event': {'kind': 'opened', 'session': '0123456789abcdef01234567'}, 'extra': 1})


def _ballot_bodies(h: Any) -> list[dict]:
    bound = h.MAX_BALLOT_NOTE_LEN
    notes = [None, '', '   ', 'a' * bound, EMOJI * bound, f'  {"a" * bound}  ', 'a' * (bound + 1), 3, ['a']]
    return [{}, {'axes': {'reach': 3}, 'extra': 1}, *({'notes': note} for note in notes)]


@pytest.fixture
def ballots_handler():
    import ballots_handler
    return ballots_handler


def test_ballot_model_accepts_every_note_the_handler_accepts(ballots_handler):
    def validate(body: dict) -> None:
        ballots_handler._validated_note(body.get('notes'))

    bodies = _ballot_bodies(ballots_handler)
    assert [body for body in bodies if _handler_accepts(validate, body) and not BALLOT_MODEL.is_valid(body)] == []
    # Only the type is modelled: the length is checked after stripping (module docstring).
    assert not BALLOT_MODEL.is_valid({'notes': 3})
