"""The public submit's hook for a prototype's pin form (7.68.00, api/feedback_form_handler.py into
shared/prototype_validation.py): a pin is stored as before and never queued; a validation answer is queued as a
``feedback_form`` item of the form's channel, tagged ``prototype_validation``, and never stored as a pin; a version 2
body on a pin form that asks no questions is a 400; an empty one answers the card. Every answer keeps ``Origin: null``
working, as the pins' do (the widget opened on its own posts from an opaque origin)."""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from prototype_pins_fixtures import project_tables

from shared import prototype_pins
from shared import prototype_validation as proto
from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

PROJECT = 'proj_1'
DOC = 'prototype_abc123'
FORM = prototype_pins.pin_form_id(DOC)
TASKS = [{'id': 't00aa11', 'text': 'Pay the March invoice'}]
CRITERIA = [{'id': 'c00aa11', 'text': 'Paying is quick'}]
PIN = {'text': 'This button is hard to see', 'pin': {'selector': '#pay'}}


@pytest.fixture
def aggregates():
    with project_tables(PROJECT, {}) as (_projects, table):
        prototype_pins.ensure_pin_form(table, PROJECT, DOC, 'Checkout')
        yield table


@pytest.fixture
def submit(aggregates, feedback_form_handler, api_gateway_event, lambda_context):
    def _submit(body, origin='null'):
        event = api_gateway_event(method='POST', path=f'/feedback-forms/{FORM}/submit', body=body,
                                  headers={'Origin': origin})
        with (
            patch.object(feedback_form_handler, 'aggregates_table', aggregates),
            patch.object(feedback_form_handler, 'PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue'),
            patch.object(feedback_form_handler, 'sqs') as sqs,
        ):
            response = feedback_form_handler.lambda_handler(event, lambda_context)
        headers = {k.lower(): v for k, v in (response.get('headers') or {}).items()}
        messages = [json.loads(call.kwargs['MessageBody']) for call in sqs.send_message.call_args_list]
        return response['statusCode'], json.loads(response['body']), messages, headers
    return _submit


def _pins(aggregates) -> list[dict]:
    return prototype_pins.list_pins(aggregates, FORM, workspace=None)


def _ask(aggregates, *, open_card: bool = True) -> None:
    proto.save_questions(aggregates, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=open_card,
                         actor_sub='editor-sub')


class TestPinsStayPins:
    def test_a_pin_is_stored_and_never_queued_whether_or_not_the_card_asks(self, submit, aggregates):
        for asks in (False, True):
            if asks:
                _ask(aggregates)
            status, body, messages, headers = submit(PIN)
            assert (status, messages, headers['access-control-allow-origin']) == (200, [], 'null'), body
        assert len(_pins(aggregates)) == 2


class TestValidationAnswers:
    def test_a_pin_form_that_asks_nothing_takes_no_answer(self, submit):
        status, body, messages, headers = submit({'answers': {'q_v_ces': 6}})
        assert (status, body['code'], messages) == (400, proto.CLOSED_CODE, [])
        assert headers['access-control-allow-origin'] == 'null', 'the widget can read the refusal'

    def test_a_closed_card_takes_none_either(self, submit, aggregates):
        _ask(aggregates, open_card=False)
        assert submit({'answers': {'q_v_ces': 6}})[1]['code'] == proto.CLOSED_CODE

    def test_an_answer_is_queued_as_customer_feedback_tagged_and_never_a_pin(self, submit, aggregates):
        _ask(aggregates)
        answers = {'q_vt_t00aa11': {'code': 'yes'}, 'q_v_ces': 6, 'q_vc_c00aa11': 4, 'q_v_missing': 'A receipt'}
        status, body, [message], headers = submit({'answers': answers, 'form_revision': 2, 'language': 'en'})
        assert status == 200, body
        assert headers['access-control-allow-origin'] == 'null'
        assert (message['source_platform'], message['source_channel'], message['tags']) == (
            'feedback_form', f'form_{FORM}', [proto.VALIDATION_TAG])
        assert message['metadata']['form_answers'] == answers
        assert message['metadata']['form_revision'] == 2
        assert message['rating'] == 4
        assert 'A receipt' in message['text']
        assert _pins(aggregates) == []
        assert proto.read_pin_form(aggregates, FORM)['has_responses'] is True, 'the answers lock now holds'

    def test_an_answer_is_checked_against_the_revision_it_answered(self, submit, aggregates):
        _ask(aggregates)
        status, body, messages, _ = submit({'answers': {'q_v_ces': 9}, 'form_revision': 2})
        assert (status, messages) == (400, [])
        assert 'answers.q_v_ces' in body['error']

    def test_an_empty_response_answers_the_card_and_queues_nothing(self, submit, aggregates):
        _ask(aggregates)
        status, body, messages, headers = submit({'answers': {}})
        assert (status, messages, headers['access-control-allow-origin']) == (200, [], 'null')
        assert body['card']['form_id'] == FORM
        assert len(body['card']['questions']) == 4
