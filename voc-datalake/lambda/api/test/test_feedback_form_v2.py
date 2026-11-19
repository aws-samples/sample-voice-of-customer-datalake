"""Feedback Forms schema version 2 through the form API (lambda/api/feedback_form_handler.py; docs/feedback-forms.md):
saves and revisions, the v1 write-back, the public config, the submit's validation and ingest (text, form_answers,
option category, hidden fields), test mode (tag stores a test response and queues nothing; drop stores nothing),
the test link, the results and responses (and their CSV), the beacon, the recorded delete of test responses and the
lock of an answered form. The AI draft's routes are the settings API's (test_settings_form_drafts.py).

Against moto tables (aggregates, feedback, workspaces), deployment-wide and in a workspace.
"""
from __future__ import annotations

import csv
import io
import json
import time
from collections.abc import Iterator
from contextlib import ExitStack
from typing import Any
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event
from test_feedback_form_workspace import wire_form_handler

import feedback_form_handler as h
from shared.ingest_schemas import validate_message
from shared.test.source_profile_fixtures import no_source_profiles, seeded_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
ADMIN = {'sub': 'sub-ad', 'cognito:groups': 'admins', 'cognito:username': 'ad'}
USER = {'sub': 'sub-us', 'cognito:groups': 'users', 'cognito:username': 'us'}
OTHER = {'sub': 'sub-ot', 'cognito:groups': 'users', 'cognito:username': 'ot'}
EDITOR = {'sub': 'sub-ed', 'cognito:groups': 'users', 'cognito:username': 'ed'}
VIEWER = {'sub': 'sub-vi', 'cognito:groups': 'users', 'cognito:username': 'vi'}
WS_ADMIN = {'sub': 'sub-wa', 'cognito:groups': 'users', 'cognito:username': 'wa'}
QUEUE = 'https://sqs.example.com/queue'

V2_FORM = {
    'name': 'Old UI', 'enabled': True, 'language': 'pl', 'languages': ['pl', 'en'],
    'welcome': {'enabled': False},
    'questions': [
        {'id': 'q_reason', 'type': 'single_select', 'headline': {'pl': 'Dlaczego wracasz?', 'en': 'Why?'},
         'required': True,
         'options': [{'code': 'missing', 'label': {'pl': 'Brakuje funkcji'},
                      'category': {'category': 'features', 'subcategory': 'missing'}},
                     {'code': 'slow', 'label': {'pl': 'Wolniej'}}],
         'other': {'enabled': True},
         'logic': [{'when': {'op': 'equals', 'value': 'missing'}, 'then': {'jump_to': 'q_which'}},
                   {'when': {'op': 'submitted'}, 'then': {'jump_to': 'q_rate'}}]},
        {'id': 'q_which', 'type': 'open_text', 'headline': {'pl': 'Której funkcji?'}, 'required': True},
        {'id': 'q_rate', 'type': 'rating', 'headline': {'pl': 'Ocena'}, 'required': False, 'range': 5},
        {'id': 'q_contact', 'type': 'contact_info', 'headline': {'pl': 'Kontakt'}, 'required': False,
         'fields': {'email': {'show': True, 'required': True}, 'name': {'show': True, 'required': False}}},
    ],
    'hidden_fields': [{'id': 'app_version', 'label': 'App version'}, {'id': 'screen'}],
    'endings': [{'id': 'end_thanks', 'title': {'pl': 'Dziękujemy', 'en': 'Thanks'}}],
}
V1_ITEM = {'pk': 'FEEDBACK_FORM', 'sk': 'FORM#deadbeef', 'form_id': 'deadbeef', 'name': 'Legacy', 'enabled': True,
           'title': 'Hi', 'question': 'How was it?', 'placeholder': 'Tell us', 'rating_enabled': True,
           'rating_type': 'stars', 'rating_max': 5, 'submit_button_text': 'Send', 'success_message': 'Ta!',
           'collect_email': True, 'collect_name': False, 'brand_name': 'Acme', 'created_at': '2026-01-01'}


@pytest.fixture
def world() -> Iterator[dict[str, Any]]:
    with mock_aws(), ExitStack() as stack:
        aggregates, feedback = pk_sk_table('aggregates'), pk_sk_table('feedback')
        workspaces = pk_sk_table('workspaces')
        workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'active', 'name': 'A', 'slug': 'a'})
        for member, role in ((EDITOR, 'editor'), (VIEWER, 'viewer'), (WS_ADMIN, 'admin')):
            workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': f"MEMBER#{member['sub']}", 'role': role})
        aggregates.put_item(Item=dict(V1_ITEM))
        yield wire_form_handler(stack, {'aggregates': aggregates, 'feedback': feedback, 'workspaces': workspaces},
                                QUEUE)


def _call(lambda_context: Any, method: str, path: str, *, claims: dict | None = None, ws: str | None = None,
          body: Any = None, query: dict | None = None, raw: bool = False) -> tuple[int, Any]:
    parts = path.strip('/').split('/')
    params = {'form_id': parts[1]} if len(parts) > 1 else None
    event = rest_event(method, path, claims=claims if claims is not None else ADMIN, body=body, path_params=params)
    event['queryStringParameters'] = query
    event['requestContext']['domainName'] = 'api.example'
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    response = h.lambda_handler(event, lambda_context)
    if raw:
        return response['statusCode'], response
    return response['statusCode'], json.loads(response['body'])


def _create(lambda_context: Any, body: dict | None = None, **kwargs: Any) -> dict:
    status, answer = _call(lambda_context, 'POST', '/feedback-forms', body=body or V2_FORM, **kwargs)
    assert status == 200, answer
    return answer['form']


def _rows(world: dict, prefix: str, pk: str = 'FEEDBACK_FORM') -> list[dict]:
    return world['aggregates'].query(KeyConditionExpression=Key('pk').eq(pk) & Key('sk').begins_with(prefix))['Items']


def _tests_of(world: dict, form_id: str, ws: str | None = None) -> list[dict]:
    """The form's tagged test responses: their scope's own partition (shared/form_test_responses.py), never the forms
    one (``ws``: a workspace's ``WS#{ws}#FEEDBACK_FORM_TEST``)."""
    return _rows(world, f'{form_id}#', pk=f'WS#{ws}#FEEDBACK_FORM_TEST' if ws else 'FEEDBACK_FORM_TEST')


def _event(lambda_context: Any, form_id: str, body: Any, **kwargs: Any) -> tuple[int, Any]:
    """A widget beacon on its own public route."""
    return _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/events', claims={}, body=body, **kwargs)


def _queued(world: dict) -> dict:
    return json.loads(world['sqs'].send_message.call_args.kwargs['MessageBody'])


def _submit(lambda_context: Any, form_id: str, body: dict, **kwargs: Any) -> tuple[int, Any]:
    return _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/submit', claims={}, body=body, **kwargs)


