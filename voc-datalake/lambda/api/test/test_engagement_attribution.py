"""Feedback-form answers attributed to the participant ask they came from.

The submit route (api/feedback_form_handler.py) reads ``participant_token`` through
shared/feedback_form_participants.py; the iframe page hands the link's ``?r=`` to the
widget, which posts it. An unknown token, or no participants table, is ignored.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from engagement_fixtures import engagement_world, event

from shared import feedback_form_participants
from shared.ingest_schemas import validate_message
from shared.participants_asks import create_ask, get_ask, mint_response_token, recipient_key
from shared.participants_store import create_person

FORM = {'form_id': 'form-1', 'name': 'Survey', 'enabled': True, 'brand_name': 'Example Air'}


@pytest.fixture
def world(monkeypatch):
    with engagement_world() as w:
        feedback_form_participants._table.cache_clear()
        monkeypatch.setattr(feedback_form_participants, '_participants_table', lambda: w.participants)
        yield w
    feedback_form_participants._table.cache_clear()


def _recipient(world, project_id=None):
    person = create_person(world.participants, email='pat@example.com', email_lc='pat@example.com', fields={},
                           origin='manual', created_by='admin-sub')
    fields = {'subject': 's', 'message': 'm', 'link': {'kind': 'form', 'form_id': 'form-1', 'url': 'u'}}
    if project_id:
        fields['project_id'] = project_id
    ask = create_ask(world.participants, fields, [person['person_id']], 'admin-sub')
    token = mint_response_token(world.participants, ask, person['person_id'])
    return person['person_id'], ask['ask_id'], token


def _submit(lambda_context, body):
    import feedback_form_handler
    aggregates = MagicMock()
    aggregates.get_item.return_value = {'Item': dict(FORM)}
    sqs = MagicMock()
    with patch.object(feedback_form_handler, 'aggregates_table', aggregates), \
            patch.object(feedback_form_handler, 'sqs', sqs), \
            patch.object(feedback_form_handler, 'PROCESSING_QUEUE_URL', 'https://sqs.example.com/q'), \
            patch.object(feedback_form_handler, 'cached_source_profile_strict', return_value={}):
        response = feedback_form_handler.lambda_handler(
            event('POST', '/feedback-forms/form-1/submit', claims=None, body=body), lambda_context)
    assert sqs.send_message.called, f'nothing was queued: {response}'
    queued: dict = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
    return response['statusCode'], queued


def test_a_known_token_attributes_the_answer_and_counts_it_once(world, lambda_context):
    person_id, ask_id, token = _recipient(world, project_id='proj-public')
    status, queued = _submit(lambda_context, {'text': 'Works well', 'participant_token': token})
    assert status == 200
    assert queued['metadata']['participant'] == {'person_id': person_id, 'ask_id': ask_id, 'project_id': 'proj-public'}
    # The processor's own schema accepts the nested reference.
    metadata = validate_message(queued).metadata
    assert metadata is not None
    assert metadata.participant is not None
    assert metadata.participant.ask_id == ask_id
    row = world.participants.get_item(Key=recipient_key(ask_id, person_id))['Item']
    assert row['status'] == 'responded'
    assert row['responded_at']
    _submit(lambda_context, {'text': 'Again', 'participant_token': token})
    ask = get_ask(world.participants, ask_id)
    assert ask is not None
    assert int(ask['counts']['responded']) == 1


@pytest.mark.parametrize('token', ['x' * 32, 5, '', None, 'short'])
def test_unknown_tokens_are_ignored(world, lambda_context, token):
    _recipient(world)
    status, queued = _submit(lambda_context, {'text': 'Fine', 'participant_token': token})
    assert status == 200
    assert 'participant' not in queued['metadata']


def test_the_feature_is_off_without_the_table(monkeypatch):
    monkeypatch.delenv('PARTICIPANTS_TABLE', raising=False)
    feedback_form_participants._table.cache_clear()
    assert feedback_form_participants.resolve_participant({'participant_token': 'y' * 32}) is None
    feedback_form_participants.record_response({'ask_id': 'a', 'person_id': 'p'})


def test_a_failed_read_or_write_never_blocks_the_answer(world, lambda_context, monkeypatch):
    _, _, token = _recipient(world)
    boom = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'x'}}, 'GetItem')
    monkeypatch.setattr(feedback_form_participants, 'resolve_token', MagicMock(side_effect=boom))
    status, queued = _submit(lambda_context, {'text': 'Fine', 'participant_token': token})
    assert status == 200
    assert 'participant' not in queued['metadata']
    monkeypatch.setattr(feedback_form_participants, 'mark_responded', MagicMock(side_effect=boom))
    feedback_form_participants.record_response({'ask_id': 'ask_1', 'person_id': 'per_1'})


def test_the_iframe_page_hands_the_link_token_to_the_widget(lambda_context):
    import feedback_form_handler
    aggregates = MagicMock()
    aggregates.get_item.return_value = {'Item': dict(FORM)}
    with patch.object(feedback_form_handler, 'aggregates_table', aggregates):
        response = feedback_form_handler.lambda_handler(
            event('GET', '/feedback-forms/form-1/iframe', claims=None, query={'r': 'QueryTokenQ7'}), lambda_context)
    html = response['body']
    assert "new URLSearchParams(window.location.search).get('r')" in html
    assert 'history.replaceState(null' in html
    # The token itself is never rendered into the page by the server.
    assert 'QueryTokenQ7' not in html
    widget = feedback_form_handler.get_widget_js()
    assert 'payload.participant_token = this.participantToken' in widget
    assert 'participantToken(window.VoCFeedbackForm.participantToken)' in widget