# ── Saves and revisions ─────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
class TestSavesAndRevisions:
    def test_a_v2_body_is_stored_as_revision_1_and_a_v1_body_is_migrated(self, world, lambda_context):
        form = _create(lambda_context)
        assert (form['schema_version'], form['revision'], form['questions'][0]['options'][0]['category']) == \
            (2, 1, {'category': 'features', 'subcategory': 'missing'})
        legacy = _create(lambda_context, {'name': 'V1', 'question': 'Rate us', 'rating_enabled': False,
                                          'language': 'de'})
        assert [q['type'] for q in legacy['questions']] == ['open_text']
        assert legacy['questions'][0]['headline'] == {'de': 'Rate us'}
        stored = world['aggregates'].get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f"FORM#{legacy['form_id']}"})['Item']
        assert not set(h.fv2.V1_FIELDS) & set(stored)

    def test_an_invalid_definition_is_refused_by_name(self, lambda_context):
        bad = {**V2_FORM, 'questions': [{**V2_FORM['questions'][0], 'logic': [
            {'when': {'op': 'lt', 'value': 3}, 'then': {'jump_to': 'q_rate'}}]}]}
        status, answer = _call(lambda_context, 'POST', '/feedback-forms', body=bad)
        assert status == 400
        assert 'op must be one of' in answer['error']

    def test_a_definition_change_is_a_new_revision_and_keeps_the_old_one(self, world, lambda_context):
        form = _create(lambda_context)
        questions = [*V2_FORM['questions'][:1], V2_FORM['questions'][1], V2_FORM['questions'][3]]
        questions[0] = {**questions[0], 'logic': [questions[0]['logic'][0]]}
        status, answer = _call(lambda_context, 'PUT', f"/feedback-forms/{form['form_id']}",
                               body={'questions': questions, 'expected_revision': 1})
        assert status == 200, answer
        assert answer['form']['revision'] == 2
        [snapshot] = _rows(world, f"FORMREV#{form['form_id']}#")
        assert (snapshot['revision'], [q['id'] for q in snapshot['questions']]) == \
            (1, ['q_reason', 'q_which', 'q_rate', 'q_contact'])
        status, answer = _call(lambda_context, 'PUT', f"/feedback-forms/{form['form_id']}", body={'name': 'Renamed'})
        assert (status, answer['form']['revision']) == (200, 2)
        assert len(_rows(world, f"FORMREV#{form['form_id']}#")) == 1

    def test_a_stale_save_is_a_409_with_its_code(self, lambda_context):
        form = _create(lambda_context)
        _call(lambda_context, 'PUT', f"/feedback-forms/{form['form_id']}", body={'welcome': {
            'enabled': True, 'title': {'pl': 'Witaj'}}})
        status, answer = _call(lambda_context, 'PUT', f"/feedback-forms/{form['form_id']}",
                               body={'name': 'x', 'expected_revision': 1})
        assert (status, answer['code'], answer['revision']) == (409, 'revision_conflict', 2)
        assert answer['updated_by'] == ADMIN['sub']
        assert answer['updated_at']

    def test_one_form_is_read_as_the_list_shows_it_and_says_while_it_is_still_version_1(self, lambda_context):
        status, answer = _call(lambda_context, 'GET', '/feedback-forms/deadbeef')
        assert status == 200, answer
        legacy = answer['form']
        assert (legacy['form_id'], legacy['schema_version'], legacy['migrated_from']) == ('deadbeef', 2, 1)
        assert (legacy.pop('response_count'), legacy.pop('can_delete_test_responses'), legacy['has_responses']) == (
            0, True, False)
        assert legacy == next(f for f in _call(lambda_context, 'GET', '/feedback-forms')[1]['forms']
                              if f['form_id'] == 'deadbeef')
        assert _call(lambda_context, 'PUT', '/feedback-forms/deadbeef', body={'enabled': True})[0] == 200
        assert 'migrated_from' not in _call(lambda_context, 'GET', '/feedback-forms/deadbeef')[1]['form']
        assert _call(lambda_context, 'GET', '/feedback-forms/nope0000')[0] == 404

    def test_the_first_real_response_marks_the_form_once_and_its_read_counts_the_stored_ones(self, world,
                                                                                             lambda_context):
        form = _create(lambda_context)
        fid, answer = form['form_id'], {'answers': {'q_reason': {'code': 'slow'}}}
        assert form['has_responses'] is False
        assert 'response_count' not in form
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})[1]['test']['token']
        assert _submit(lambda_context, fid, {**answer, 'test': token})[0] == 200
        assert _call(lambda_context, 'GET', f'/feedback-forms/{fid}')[1]['form']['has_responses'] is False
        assert _submit(lambda_context, fid, answer)[0] == 200
        assert _call(lambda_context, 'GET', f'/feedback-forms/{fid}')[1]['form']['has_responses'] is True
        with patch.object(world['aggregates'], 'update_item', wraps=world['aggregates'].update_item) as update:
            assert _submit(lambda_context, fid, answer)[0] == 200
        update.assert_not_called()  # marked once: never a write per submission
        world['feedback'].put_item(Item=_item(fid, 'f1', '2026-11-18T10:00:00', {'q_reason': {'code': 'slow'}},
                                              ['q_reason']))
        read = _call(lambda_context, 'GET', f'/feedback-forms/{fid}')[1]['form']
        assert (read['response_count'], read['has_responses'], read['revision']) == (1, True, 1)
        status, saved = _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'name': 'Renamed',
                                                                                     'expected_revision': 1})
        assert status == 200, saved
        assert saved['form']['has_responses'] is True
        assert 'has_responses' not in h.UPDATABLE_FIELDS

    def test_a_form_whose_count_cannot_be_read_is_still_read(self, lambda_context):
        with patch.object(h, '_stats_for_forms', side_effect=RuntimeError('throttled')):
            status, answer = _call(lambda_context, 'GET', '/feedback-forms/deadbeef')
        assert (status, answer['form']['form_id'], answer['stats_error']) == (200, 'deadbeef',
                                                                             "Failed to count the form's responses")
        assert 'response_count' not in answer['form']

    def test_a_response_to_a_form_deleted_meanwhile_leaves_no_stub_row(self, world):
        h._mark_answered('gone0000', {}, None)
        assert _rows(world, 'FORM#gone0000') == []

    def test_a_removed_question_id_is_never_reused(self, lambda_context):
        form = _create(lambda_context)
        url = f"/feedback-forms/{form['form_id']}"
        reason = {**V2_FORM['questions'][0], 'logic': []}
        assert _call(lambda_context, 'PUT', url, body={'questions': [reason, V2_FORM['questions'][2]]})[0] == 200
        status, answer = _call(lambda_context, 'PUT', url, body={'questions': [reason, V2_FORM['questions'][1]]})
        assert status == 400
        assert 'never reused' in answer['error']

    def test_a_v1_form_is_written_back_as_v2_on_its_next_save_losing_nothing(self, world, lambda_context):
        status, answer = _call(lambda_context, 'PUT', '/feedback-forms/deadbeef', body={'enabled': False})
        assert status == 200, answer
        stored = world['aggregates'].get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#deadbeef'})['Item']
        assert (stored['schema_version'], stored['revision'], stored['enabled']) == (2, 1, False)
        assert not set(h.fv2.V1_FIELDS) & set(stored)
        [snapshot] = _rows(world, 'FORMREV#deadbeef#')
        assert snapshot['v1']['submit_button_text'] == 'Send'
        assert snapshot['v1']['question'] == 'How was it?'

    def test_a_plain_save_of_a_v1_form_validates_its_migration_before_writing_it_back(self, world, lambda_context):
        """The list card's Enable writes a version 1 form back as version 2: never unchecked (a v1 question had no
        bound, a v2 headline has 500 characters)."""
        world['aggregates'].put_item(Item={**V1_ITEM, 'question': 'q' * 501})
        status, answer = _call(lambda_context, 'PUT', '/feedback-forms/deadbeef', body={'enabled': False})
        assert (status, answer['error']) == (400, 'questions[0].headline.en must be at most 500 characters')
        stored = world['aggregates'].get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#deadbeef'})['Item']
        assert ('schema_version' not in stored, stored['enabled']) == (True, True)

    def test_a_v1_patch_maps_onto_a_v2_form_where_it_can_and_is_refused_where_it_cannot(self, lambda_context):
        form = _create(lambda_context)
        url = f"/feedback-forms/{form['form_id']}"
        status, answer = _call(lambda_context, 'PUT', url, body={'title': 'Witamy', 'success_message': 'Dzięki!'})
        assert status == 200, answer
        assert answer['form']['welcome'] == {'enabled': True, 'title': {'pl': 'Witamy'}}
        assert answer['form']['endings'][0]['title'] == {'pl': 'Dzięki!', 'en': 'Thanks'}
        status, answer = _call(lambda_context, 'PUT', url, body={'question': 'x'})
        assert (status, 'version 1 field' in answer['error']) == (400, True)

    def test_a_token_is_never_saved_through_a_put(self, lambda_context):
        form = _create(lambda_context)
        status, answer = _call(lambda_context, 'PUT', f"/feedback-forms/{form['form_id']}",
                               body={'settings': {'test': {'token': 'mine'}}})
        assert (status, 'unknown fields: token' in answer['error']) == (400, True)

    def test_the_list_holds_forms_only_and_a_delete_removes_their_rows(self, world, lambda_context):
        form = _create(lambda_context)
        fid = form['form_id']
        _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})[1]['test']['token']
        assert _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'test': token})[0] == 200
        _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'welcome': {'enabled': True,
                                                                                'title': {'pl': 'Hej'}}})
        assert _event(lambda_context, fid, {'event': {'kind': 'opened', 'session': '0123456789abcdef'}})[0] == 200
        left = {'event': {'kind': 'left', 'question_id': 'q_reason', 'session': '0123456789abcdef'}}
        assert _event(lambda_context, fid, left)[0] == 200
        _status, listed = _call(lambda_context, 'GET', '/feedback-forms')
        assert sorted(f['form_id'] for f in listed['forms']) == sorted([fid, 'deadbeef'])
        assert all(_rows(world, f'{prefix}{fid}#') for prefix in ('FORMREV#', 'FORMFUNNEL#', 'FORMSESSION#'))
        assert _tests_of(world, fid)
        assert _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}')[0] == 200
        assert not any(_rows(world, f'{prefix}{fid}') for prefix in ('FORM#', 'FORMREV#', 'FORMFUNNEL#'))
        assert _tests_of(world, fid) == []
        # The visit rows are left to their 7-day ttl (plumbing, never data).
        assert [int(row['ttl']) > 0 for row in _rows(world, f'FORMSESSION#{fid}#')] == [True]


@pytest.mark.usefixtures('world')
class TestEveryFormDeleteIsRecorded:
    """Owner decision (2026-11-18): every delete of a form writes its audit row first (a workspace form's, in
    AUDIT#WS#{ws}, is pinned by test_feedback_form_workspace.py)."""

    @staticmethod
    def _records(world: dict) -> list[dict]:
        return world['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#delete'))['Items']

    def test_a_deployment_forms_delete_writes_one_audit_row_naming_the_form_and_who(self, world, lambda_context):
        fid = _create(lambda_context, claims=USER)['form_id']
        assert _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}', claims=USER)[0] == 200
        [row] = self._records(world)
        assert {key: row[key] for key in ('sk', 'kind', 'target', 'actor')} == {
            'sk': f'feedback_form#{fid}', 'kind': 'feedback_form', 'target': {'form_id': fid},
            'actor': {'sub': USER['sub'], 'kind': 'user'}}
        assert row['deleted_at']
        assert 'ttl' not in row
        assert _rows(world, f'FORM#{fid}') == []

    def test_a_delete_of_an_unknown_id_still_succeeds_and_records_nothing(self, world, lambda_context):
        assert _call(lambda_context, 'DELETE', '/feedback-forms/f_gone')[0] == 200
        assert self._records(world) == []

    def test_a_delete_whose_record_cannot_be_written_deletes_nothing(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        refused = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'x'}}, 'PutItem')
        with patch.object(h, 'record_delete_once', side_effect=refused):
            assert _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}')[0] == 500
        assert len(_rows(world, f'FORM#{fid}')) == 1

    def test_a_retried_delete_keeps_its_one_row(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        with patch.object(h, '_delete_form_rows', side_effect=RuntimeError('the first attempt stopped here')):
            assert _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}')[0] == 500
        assert _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}')[0] == 200
        assert [row['sk'] for row in self._records(world)] == [f'feedback_form#{fid}']


# ── The public config ───────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
class TestThePublicConfig:
    def test_it_serves_v2_without_names_routing_labels_or_tokens(self, lambda_context):
        form = _create(lambda_context)
        token = _call(lambda_context, 'POST', f"/feedback-forms/{form['form_id']}/test-link", body={})[1]['test']['token']
        status, response = _call(lambda_context, 'GET', f"/feedback-forms/{form['form_id']}/config", claims={},
                                 raw=True)
        assert status == 200
        config = json.loads(response['body'])['config']
        assert set(config) == {'enabled', 'schema_version', 'revision', 'language', 'languages', 'welcome',
                               'questions', 'hidden_fields', 'endings', 'language_assumed', 'theme'}
        for private in ('Old UI', 'features', 'App version', token, 'settings'):
            assert private not in response['body']

    def test_a_v1_form_is_served_migrated(self, lambda_context):
        status, answer = _call(lambda_context, 'GET', '/feedback-forms/deadbeef/config', claims={})
        assert status == 200
        assert [q['id'] for q in answer['config']['questions']] == ['q_rating', 'q_text', 'q_contact']
        assert answer['config']['language_assumed'] is True

    def test_the_test_links_state_is_answered_beside_the_config(self, lambda_context):
        form = _create(lambda_context)
        fid = form['form_id']
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={'record': 'drop'})[1]['test']['token']
        _, answer = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/config', claims={}, query={'test': token})
        assert answer['test'] == {'valid': True, 'record': 'drop'}
        _, answer = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/config', claims={}, query={'test': 'nope'})
        assert answer['test'] == {'valid': False}
        _, answer = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/config', claims={})
        assert 'test' not in answer

    def test_the_config_read_writes_nothing_even_when_asked_to_count_an_open(self, world, lambda_context):
        """A public GET only reads (7.55.00's AI review): the open is the widget's `opened` beacon on the submit, so a
        cached or retried config read counts nothing; the old `?open=1` is ignored, for a workspace's form too."""
        fid = _create(lambda_context)['form_id']
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})[1]['test']['token']
        in_ws = _create(lambda_context, claims=EDITOR, ws=WS)['form_id']
        before = (world['aggregates'].scan()['Items'], world['workspaces'].scan()['Items'])
        for form_id, query in ((fid, {'open': '1'}), (fid, {'open': '1', 'test': token}), (fid, None),
                               (in_ws, {'open': '1'})):
            assert _call(lambda_context, 'GET', f'/feedback-forms/{form_id}/config', claims={}, query=query)[0] == 200
        assert (world['aggregates'].scan()['Items'], world['workspaces'].scan()['Items']) == before

    def test_the_iframe_page_takes_the_forms_language_and_title_and_hands_on_the_link(self, lambda_context):
        form = _create(lambda_context, {**V2_FORM, 'welcome': {'enabled': True, 'title': {'pl': 'Powrót <b>'}}})
        status, response = _call(lambda_context, 'GET', f"/feedback-forms/{form['form_id']}/iframe", claims={},
                                 raw=True)
        assert status == 200
        page = response['body']
        assert '<html lang="pl">' in page
        assert '<title>Powrót &lt;b&gt;</title>' in page
        for line in ("VoCFeedbackForm.testToken = params.get('test');",
                     "VoCFeedbackForm.linkLanguage = params.get('lang');", "key.indexOf('hf_') === 0"):
            assert line in page


# ── The submit ──────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
class TestTheSubmit:
    def test_a_v2_response_becomes_the_item_the_processor_validates(self, world, lambda_context):
        form = _create(lambda_context)
        body = {'form_revision': 1, 'language': 'en', 'answers': {
            'q_reason': {'code': 'missing'}, 'q_which': 'Eksport', 'q_rate': 4,
            'q_contact': {'email': 'Ann@Example.com', 'name': 'Ann'}},
            'hidden': {'app_version': '5.0.3'}, 'ending_id': 'end_thanks', 'page_url': 'https://app.example'}
        status, answer = _submit(lambda_context, form['form_id'], body)
        assert status == 200, answer
        assert (answer['message'], answer['ending_id']) == ('Thanks', 'end_thanks')
        record = _queued(world)
        assert record['text'] == 'Której funkcji?\nEksport'
        assert (record['preset_category'], record['preset_subcategory'], record['rating']) == \
            ('features', 'missing', 4)
        assert record['language'] == 'en'
        meta = record['metadata']
        assert meta['form_answers']['q_reason'] == {'code': 'missing'}
        assert (meta['form_hidden'], meta['form_path'], meta['form_revision'], meta['form_version']) == \
            ({'app_version': '5.0.3'}, ['q_reason', 'q_which', 'q_rate', 'q_contact'], 1, '3.0')
        assert meta['submitter_email'] == 'ann@example.com'
        validated = validate_message(record)
        assert validated.metadata is not None
        assert validated.metadata.form_answers == meta['form_answers']

    @pytest.mark.parametrize(('session', 'status'), [
        ('0123456789abcdef01234567', 200), ('abc', 400), ('a b c d e f g h', 400), ('x' * 65, 400), (7, 400), (None, 200),
    ])
    def test_a_session_is_optional_and_only_the_beacons_format(self, lambda_context, session, status):
        form = _create(lambda_context)
        answer = _submit(lambda_context, form['form_id'], {'answers': {'q_reason': {'code': 'slow'}},
                                                            'session': session})
        assert answer[0] == status, answer

    @pytest.mark.parametrize('channel', ['link', 'iframe', 'script'])
    def test_where_it_was_answered_is_kept_with_the_response(self, world, lambda_context, channel):
        form = _create(lambda_context)
        answer = _submit(lambda_context, form['form_id'], {'answers': {'q_reason': {'code': 'slow'}}, 'channel': channel})
        assert answer[0] == 200, answer
        record = _queued(world)
        assert record['metadata']['form_channel'] == channel
        validated = validate_message(record)
        assert validated.metadata is not None
        assert validated.metadata.form_channel == channel

    @pytest.mark.parametrize(('channel', 'status'), [(None, 200), ('app', 400), ('LINK', 400), ('', 400), (5, 400)])
    def test_a_channel_is_optional_and_one_of_three(self, world, lambda_context, channel, status):
        form = _create(lambda_context)
        answer = _submit(lambda_context, form['form_id'], {'answers': {'q_reason': {'code': 'slow'}}, 'channel': channel})
        assert answer[0] == status, answer
        if status == 200:
            assert 'form_channel' not in _queued(world)['metadata']

    def test_without_a_mapped_option_the_forms_own_routing_applies(self, world, lambda_context):
        form = _create(lambda_context, {**V2_FORM, 'category': 'ux', 'subcategory': 'old_ui'})
        assert _submit(lambda_context, form['form_id'], {'answers': {'q_reason': {'code': 'slow'}}})[0] == 200
        assert (_queued(world)['preset_category'], _queued(world)['preset_subcategory']) == ('ux', 'old_ui')
        # No free text: the structured answers are the text.
        assert _queued(world)['text'] == 'Dlaczego wracasz?: Wolniej'

    @pytest.mark.parametrize(('body', 'code', 'question'), [
        ({'answers': {'q_reason': {'code': 'slow'}, 'q_which': 'x'}}, 'answer_skipped', 'q_which'),
        ({'answers': {'q_reason': {'code': 'missing'}}}, 'answer_required', 'q_which'),
        ({'answers': {'q_reason': {'code': 'gold'}}}, 'answer_invalid', 'q_reason'),
        ({'answers': {'q_reason': {'code': 'slow'}, 'q_rate': 9}}, 'answer_invalid', 'q_rate'),
        ({'answers': {'q_reason': {'code': 'slow'}}, 'hidden': {'plan': 'pro'}}, 'hidden_unknown', None),
        ({'answers': {'q_reason': {'code': 'slow'}}, 'hidden': {'screen': 'x' * 201}}, 'hidden_invalid', None),
        ({'answers': {'q_reason': {'code': 'slow'}}, 'is_test': True}, 'submission_invalid', None),
    ])
    def test_a_refusal_is_a_400_with_its_code_and_question(self, world, lambda_context, body, code, question):
        form = _create(lambda_context)
        status, answer = _submit(lambda_context, form['form_id'], body)
        assert (status, answer['code'], answer.get('question_id')) == (400, code, question)
        world['sqs'].send_message.assert_not_called()

    def test_a_late_response_is_checked_against_the_revision_it_answered(self, world, lambda_context):
        form = _create(lambda_context)
        fid = form['form_id']
        reason = {**V2_FORM['questions'][0], 'logic': []}
        _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'questions': [reason]})
        late = {'form_revision': 1, 'answers': {'q_reason': {'code': 'slow'}, 'q_rate': 3}}
        status, answer = _submit(lambda_context, fid, late)
        assert status == 200, answer
        assert _queued(world)['metadata']['form_revision'] == 1
        status, answer = _submit(lambda_context, fid, {**late, 'form_revision': 2})
        assert (status, answer['code'], answer['question_id']) == (400, 'answer_unknown', 'q_rate')
        status, answer = _submit(lambda_context, fid, {**late, 'form_revision': 9})
        assert (status, answer['code']) == (409, 'form_changed')

    def test_the_version_1_widgets_body_still_works_on_a_v2_form(self, world, lambda_context):
        status, _ = _submit(lambda_context, 'deadbeef', {'text': 'Fine', 'rating': 4, 'email': 'a@b.example'})
        assert status == 200
        record = _queued(world)
        assert (record['text'], record['rating'], record['metadata']['submitter_email']) == ('Fine', 4, 'a@b.example')

    def test_a_redacting_policy_keeps_no_contact_name(self, world, lambda_context):
        form = _create(lambda_context)
        with seeded_source_profiles([{'id': 'feedback_form', 'pii': 'redact'}]):
            status, answer = _submit(lambda_context, form['form_id'], {'answers': {
                'q_reason': {'code': 'slow'}, 'q_contact': {'email': 'a@b.example', 'name': 'Jan Kowalski'}}})
        assert status == 200, answer
        assert 'Jan Kowalski' not in json.dumps(_queued(world))

    def test_a_form_that_is_off_refuses_with_its_code(self, lambda_context):
        form = _create(lambda_context, {**V2_FORM, 'enabled': False})
        status, answer = _submit(lambda_context, form['form_id'], {'answers': {'q_reason': {'code': 'slow'}}})
        assert (status, answer['code']) == (400, 'form_off')


# ── Test mode ───────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
class TestTestMode:
    def _token(self, lambda_context: Any, form_id: str, **body: Any) -> str:
        status, answer = _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/test-link', body=body)
        assert status == 200, answer
        return answer['test']['token']

    def test_tag_stores_a_test_response_queues_nothing_and_works_while_off(self, world, lambda_context):
        form = _create(lambda_context, {**V2_FORM, 'enabled': False})
        token = self._token(lambda_context, form['form_id'])
        body = {'answers': {'q_reason': {'code': 'slow'}}, 'hidden': {'screen': 'invoices'}, 'test': token}
        status, answer = _submit(lambda_context, form['form_id'], body)
        assert (status, answer['test']) == (200, 'tag')
        world['sqs'].send_message.assert_not_called()
        [row] = _tests_of(world, form['form_id'])
        assert (row['is_test'], row['answers'], row['hidden']) == (True, {'q_reason': {'code': 'slow'}},
                                                                 {'screen': 'invoices'})

    def test_drop_checks_the_answers_and_stores_nothing(self, world, lambda_context):
        form = _create(lambda_context)
        token = self._token(lambda_context, form['form_id'], record='drop')
        status, answer = _submit(lambda_context, form['form_id'], {'answers': {'q_reason': {'code': 'slow'}},
                                                                   'test': token})
        assert (status, answer['test']) == (200, 'drop')
        assert _tests_of(world, form['form_id']) == []
        world['sqs'].send_message.assert_not_called()
        status, answer = _submit(lambda_context, form['form_id'], {'answers': {'q_reason': {'code': 'x'}},
                                                                   'test': token})
        assert (status, answer['code']) == (400, 'answer_invalid')

    def test_a_token_that_is_not_ascii_is_refused_never_a_500(self, lambda_context):
        """A public caller chooses the token: one with non-ASCII characters is a wrong token like any other."""
        fid = _create(lambda_context)['form_id']
        self._token(lambda_context, fid)
        status, answer = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/config', claims={}, query={'test': 'é'})
        assert (status, answer['test']) == (200, {'valid': False})
        status, answer = _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'test': 'é€'})
        assert (status, answer['code']) == (403, 'test_link_invalid')

    def test_a_wrong_or_turned_off_test_link_is_a_403(self, lambda_context):
        form = _create(lambda_context)
        fid = form['form_id']
        token = self._token(lambda_context, fid)
        body = {'answers': {'q_reason': {'code': 'slow'}}}
        assert _submit(lambda_context, fid, {**body, 'test': 'wrong'})[1]['code'] == 'test_link_invalid'
        self._token(lambda_context, fid, link_enabled=False)
        assert _submit(lambda_context, fid, {**body, 'test': token})[0] == 403

    def test_a_rotation_ends_the_old_link_and_the_token_never_leaves_the_admin_route(self, lambda_context):
        form = _create(lambda_context)
        fid = form['form_id']
        first = self._token(lambda_context, fid)
        assert self._token(lambda_context, fid) == first
        _status, answer = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={'rotate': True})
        assert answer['test_link'] == f"https://api.example/test/feedback-forms/{fid}/iframe?test={answer['test']['token']}"
        assert answer['test']['token'] != first
        assert _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'test': first})[0] == 403
        _, listed = _call(lambda_context, 'GET', '/feedback-forms')
        assert first not in json.dumps(listed)
        assert answer['test']['token'] not in json.dumps(listed)
        assert next(f for f in listed['forms'] if f['form_id'] == fid)['settings']['test']['token_issued'] is True

    def test_only_an_admin_issues_a_test_link(self, lambda_context):
        form = _create(lambda_context)
        status, _ = _call(lambda_context, 'POST', f"/feedback-forms/{form['form_id']}/test-link", body={}, claims=USER)
        assert status == 403
        ws_form = _create(lambda_context, claims=EDITOR, ws=WS)
        url = f"/feedback-forms/{ws_form['form_id']}/test-link"
        assert _call(lambda_context, 'POST', url, body={}, claims=EDITOR, ws=WS)[0] == 403
        assert _call(lambda_context, 'POST', url, body={}, claims=WS_ADMIN, ws=WS)[0] == 200

    def test_deleting_test_responses_needs_test_true_and_deletes_only_them(self, world, lambda_context):
        form = _create(lambda_context)
        fid = form['form_id']
        token = self._token(lambda_context, fid)
        _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'test': token})
        _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'welcome': {'enabled': True,
                                                                                'title': {'pl': 'Hej'}}})
        assert _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}/responses')[0] == 400
        status, answer = _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}/responses', query={'test': 'true'})
        assert (status, answer['deleted']) == (200, 1)
        assert _tests_of(world, fid) == []
        assert len(_rows(world, f'FORMREV#{fid}#')) == 1

    def _tested(self, lambda_context: Any, form_id: str, ws: str | None = None) -> None:
        """One tagged test response for the form, its token issued by an admin of where the form lives."""
        issuer = {'claims': WS_ADMIN, 'ws': ws} if ws else {}
        status, answer = _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/test-link', body={}, **issuer)
        assert status == 200, answer
        body = {'answers': {'q_reason': {'code': 'slow'}}, 'test': answer['test']['token']}
        assert _submit(lambda_context, form_id, body)[0] == 200

    @staticmethod
    def _delete(lambda_context: Any, form_id: str, who: dict, ws: str | None = None) -> tuple[int, Any]:
        return _call(lambda_context, 'DELETE', f'/feedback-forms/{form_id}/responses', query={'test': 'true'},
                     claims=who, ws=ws)

    def test_test_responses_are_kept_until_their_forms_creator_or_an_admin_deletes_them(self, world, lambda_context):
        """Owner decision (2026-11-18): an admin or the form's creator; anyone else is a 403 and deletes nothing."""
        mine, theirs = _create(lambda_context, claims=USER)['form_id'], _create(lambda_context, claims=OTHER)['form_id']
        for fid in (mine, theirs):
            self._tested(lambda_context, fid)
        status, answer = self._delete(lambda_context, theirs, USER)
        assert (status, answer['code']) == (403, 'test_responses_admin_or_creator')
        assert len(_tests_of(world, theirs)) == 1
        assert self._delete(lambda_context, mine, USER)[0] == 200   # its creator
        assert self._delete(lambda_context, theirs, ADMIN)[0] == 200   # an admin who did not create it
        assert _tests_of(world, mine) == _tests_of(world, theirs) == []

    def test_in_a_workspace_its_admins_and_the_forms_creator_delete_them(self, lambda_context):
        admins = _create(lambda_context, claims=WS_ADMIN, ws=WS)['form_id']
        own = _create(lambda_context, claims=EDITOR, ws=WS)['form_id']
        for fid in (admins, own):
            self._tested(lambda_context, fid, ws=WS)
        assert self._delete(lambda_context, admins, EDITOR, WS)[0] == 403   # an editor who did not create it
        assert self._delete(lambda_context, admins, VIEWER, WS)[0] == 403
        assert self._delete(lambda_context, own, EDITOR, WS)[0] == 200   # its creator
        assert self._delete(lambda_context, admins, WS_ADMIN, WS)[0] == 200

    def test_a_form_made_before_7_55_has_no_creator_so_only_admins_delete_them(self, lambda_context):
        assert self._delete(lambda_context, 'deadbeef', USER)[0] == 403
        assert self._delete(lambda_context, 'deadbeef', ADMIN)[0] == 200

    def test_the_builders_read_says_whether_the_caller_may_delete_them(self, lambda_context):
        fid = _create(lambda_context, claims=OTHER)['form_id']

        def may(who: dict, form_id: str = fid) -> bool:
            status, answer = _call(lambda_context, 'GET', f'/feedback-forms/{form_id}', claims=who)
            assert status == 200, answer
            return answer['form']['can_delete_test_responses']
        assert (may(OTHER), may(USER), may(ADMIN), may(USER, 'deadbeef')) == (True, False, True, False)
        ws_form = _create(lambda_context, claims=EDITOR, ws=WS)['form_id']
        read = {who['sub']: _call(lambda_context, 'GET', f'/feedback-forms/{ws_form}', claims=who, ws=WS)[1]['form']
                for who in (EDITOR, VIEWER, WS_ADMIN)}
        assert {sub: form['can_delete_test_responses'] for sub, form in read.items()} == {
            EDITOR['sub']: True, VIEWER['sub']: False, WS_ADMIN['sub']: True}


@pytest.mark.usefixtures('world')
class TestTheTestResponsesDeleteIsRecorded:
    """Every delete of a form's test responses writes its audit row first (TENETS.md D4), as a form's delete does: a
    deployment form's in voc-aggregates' AUDIT#delete (shared/delete_audit.py ``record_delete_first``), a workspace
    form's in voc-workspaces' AUDIT#WS#{ws} (shared/audit_rows.py ``put_new_audit_row``)."""

    @staticmethod
    def _records(world: dict) -> list[dict]:
        return world['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#delete'))['Items']

    @staticmethod
    def _ws_records(world: dict) -> list[dict]:
        return world['workspaces'].query(KeyConditionExpression=Key('pk').eq(f'AUDIT#WS#{WS}'))['Items']

    @staticmethod
    def _tested(lambda_context: Any, form_id: str, times: int = 1, ws: str | None = None) -> None:
        issuer = {'claims': WS_ADMIN, 'ws': ws} if ws else {}
        token = _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/test-link', body={},
                      **issuer)[1]['test']['token']
        for _ in range(times):
            assert _submit(lambda_context, form_id, {'answers': {'q_reason': {'code': 'slow'}}, 'test': token})[0] == 200

    @staticmethod
    def _delete(lambda_context: Any, form_id: str, **kwargs: Any) -> tuple[int, Any]:
        return _call(lambda_context, 'DELETE', f'/feedback-forms/{form_id}/responses', query={'test': 'true'},
                     **kwargs)

    def test_a_deployment_delete_records_who_which_form_how_many_and_when(self, world, lambda_context):
        fid = _create(lambda_context, claims=USER)['form_id']
        self._tested(lambda_context, fid, times=2)
        status, answer = self._delete(lambda_context, fid, claims=USER)
        assert (status, answer['deleted']) == (200, 2)
        [row] = self._records(world)
        assert {key: row[key] for key in ('kind', 'target', 'actor', 'count')} == {
            'kind': 'feedback_form_test_responses', 'target': {'form_id': fid},
            'actor': {'sub': USER['sub'], 'kind': 'user'}, 'count': 2}
        assert row['sk'].startswith(row['deleted_at'])
        assert 'ttl' not in row
        # Never their content: no answer, no address.
        assert 'slow' not in json.dumps(row, default=str)
        assert self._ws_records(world) == []

    def test_a_workspace_delete_is_recorded_in_the_workspaces_audit_partition(self, world, lambda_context):
        fid = _create(lambda_context, claims=EDITOR, ws=WS)['form_id']
        self._tested(lambda_context, fid, times=2, ws=WS)
        status, answer = self._delete(lambda_context, fid, claims=EDITOR, ws=WS)
        assert (status, answer['deleted']) == (200, 2)
        [row] = self._ws_records(world)
        assert {key: row[key] for key in ('kind', 'actor', 'form_id', 'count')} == {
            'kind': 'feedback_form_test_responses', 'actor': EDITOR['sub'], 'form_id': fid, 'count': 2}
        assert row['sk'].startswith(row['at'])
        assert 'slow' not in json.dumps(row, default=str)
        assert self._records(world) == []
        assert _tests_of(world, fid, WS) == []

    def test_each_delete_is_its_own_row_and_a_delete_of_nothing_records_nothing(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        assert self._delete(lambda_context, fid)[0] == 200
        assert self._records(world) == []
        for _ in range(2):
            self._tested(lambda_context, fid)
            assert self._delete(lambda_context, fid)[0] == 200
        assert [row['count'] for row in self._records(world)] == [1, 1]

    @pytest.mark.parametrize(('writer', 'ws'), [('record_delete_first', None), ('put_new_audit_row', WS)])
    def test_a_delete_whose_record_cannot_be_written_deletes_nothing(self, world, lambda_context, writer, ws):
        fid = _create(lambda_context, claims=EDITOR if ws else ADMIN, ws=ws)['form_id']
        self._tested(lambda_context, fid, ws=ws)
        refused = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'x'}}, 'PutItem')
        with patch.object(h, writer, side_effect=refused):
            status, answer = self._delete(lambda_context, fid, claims=EDITOR if ws else ADMIN, ws=ws)
        assert (status, answer['error']) == (500, 'Failed to delete test responses')
        assert len(_tests_of(world, fid, ws)) == 1

    def test_a_test_response_keeps_the_keys_a_persons_erasure_matches(self, world, lambda_context):
        """voc-retention's form_tests phase finds a person's test responses by these (docs/source-policies.md)."""
        fid = _create(lambda_context)['form_id']
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})[1]['test']['token']
        body = {'answers': {'q_reason': {'code': 'slow'}, 'q_contact': {'email': ' Ana@Example.COM ', 'name': 'Ana K'}},
                'test': token}
        assert _submit(lambda_context, fid, body)[0] == 200
        [row] = _tests_of(world, fid)
        assert (row['submitter_email'], row['submitter_name']) == ('ana@example.com', 'Ana K')
        assert _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'test': token})[0] == 200
        assert [('submitter_email' in r, 'submitter_name' in r) for r in _tests_of(world, fid)].count(
            (False, False)) == 1


@pytest.mark.usefixtures('world')
class TestTheLockOfAnAnsweredForm:
    """Once a form has a real response, a save names every question id and option code it drops, or is a 409
    (shared/forms_v2.py ``unnamed_removals``): the builder's lock, held by the server (TENETS.md tenet 4)."""

    @staticmethod
    def _answered(lambda_context: Any) -> str:
        fid = _create(lambda_context)['form_id']
        assert _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}})[0] == 200
        return fid

    @staticmethod
    def _put(lambda_context: Any, fid: str, **body: Any) -> tuple[int, Any]:
        return _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body=body)

    @staticmethod
    def _renamed() -> list[dict]:
        reason = V2_FORM['questions'][0]
        options = [reason['options'][0], {**reason['options'][1], 'code': 'too_slow'}]
        return [{**reason, 'options': options}, *V2_FORM['questions'][1:]]

    @staticmethod
    def _without_rating() -> list[dict]:
        reason = V2_FORM['questions'][0]
        return [{**reason, 'logic': [reason['logic'][0]]}, V2_FORM['questions'][1], V2_FORM['questions'][3]]

    def test_a_renamed_option_code_is_refused_and_nothing_is_written(self, world, lambda_context):
        fid = self._answered(lambda_context)
        status, answer = self._put(lambda_context, fid, questions=self._renamed())
        assert status == 409
        assert (answer['code'], answer['options'], 'questions' in answer) == ('answers_locked', {'q_reason': ['slow']},
                                                                            False)
        assert _rows(world, f'FORMREV#{fid}#') == []
        assert _call(lambda_context, 'GET', f'/feedback-forms/{fid}')[1]['form']['revision'] == 1

    def test_a_removed_question_is_refused_unless_the_save_names_it(self, world, lambda_context):
        fid = self._answered(lambda_context)
        status, answer = self._put(lambda_context, fid, questions=self._without_rating())
        assert (status, answer['code'], answer['questions']) == (409, 'answers_locked', ['q_rate'])
        status, answer = self._put(lambda_context, fid, questions=self._without_rating(),
                                   removes={'questions': ['q_rate']})
        assert (status, answer['form']['revision']) == (200, 2)
        assert len(_rows(world, f'FORMREV#{fid}#')) == 1
        # Named, it is retired for good: the id never comes back for another question.
        status, answer = self._put(lambda_context, fid, questions=list(V2_FORM['questions']))
        assert (status, answer['code'], answer['question_id']) == (400, 'question_id_reused', 'q_rate')

    def test_a_named_option_removal_goes_through(self, lambda_context):
        fid = self._answered(lambda_context)
        status, answer = self._put(lambda_context, fid, questions=self._renamed(), removes={'options': {'q_reason': ['slow']}})
        assert status == 200, answer
        assert [o['code'] for o in answer['form']['questions'][0]['options']] == ['missing', 'too_slow']

    def test_a_question_that_stops_being_a_choice_drops_its_codes(self, lambda_context):
        fid = self._answered(lambda_context)
        reason = V2_FORM['questions'][0]
        as_text = {key: reason[key] for key in ('id', 'headline', 'required')} | {'type': 'open_text'}
        status, answer = self._put(lambda_context, fid, questions=[as_text, *V2_FORM['questions'][1:]])
        assert (status, answer['options']) == (409, {'q_reason': ['missing', 'slow']})

    def test_a_form_without_a_response_changes_freely_and_any_other_save_needs_no_names(self, lambda_context):
        fid = _create(lambda_context)['form_id']
        assert self._put(lambda_context, fid, questions=self._renamed())[0] == 200
        answered = self._answered(lambda_context)
        assert self._put(lambda_context, answered, name='Renamed', enabled=False)[0] == 200
        reworded = [{**V2_FORM['questions'][0], 'headline': {'pl': 'Czemu?'}}, *V2_FORM['questions'][1:]]
        assert self._put(lambda_context, answered, questions=reworded)[0] == 200

    def test_a_workspaces_answered_form_is_locked_too(self, world, lambda_context):
        fid = _create(lambda_context, claims=EDITOR, ws=WS)['form_id']
        world['aggregates'].update_item(Key={'pk': f'WS#{WS}#FEEDBACK_FORM', 'sk': f'FORM#{fid}'},
                                        UpdateExpression='SET has_responses = :yes', ExpressionAttributeValues={
                                            ':yes': True})
        status, answer = _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', claims=EDITOR, ws=WS,
                               body={'questions': self._renamed()})
        assert (status, answer['code'], answer['options']) == (409, 'answers_locked', {'q_reason': ['slow']})

    @pytest.mark.parametrize('removes', [['q_rate'], {'questions': 'q_rate'}, {'questions': [1]},
                                         {'options': ['slow']}, {'options': {'q_reason': 'slow'}}, {'extra': []}])
    def test_a_malformed_removes_is_a_400(self, lambda_context, removes):
        fid = self._answered(lambda_context)
        status, answer = self._put(lambda_context, fid, questions=self._without_rating(), removes=removes)
        assert status == 400, answer


# ── Results and responses ───────────────────────────────────────────────────────────────────────────────────────

def _item(form_id: str, feedback_id: str, at: str, answers: dict, path: list[str], **metadata: Any) -> dict:
    return {'pk': 'SOURCE#Acme', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'source_platform': 'feedback_form', 'source_channel': f'form_{form_id}', 'category': 'features',
            'source_created_at': at, 'original_text': 'x', 'sentiment_label': 'NEGATIVE',
            'metadata': {'form_answers': answers, 'form_path': path, 'form_ending_id': 'end_thanks',
                         'form_revision': 1, 'form_language': 'pl', **metadata}}


@pytest.mark.usefixtures('world')
class TestResultsAndResponses:
    @pytest.fixture
    def seeded(self, world, lambda_context) -> str:
        form = _create(lambda_context)
        fid = form['form_id']
        for n, (answers, path, hidden) in enumerate((
            ({'q_reason': {'code': 'missing'}, 'q_which': '=SUM(A1)', 'q_rate': 5},
             ['q_reason', 'q_which', 'q_rate', 'q_contact'], {'app_version': '5.0'}),
            ({'q_reason': {'code': 'slow'}, 'q_rate': 2}, ['q_reason', 'q_rate', 'q_contact'], {}),
            ({'q_reason': {'other': 'Prices'}}, ['q_reason', 'q_rate', 'q_contact'], {'app_version': '5.1'}),
        )):
            world['feedback'].put_item(Item=_item(fid, f'f{n}', f'2026-11-0{n + 1}T10:00:00', answers, path,
                                                  form_hidden=hidden))
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})[1]['test']['token']
        _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'test': token})
        return fid

    def test_results_count_real_responses_and_test_ones_only_when_asked(self, seeded, lambda_context):
        status, results = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/results')
        assert status == 200, results
        assert (results['responses'], results['test_responses'], results['include_test']) == (3, 0, False)
        reason = results['questions'][0]
        assert (reason['options'], reason['other']) == ({'missing': 1, 'slow': 1}, 1)
        which = results['questions'][1]
        assert (which['count'], which['shown'], which['not_shown']) == (1, 1, 2)
        assert which['latest'][0]['response_id'] == 'f0'
        assert results['questions'][2]['average'] == 3.5
        assert results['hidden'] == {'app_version': 2, 'screen': 0}
        _, with_test = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/results', query={'include_test': 'true'})
        assert (with_test['responses'], with_test['test_responses']) == (4, 1)

    def test_results_filter_by_hidden_value_and_date(self, seeded, lambda_context):
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/results',
                           query={'hidden.app_version': '5.1'})
        assert results['responses'] == 1
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/results', query={'to': '2026-11-01'})
        assert results['responses'] == 1

    def test_responses_page_newest_first_and_the_test_list_is_separate(self, seeded, lambda_context):
        _, page = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/responses', query={'limit': '2'})
        assert ([r['response_id'] for r in page['responses']], page['next_cursor'], page['total']) == \
            (['f2', 'f1'], '2', 3)
        _, rest = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/responses', query={'cursor': '2'})
        assert ([r['response_id'] for r in rest['responses']], rest['next_cursor']) == (['f0'], None)
        _, tests = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/responses', query={'include_test': 'only'})
        assert [r['is_test'] for r in tests['responses']] == [True]
        assert 'feedback_id' not in tests['responses'][0]

    def test_a_headline_that_reads_as_a_formula_is_quoted_off_in_the_csv_header(self, lambda_context):
        questions = [{**V2_FORM['questions'][1], 'headline': {'pl': '=HYPERLINK("https://x.example")'}}]
        fid = _create(lambda_context, {**V2_FORM, 'questions': questions})['form_id']
        _status, response = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/responses', query={'format': 'csv'},
                                  raw=True)
        [labels, ids] = list(csv.reader(io.StringIO(response['body'])))[:2]
        assert (labels[6], ids[6]) == ('\'=HYPERLINK("https://x.example")', 'q_which')

    def test_the_csv_has_both_header_rows_and_no_formula(self, seeded, lambda_context):
        status, response = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/responses',
                                 query={'format': 'csv'}, raw=True)
        assert status == 200
        assert response['multiValueHeaders']['Content-Type'] == ['text/csv; charset=utf-8']
        rows = list(csv.reader(io.StringIO(response['body'])))
        assert rows[0][6:] == ['Dlaczego wracasz?', 'Której funkcji?', 'Ocena', 'Kontakt', 'hidden: app_version',
                               'hidden: screen']
        assert rows[1][6:8] == ['q_reason', 'q_which']
        oldest = rows[-1]
        assert (oldest[6], oldest[7]) == ('Brakuje funkcji', "'=SUM(A1)")

    def test_a_workspace_viewer_may_not_read_results(self, lambda_context):
        form = _create(lambda_context, claims=EDITOR, ws=WS)
        url = f"/feedback-forms/{form['form_id']}/results"
        assert _call(lambda_context, 'GET', url, claims=VIEWER, ws=WS)[0] == 403
        assert _call(lambda_context, 'GET', url, claims=EDITOR, ws=WS)[0] == 200


# ── The beacons ─────────────────────────────────────────────────────────────────────────────────────────────────

SESSION = '0123456789abcdef01234567'
OTHER_SESSION = 'fedcba9876543210fedcba98'


@pytest.mark.usefixtures('world')
class TestTheBeacons:
    """Their own public route (POST …/events, its own throttle); the durable record is one counter row per form per
    day; a visit's dedupe row lives 7 days (TENETS.md D2)."""

    @staticmethod
    def _left(lambda_context: Any, form_id: str, question_id: str, session: str = SESSION, **body: Any) -> Any:
        event = {'event': {'kind': 'left', 'question_id': question_id, 'session': session, 'revision': 1}, **body}
        status, answer = _event(lambda_context, form_id, event)
        assert status == 200, answer
        return answer

    @staticmethod
    def _day(world: dict, form_id: str, suffix: str = '', pk: str = 'FEEDBACK_FORM') -> dict:
        [row] = [r for r in _rows(world, f'FORMFUNNEL#{form_id}#', pk=pk) if r['sk'].endswith(suffix) and
                 (suffix or not r['sk'].endswith('#test'))]
        return row

    def test_a_left_counts_on_the_days_row_and_keeps_its_visit_for_7_days(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        before = int(time.time())
        self._left(lambda_context, fid, 'q_which')
        self._left(lambda_context, fid, 'q_gone', OTHER_SESSION)  # not a question of the form: no count, no row
        day = self._day(world, fid)
        assert (day['left:q_which'], day['is_test']) == (1, False)
        # The durable record: counters only, no ttl (D2), never a session, an answer or an address.
        assert set(day) == {'pk', 'sk', 'form_id', 'day', 'is_test', 'left:q_which'}
        [visit] = _rows(world, f'FORMSESSION#{fid}#')
        assert (visit['question_id'], visit['position']) == ('q_which', 1)
        assert h.SESSION_ROW_TTL_SECONDS <= int(visit['ttl']) - before <= h.SESSION_ROW_TTL_SECONDS + 60
        world['sqs'].send_message.assert_not_called()
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results')
        assert results['funnel'] == {'opened': 0, 'left': {'q_which': 1}, 'completed': 0}

    def test_a_visit_that_goes_further_moves_its_count_and_never_back(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        for question in ('q_which', 'q_contact', 'q_reason'):  # pagehide, then hidden again further on, then back
            self._left(lambda_context, fid, question)
        self._left(lambda_context, fid, 'q_reason', OTHER_SESSION)
        day = self._day(world, fid)
        assert (day['left:q_which'], day['left:q_contact'], day['left:q_reason']) == (0, 1, 1)
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results')
        assert results['funnel']['left'] == {'q_contact': 1, 'q_reason': 1}

    def test_a_visit_that_then_submits_counts_once_as_a_response(self, world, lambda_context):
        """A respondent who switched tabs (a `left` on visibilitychange) and then answered; a `left` sent after the
        response is not counted either."""
        fid = _create(lambda_context)['form_id']
        self._left(lambda_context, fid, 'q_reason')
        status, answer = _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'session': SESSION})
        assert status == 200, answer
        assert _queued(world)['metadata']['form_session'] == SESSION
        self._left(lambda_context, fid, 'q_contact')
        day = self._day(world, fid)
        assert day['left:q_reason'] == 0
        assert 'left:q_contact' not in day
        [visit] = _rows(world, f'FORMSESSION#{fid}#')
        assert visit['submitted'] is True
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results')
        assert results['funnel']['left'] == {}

    def test_a_response_without_a_left_closes_its_visit_too(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        assert _submit(lambda_context, fid, {'answers': {'q_reason': {'code': 'slow'}}, 'session': SESSION})[0] == 200
        self._left(lambda_context, fid, 'q_which')
        assert _rows(world, f'FORMFUNNEL#{fid}#') == []

    def test_a_workspaces_form_counts_in_its_own_partition(self, world, lambda_context):
        """Found by its lookup row, as on submit; every row the beacons write is the workspace's."""
        fid = _create(lambda_context, claims=EDITOR, ws=WS)['form_id']
        _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', claims=EDITOR, ws=WS, body={'enabled': True})
        assert _event(lambda_context, fid, {'event': {'kind': 'opened', 'session': SESSION}}) == (200, {'success': True})
        self._left(lambda_context, fid, 'q_which')
        partition = f'WS#{WS}#FEEDBACK_FORM'
        day = self._day(world, fid, pk=partition)
        assert (day['opened'], day['left:q_which'], 'ttl' in day) == (1, 1, False)
        assert len(_rows(world, f'FORMSESSION#{fid}#', pk=partition)) == 1
        assert _rows(world, f'FORMFUNNEL#{fid}#') == _rows(world, f'FORMSESSION#{fid}#') == []
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results', claims=EDITOR, ws=WS)
        assert results['funnel'] == {'opened': 1, 'left': {'q_which': 1}, 'completed': 0}

    def test_a_test_visit_counts_apart_and_goes_with_the_test_responses_delete(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})[1]['test']['token']
        assert self._left(lambda_context, fid, 'q_reason', test=token) == {'success': True, 'test': 'tag'}
        assert self._day(world, fid, '#test')['left:q_reason'] == 1
        _, real = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results')
        _, tested = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results', query={'include_test': 'true'})
        assert (real['funnel']['left'], tested['funnel']['left']) == ({}, {'q_reason': 1})
        # A tagged test response of the same visit takes its left back, on the test row.
        body = {'answers': {'q_reason': {'code': 'slow'}}, 'session': SESSION, 'test': token}
        assert _submit(lambda_context, fid, body)[0] == 200
        assert self._day(world, fid, '#test')['left:q_reason'] == 0
        _call(lambda_context, 'DELETE', f'/feedback-forms/{fid}/responses', query={'test': 'true'})
        assert _rows(world, f'FORMFUNNEL#{fid}#') == []

    def test_an_opened_counts_one_open_of_a_form_that_is_on_or_through_a_valid_test_link(self, world, lambda_context):
        off = _create(lambda_context, {**V2_FORM, 'enabled': False})['form_id']
        opened = {'event': {'kind': 'opened', 'session': SESSION, 'revision': 1}}
        status, answer = _event(lambda_context, off, opened)
        assert (status, answer['code']) == (400, 'form_off')
        assert _event(lambda_context, off, {**opened, 'test': 'wrong'})[1]['code'] == 'test_link_invalid'
        assert _rows(world, f'FORMFUNNEL#{off}#') == []
        token = _call(lambda_context, 'POST', f'/feedback-forms/{off}/test-link', body={})[1]['test']['token']
        assert _event(lambda_context, off, {**opened, 'test': token}) == (200, {'success': True, 'test': 'tag'})
        row = self._day(world, off, '#test')
        assert (row['opened'], row['is_test']) == (1, True)
        assert set(row) == {'pk', 'sk', 'form_id', 'day', 'is_test', 'opened'}
        on = _create(lambda_context)['form_id']
        for _ in range(2):
            assert _event(lambda_context, on, opened) == (200, {'success': True})
        assert self._day(world, on)['opened'] == 2
        world['sqs'].send_message.assert_not_called()
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{on}/results')
        assert results['funnel'] == {'opened': 2, 'left': {}, 'completed': 0}

    def test_the_results_read_the_days_of_the_view_only(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        for day, opened in (('2026-11-01', 3), ('2026-11-05', 4)):
            world['aggregates'].put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': f'FORMFUNNEL#{fid}#{day}', 'form_id': fid,
                                               'day': day, 'is_test': False, 'opened': opened, 'left:q_which': 1})
        _, results = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results',
                           query={'from': '2026-11-04', 'to': '2026-11-30'})
        assert results['funnel'] == {'opened': 4, 'left': {'q_which': 1}, 'completed': 0}

    def test_a_drop_test_links_beacons_count_nothing(self, world, lambda_context):
        fid = _create(lambda_context)['form_id']
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={'record': 'drop'})[1]['test']
        for event in ({'kind': 'opened', 'session': SESSION},
                      {'kind': 'left', 'question_id': 'q_which', 'session': SESSION}):
            assert _event(lambda_context, fid, {'event': event, 'test': token['token']}) == (
                200, {'success': True, 'test': 'drop'})
        assert _rows(world, f'FORMFUNNEL#{fid}#') == _rows(world, f'FORMSESSION#{fid}#') == []

    def test_a_count_that_cannot_be_written_never_fails_the_widget(self, lambda_context):
        fid = _create(lambda_context)['form_id']
        refused = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}}, 'UpdateItem')
        with patch.object(h.aggregates_table, 'update_item', side_effect=refused):
            assert _event(lambda_context, fid, {'event': {'kind': 'opened', 'session': SESSION}})[0] == 200
            assert _event(lambda_context, fid, {'event': {'kind': 'left', 'question_id': 'q_which',
                                                          'session': SESSION}})[0] == 200

    def test_the_submit_takes_no_beacon(self, world, lambda_context):
        """The submit route's limit is for responses only (7.55.00's AI review, round 2)."""
        fid = _create(lambda_context)['form_id']
        status, answer = _submit(lambda_context, fid, {'event': {'kind': 'opened', 'session': SESSION}})
        assert (status, answer['code']) == (400, 'submission_invalid')
        assert _rows(world, f'FORMFUNNEL#{fid}#') == []

    @pytest.mark.parametrize('body', [
        {}, [], 'x', {'event': {'kind': 'open'}}, {'event': {'kind': 'left'}}, {'event': {'kind': 'opened'}},
        {'event': {'kind': 'opened', 'session': SESSION, 'question_id': 'q_a'}},
        {'event': {'kind': 'opened', 'session': SESSION, 'revision': 0}},
        {'event': {'kind': 'opened', 'session': SESSION, 'revision': True}},
        {'event': 'opened'}, {'event': {'kind': 'left', 'question_id': 'q_a'}},
        {'event': {'kind': 'left', 'question_id': 'q_a', 'session': SESSION}, 'answers': {}},
        {'event': {'kind': 'left', 'question_id': 'q_a', 'session': 'x'}},
        {'event': {'kind': 'left', 'question_id': 'q_a', 'session': 'not a session!'}},
    ])
    def test_a_malformed_event_is_refused_before_any_read(self, lambda_context, body):
        with patch.object(h, '_public_form', side_effect=AssertionError('read')):
            status, answer = _event(lambda_context, 'deadbeef', body)
        assert (status, answer['code']) == (400, 'submission_invalid')


# ── The AI draft is not this Lambda's ───────────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
@pytest.mark.parametrize(('method', 'path'), [('POST', '/feedback-forms/draft'),
                                              ('GET', '/feedback-forms/draft/job_0123456789abcdef')])
@pytest.mark.parametrize('ws', [None, WS])
def test_the_forms_lambda_serves_no_ai_draft(lambda_context, method, path, ws):
    """The settings API serves the draft (shared/forms_v2_draft_routes.py, POST /settings/form-drafts and its poll):
    this Lambda also serves the public widget routes, so its role holds no worker invoke and no jobs-table action
    (TENETS.md tenet 6), and its 7.55.00 draft paths answer 404."""
    assert _call(lambda_context, method, path, body={'description': 'x', 'language': 'en', 'channel': 'link'},
                 claims=EDITOR if ws else USER, ws=ws)[0] == 404


def test_the_gateway_bounds_are_the_schemas():
    assert (h.MAX_FORM_ANSWERS, h.MAX_HIDDEN_FIELDS, h.MAX_TEST_TOKEN_CHARS) == (
        h.fv2.MAX_QUESTIONS, h.fv2.MAX_HIDDEN_FIELDS, h.fresp.MAX_TEST_TOKEN_CHARS)
