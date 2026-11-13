"""Feedback forms on both paths (docs/multi-workspace.md, "Public and non-user entry points"; docs/feedback-forms.md).

Signed-in routes with ``X-Workspace-Id`` act in that workspace: its editors and admins create, update and delete its
forms (a viewer 403, a non-member the one 404), stored under ``WS#{ws}#FEEDBACK_FORM`` with a lookup row
``FORM#{id}`` in voc-workspaces. The public routes look the id up and never read the request for the workspace: a
workspace's form serves its own config and queues its submissions with that workspace (raw copy under
``ws/{ws}/raw/``); a form without a row is the deployment's, exactly as before; a row naming a malformed, unknown or
``deleting`` workspace, an orphaned row and an unknown id all get the same 404.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import ExitStack
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event

import feedback_form_handler as h
from shared import workspace_plugin_settings
from shared.test.raw_lake_fixtures import RAW_BUCKET, raw_keys, raw_lake_client
from shared.test.source_profile_fixtures import no_source_profiles, seeded_source_profiles
from shared.workspace_request import RequestWorkspace
from shared.ws_repo import WorkspaceScope

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
WS_GONE = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
EDITOR = {'sub': 'sub-ed', 'cognito:groups': 'users', 'cognito:username': 'ed'}
VIEWER = {'sub': 'sub-vi', 'cognito:groups': 'users', 'cognito:username': 'vi'}
MEMBER_B = {'sub': 'sub-bo', 'cognito:groups': 'users', 'cognito:username': 'bo'}
ADMIN = {'sub': 'sub-ad', 'cognito:groups': 'admins', 'cognito:username': 'ad'}
FORM_A = 'ff_' + 'a' * 32
FORM_B = 'ff_' + 'b' * 32
FORM_GONE = 'ff_' + 'c' * 32
LEGACY = 'deadbeef'
QUEUE = 'https://sqs.example.com/queue'
NOT_FOUND = {'success': False, 'error': 'Form not found'}


def _form(pk: str, form_id: str, title: str) -> dict:
    return {'pk': pk, 'sk': f'FORM#{form_id}', 'form_id': form_id, 'name': title, 'title': title, 'enabled': True,
            'brand_name': 'Acme', 'created_at': '2026-11-01T00:00:00+00:00', 'updated_at': '2026-11-01T00:00:00+00:00'}


@pytest.fixture
def world() -> Iterator[dict[str, Any]]:
    with mock_aws(), ExitStack() as stack:
        aggregates, feedback, workspaces = pk_sk_table('aggregates'), pk_sk_table('feedback'), pk_sk_table('workspaces')
        for ws, status in ((WS_A, 'active'), (WS_B, 'active'), (WS_GONE, 'deleting')):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': status, 'name': ws, 'slug': ws[-6:]})
        for ws, member, role in ((WS_A, EDITOR, 'editor'), (WS_A, VIEWER, 'viewer'), (WS_B, MEMBER_B, 'admin'),
                                 (WS_GONE, EDITOR, 'admin')):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{member['sub']}", 'role': role})
        for ws, form_id in ((WS_A, FORM_A), (WS_B, FORM_B), (WS_GONE, FORM_GONE)):
            aggregates.put_item(Item=_form(f'WS#{ws}#FEEDBACK_FORM', form_id, f'Form of {ws[-2:]}'))
            workspaces.put_item(Item={'pk': f'FORM#{form_id}', 'sk': 'META', 'workspace_id': ws, 'created_at': 'x'})
        aggregates.put_item(Item=_form('FEEDBACK_FORM', LEGACY, 'Deployment form'))
        sqs = MagicMock()
        resolver = RequestWorkspace(table=lambda: workspaces, confirm_platform_admin=lambda _event: False)
        for target, value in (('aggregates_table', aggregates), ('feedback_table', feedback), ('sqs', sqs),
                              ('_workspace', resolver), ('PROCESSING_QUEUE_URL', QUEUE), ('BRAND_NAME', 'Acme')):
            stack.enter_context(patch.object(h, target, value))
        stack.enter_context(patch.object(h, 'get_workspaces_table', return_value=workspaces))
        yield {'aggregates': aggregates, 'feedback': feedback, 'workspaces': workspaces, 'sqs': sqs}


def _call(lambda_context: Any, method: str, path: str, *, claims: dict | None = None, ws: str | None = None,
          body: Any = None, form_id: str | None = None) -> tuple[int, Any]:
    event = rest_event(method, path, claims=claims or {}, body=body,
                       path_params={'form_id': form_id} if form_id else None)
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    response = h.lambda_handler(event, lambda_context)
    text = response['body']
    try:
        return response['statusCode'], json.loads(text)
    except json.JSONDecodeError:
        return response['statusCode'], text


def _stored(world: dict, pk: str, form_id: str) -> dict | None:
    return world['aggregates'].get_item(Key={'pk': pk, 'sk': f'FORM#{form_id}'}).get('Item')


def _lookup(world: dict, form_id: str) -> dict | None:
    return world['workspaces'].get_item(Key={'pk': f'FORM#{form_id}', 'sk': 'META'}).get('Item')


def _present(row: dict | None) -> dict:
    assert row is not None
    return row


def _queued(world: dict) -> dict:
    return json.loads(world['sqs'].send_message.call_args.kwargs['MessageBody'])


@pytest.mark.usefixtures('world', 'ingestion_on')
class TestSignedInRoutesInAWorkspace:
    def test_an_editor_creates_a_form_of_the_workspace_with_its_lookup_row(self, world, lambda_context):
        status, body = _call(lambda_context, 'POST', '/feedback-forms', claims=EDITOR, ws=WS_A, body={'name': 'N'})

        assert status == 200, body
        form_id = body['form']['form_id']
        assert form_id.startswith('ff_')
        assert len(form_id) == 35
        assert _present(_stored(world, f'WS#{WS_A}#FEEDBACK_FORM', form_id))['name'] == 'N'
        assert _stored(world, 'FEEDBACK_FORM', form_id) is None  # not a deployment form
        assert _lookup(world, form_id) == {'pk': f'FORM#{form_id}', 'sk': 'META', 'workspace_id': WS_A,
                                           'created_at': body['form']['created_at']}

    def test_a_viewer_cannot_create_update_or_delete(self, world, lambda_context):
        before = world['workspaces'].scan()['Count']
        for method, path, form_id, payload in (('POST', '/feedback-forms', None, {'name': 'N'}),
                                               ('PUT', f'/feedback-forms/{FORM_A}', FORM_A, {'name': 'X'}),
                                               ('DELETE', f'/feedback-forms/{FORM_A}', FORM_A, None)):
            status, body = _call(lambda_context, method, path, claims=VIEWER, ws=WS_A, body=payload, form_id=form_id)
            assert status == 403, (method, body)
        assert world['workspaces'].scan()['Count'] == before
        assert _present(_stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A))['name'] == 'Form of D8'

    def test_a_viewer_reads(self, lambda_context):
        status, body = _call(lambda_context, 'GET', '/feedback-forms', claims=VIEWER, ws=WS_A)

        assert status == 200
        assert [form['form_id'] for form in body['forms']] == [FORM_A]

    @pytest.mark.parametrize(('claims', 'ws'), [(ADMIN, WS_A), (MEMBER_B, WS_A), (EDITOR, WS_GONE),
                                                (EDITOR, 'ws_not-an-id')])
    def test_a_non_member_an_admin_of_the_deployment_and_a_deleting_workspace_get_the_one_404(
            self, lambda_context, claims, ws):
        for method, path, form_id in (('GET', '/feedback-forms', None), ('POST', '/feedback-forms', None),
                                      ('GET', f'/feedback-forms/{FORM_A}/stats', FORM_A)):
            status, body = _call(lambda_context, method, path, claims=claims, ws=ws, body={}, form_id=form_id)
            assert (status, body) == (404, {'success': False, 'error': 'Workspace not found'}), (method, path)

    def test_lists_never_cross_scopes(self, lambda_context):
        _, in_b = _call(lambda_context, 'GET', '/feedback-forms', claims=MEMBER_B, ws=WS_B)
        _, deployment = _call(lambda_context, 'GET', '/feedback-forms', claims=EDITOR)

        assert [form['form_id'] for form in in_b['forms']] == [FORM_B]
        assert [form['form_id'] for form in deployment['forms']] == [LEGACY]

    def test_another_workspaces_form_cannot_be_updated_or_deleted(self, world, lambda_context):
        status, body = _call(lambda_context, 'PUT', f'/feedback-forms/{FORM_B}', claims=EDITOR, ws=WS_A,
                             body={'name': 'Taken'}, form_id=FORM_B)
        assert (status, body) == (404, NOT_FOUND)
        assert _stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_B) is None  # no stub written

        audits_before = world['workspaces'].query(KeyConditionExpression=Key('pk').eq(f'AUDIT#WS#{WS_A}'))['Count']
        status, body = _call(lambda_context, 'DELETE', f'/feedback-forms/{FORM_B}', claims=EDITOR, ws=WS_A,
                             form_id=FORM_B)
        assert (status, body) == (404, NOT_FOUND)  # as an unknown id: nothing confirmed, and nothing recorded
        assert world['workspaces'].query(KeyConditionExpression=Key('pk').eq(f'AUDIT#WS#{WS_A}'))['Count'] == audits_before
        assert _stored(world, f'WS#{WS_B}#FEEDBACK_FORM', FORM_B) is not None
        assert _present(_lookup(world, FORM_B))['workspace_id'] == WS_B

    def test_an_editor_updates_and_deletes_its_own_form(self, world, lambda_context):
        status, body = _call(lambda_context, 'PUT', f'/feedback-forms/{FORM_A}', claims=EDITOR, ws=WS_A,
                             body={'title': 'New title'}, form_id=FORM_A)
        assert (status, body['form']['title']) == (200, 'New title')

        status, _ = _call(lambda_context, 'DELETE', f'/feedback-forms/{FORM_A}', claims=EDITOR, ws=WS_A,
                          form_id=FORM_A)
        assert status == 200
        assert _stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A) is None
        assert _lookup(world, FORM_A) is None

    def test_an_editor_demoted_a_moment_ago_cannot_write(self, world, lambda_context):
        """A read fills the 30 s membership cache as an editor; the write resolves the role from the table."""
        assert _call(lambda_context, 'GET', '/feedback-forms', claims=EDITOR, ws=WS_A)[0] == 200  # cached
        world['workspaces'].put_item(Item={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{EDITOR['sub']}", 'role': 'viewer'})
        before = sorted(row['pk'] for row in world['workspaces'].scan()['Items'] if row['pk'].startswith('FORM#'))

        status, _ = _call(lambda_context, 'POST', '/feedback-forms', claims=EDITOR, ws=WS_A, body={'name': 'N'})

        assert status == 403
        assert sorted(row['pk'] for row in world['workspaces'].scan()['Items']
                      if row['pk'].startswith('FORM#')) == before

    def test_a_workspace_forms_delete_is_recorded_first(self, world, lambda_context):
        status, _ = _call(lambda_context, 'DELETE', f'/feedback-forms/{FORM_A}', claims=EDITOR, ws=WS_A,
                          form_id=FORM_A)

        assert status == 200
        [row] = [row for row in world['workspaces'].scan()['Items'] if row['pk'] == f'AUDIT#WS#{WS_A}']
        assert {key: row[key] for key in ('kind', 'actor', 'form_id')} == {
            'kind': 'form_deleted', 'actor': EDITOR['sub'], 'form_id': FORM_A}
        assert row['sk'].startswith(row['at'])

    def test_a_delete_whose_record_cannot_be_written_deletes_nothing(self, world, lambda_context):
        with patch.object(h, 'put_new_audit_row', side_effect=ClientError(
                {'Error': {'Code': 'AccessDeniedException'}}, 'PutItem')):
            status, _ = _call(lambda_context, 'DELETE', f'/feedback-forms/{FORM_A}', claims=EDITOR, ws=WS_A,
                              form_id=FORM_A)

        assert status == 500
        assert _stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A) is not None
        assert _lookup(world, FORM_A) is not None

    def test_the_deployments_form_is_not_reachable_from_a_workspace(self, lambda_context):
        status, body = _call(lambda_context, 'GET', f'/feedback-forms/{LEGACY}/stats', claims=EDITOR, ws=WS_A,
                             form_id=LEGACY)
        assert (status, body) == (404, NOT_FOUND)

    def test_stats_count_the_workspaces_own_submissions(self, world, lambda_context):
        channel = f'form_{FORM_A}'
        for pk, feedback_id, rating in ((f'WS#{WS_A}#SOURCE#Acme', '1', 4), (f'WS#{WS_A}#SOURCE#Acme', '2', 2),
                                        ('SOURCE#Acme', '3', 5), (f'WS#{WS_B}#SOURCE#Acme', '4', 1)):
            world['feedback'].put_item(Item={'pk': pk, 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
                                             'source_channel': channel, 'rating': rating})

        _, stats = _call(lambda_context, 'GET', f'/feedback-forms/{FORM_A}/stats', claims=VIEWER, ws=WS_A,
                         form_id=FORM_A)
        _, submissions = _call(lambda_context, 'GET', f'/feedback-forms/{FORM_A}/submissions', claims=VIEWER,
                               ws=WS_A, form_id=FORM_A)

        assert stats['stats'] == {'total_submissions': 2, 'avg_rating': 3.0, 'rating_count': 2}
        assert sorted(item['feedback_id'] for item in submissions['submissions']) == ['1', '2']

    def test_the_list_batch_stats_read_the_workspaces_partition(self, world, lambda_context):
        world['feedback'].put_item(Item={'pk': f'WS#{WS_A}#SOURCE#Acme', 'sk': 'FEEDBACK#1', 'feedback_id': '1',
                                         'source_channel': f'form_{FORM_A}', 'rating': 5})
        world['feedback'].put_item(Item={'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#2', 'feedback_id': '2',
                                         'source_channel': f'form_{FORM_A}', 'rating': 1})
        event = rest_event('GET', '/feedback-forms', claims=VIEWER)
        event['headers']['X-Workspace-Id'] = WS_A
        event['queryStringParameters'] = {'include': 'stats'}
        body = json.loads(h.lambda_handler(event, lambda_context)['body'])

        assert body['stats'] == {FORM_A: {'total_submissions': 1, 'avg_rating': 5.0, 'rating_count': 1}}

    def test_a_form_that_cannot_be_written_releases_its_lookup_row(self, world, lambda_context):
        def refuse(*_args: Any, **_kwargs: Any) -> None:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'PutItem')

        with patch('shared.ws_repo.WorkspaceTable.put_item', side_effect=refuse):
            status, _ = _call(lambda_context, 'POST', '/feedback-forms', claims=EDITOR, ws=WS_A, body={})

        assert status == 500
        lookups = sorted(row['pk'] for row in world['workspaces'].scan()['Items'] if row['pk'].startswith('FORM#'))
        assert lookups == sorted([f'FORM#{FORM_A}', f'FORM#{FORM_B}', f'FORM#{FORM_GONE}'])


@pytest.mark.usefixtures('world')
@pytest.mark.usefixtures('ingestion_on')
class TestThePublicRoutes:
    def test_a_workspaces_form_serves_its_own_config_whatever_header_is_sent(self, lambda_context):
        status, body = _call(lambda_context, 'GET', f'/feedback-forms/{FORM_A}/config', ws=WS_B, form_id=FORM_A)

        assert (status, body['config']['title']) == (200, 'Form of D8')

    def test_a_submission_is_queued_with_the_lookup_rows_workspace_never_the_requests(self, world, lambda_context):
        body = {'text': 'Checkout is slow', 'workspace_id': WS_B}
        status, answer = _call(lambda_context, 'POST', f'/feedback-forms/{FORM_A}/submit', ws=WS_B, body=body,
                               form_id=FORM_A)

        assert status == 200, answer
        message = _queued(world)
        assert message['workspace_id'] == WS_A
        assert list(message)[-1] == 'workspace_id'  # set after every other field
        assert message['source_channel'] == f'form_{FORM_A}'

    def test_the_raw_copy_of_a_workspaces_submission_is_kept_under_its_prefix(self, world, lambda_context):
        allow = [{'id': 'feedback_form', 'label': 'Forms', 'pii': 'allow'}]
        with raw_lake_client() as s3, seeded_source_profiles(allow):
            status, _ = _call(lambda_context, 'POST', f'/feedback-forms/{FORM_A}/submit', body={'text': 'Hello'},
                              form_id=FORM_A)
            [key] = raw_keys(s3)

        assert status == 200
        assert key.startswith(f'ws/{WS_A}/raw/feedback_form/')
        assert _queued(world)['s3_raw_uri'] == f's3://{RAW_BUCKET}/{key}'

    @pytest.mark.parametrize('form_id', [LEGACY, 'fd_' + 'd' * 32, 'ff_' + 'd' * 32])
    def test_a_form_without_a_lookup_row_is_the_deployments_as_before(self, world, lambda_context, form_id):
        if form_id != LEGACY:
            world['aggregates'].put_item(Item=_form('FEEDBACK_FORM', form_id, 'New deployment form'))

        status, answer = _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/submit', ws=WS_A,
                               body={'text': 'Hello', 'workspace_id': WS_A}, form_id=form_id)

        assert status == 200, answer
        assert 'workspace_id' not in _queued(world)

    def _rows(self, world: dict, form_id: str, workspace_id: str) -> None:
        world['workspaces'].put_item(Item={'pk': f'FORM#{form_id}', 'sk': 'META', 'workspace_id': workspace_id})
        world['aggregates'].put_item(Item=_form(f'WS#{WS_A}#FEEDBACK_FORM', form_id, 'x'))

    @pytest.mark.parametrize('case', ['deleting', 'unknown_workspace', 'malformed_workspace', 'orphan_row',
                                      'unknown_id'])
    def test_every_unroutable_form_answers_as_an_unknown_id(self, world, lambda_context, case):
        form_id = 'ff_' + 'e' * 32
        if case == 'deleting':
            form_id = FORM_GONE
        elif case == 'unknown_workspace':
            self._rows(world, form_id, 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DB')
        elif case == 'malformed_workspace':
            self._rows(world, form_id, 'WS_A')
        elif case == 'orphan_row':
            world['workspaces'].put_item(Item={'pk': f'FORM#{form_id}', 'sk': 'META', 'workspace_id': WS_A})

        for method, path in (('GET', 'config'), ('GET', 'iframe'), ('POST', 'submit')):
            status, body = _call(lambda_context, method, f'/feedback-forms/{form_id}/{path}', form_id=form_id,
                                 body={'text': 'Hello'} if method == 'POST' else None)
            assert (status, body) == (404, NOT_FOUND), (case, path)
        world['sqs'].send_message.assert_not_called()

    def test_the_iframe_of_a_workspaces_form_renders(self, lambda_context):
        status, page = _call(lambda_context, 'GET', f'/feedback-forms/{FORM_A}/iframe', form_id=FORM_A)

        assert status == 200
        assert FORM_A in page

    def test_a_routing_read_that_fails_is_a_500_never_the_deployments_form(self, world, lambda_context):
        def fail(**_kwargs: Any) -> dict:
            raise ClientError({'Error': {'Code': 'InternalServerError'}}, 'GetItem')

        with patch.object(world['workspaces'], 'get_item', side_effect=fail):
            status, _ = _call(lambda_context, 'POST', f'/feedback-forms/{FORM_A}/submit', body={'text': 'x'},
                              form_id=FORM_A)

        assert status == 500
        world['sqs'].send_message.assert_not_called()

    def test_a_workspace_forms_answer_credits_no_participant_ask(self, world, lambda_context):
        """Asks are the deployment's (phase 3): a valid response token on a workspace form's answer is not resolved,
        the message carries no participant and no recipient is marked responded."""
        ref = {'person_id': 'p1', 'ask_id': 'a1'}
        with (patch.object(h, 'resolve_participant', return_value=ref) as resolve,
              patch('shared.feedback_form_participants.mark_responded') as responded):
            status, _ = _call(lambda_context, 'POST', f'/feedback-forms/{FORM_A}/submit', form_id=FORM_A,
                              body={'text': 'Hello', 'participant_token': 'valid-token'})

        assert status == 200
        resolve.assert_not_called()
        responded.assert_not_called()
        assert 'participant' not in _queued(world)['metadata']

    def test_a_brandless_workspace_form_is_anchored_in_its_own_partition(self, world, lambda_context):
        world['aggregates'].put_item(Item={**_form(f'WS#{WS_A}#FEEDBACK_FORM', FORM_A, 'Form of D8'), 'brand_name': ''})

        status, _ = _call(lambda_context, 'POST', f'/feedback-forms/{FORM_A}/submit', body={'text': 'Hello'},
                          form_id=FORM_A)

        assert status == 200
        assert _present(_stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A))['brand_name'] == 'Acme'
        assert _stored(world, 'FEEDBACK_FORM', FORM_A) is None  # never a deployment row
        assert _queued(world)['brand_name'] == 'Acme'

    def test_a_deployment_forms_public_routes_make_no_routing_read(self, world, lambda_context):
        """A legacy id and a new deployment form's `fd_` id: no voc-workspaces read, so a lookup fault cannot touch
        a deployment widget."""
        _, created = _call(lambda_context, 'POST', '/feedback-forms', claims=EDITOR, body={'enabled': True})
        new_id = created['form']['form_id']
        assert new_id.startswith('fd_')
        with patch.object(world['workspaces'], 'get_item', side_effect=AssertionError('read')):
            for form_id in (LEGACY, new_id):
                assert _call(lambda_context, 'GET', f'/feedback-forms/{form_id}/config', form_id=form_id)[0] == 200
                assert _call(lambda_context, 'GET', f'/feedback-forms/{form_id}/iframe', form_id=form_id)[0] == 200
                status, _ = _call(lambda_context, 'POST', f'/feedback-forms/{form_id}/submit', form_id=form_id,
                                  body={'text': 'Hello'})
                assert status == 200

    def test_a_workspace_form_carrying_the_pin_type_is_feedback_of_its_workspace(self, world, lambda_context):
        """Defence in depth: only a deployment form takes the prototype-pin path."""
        world['aggregates'].put_item(Item={**_form(f'WS#{WS_A}#FEEDBACK_FORM', FORM_A, 'Pin'),
                                           'form_type': 'prototype_pin'})
        with patch.object(h, '_submit_prototype_pin', side_effect=AssertionError('pin path')):
            status, _ = _call(lambda_context, 'POST', f'/feedback-forms/{FORM_A}/submit', form_id=FORM_A,
                              body={'text': 'Hello'})

        assert status == 200
        assert _queued(world)['workspace_id'] == WS_A


@pytest.mark.usefixtures('world')
class TestTheDeploymentPathCannotTakeAWorkspacesId:
    def test_no_deployment_stub_is_written_under_a_workspace_forms_id(self, world, lambda_context):
        for method, payload in (('PUT', {'title': 'Stub'}), ('DELETE', None)):
            status, body = _call(lambda_context, method, f'/feedback-forms/{FORM_A}', claims=EDITOR, body=payload,
                                 form_id=FORM_A)
            assert (status, body) == (404, NOT_FOUND), method
        assert _stored(world, 'FEEDBACK_FORM', FORM_A) is None
        assert _present(_stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A))['title'] == 'Form of D8'

    def test_a_hand_seeded_deployment_row_under_a_workspace_forms_id_is_not_updated(self, world, lambda_context):
        """The lookup-row refusal, not the no-upsert condition: the row exists, and is still refused."""
        world['aggregates'].put_item(Item=_form('FEEDBACK_FORM', FORM_A, 'Seeded'))

        status, body = _call(lambda_context, 'PUT', f'/feedback-forms/{FORM_A}', claims=EDITOR, body={'title': 'New'},
                             form_id=FORM_A)

        assert (status, body) == (404, NOT_FOUND)
        assert _present(_stored(world, 'FEEDBACK_FORM', FORM_A))['title'] == 'Seeded'

    @pytest.mark.parametrize(('method', 'payload'), [('PUT', {'title': 'Stub'}), ('DELETE', None)])
    def test_an_id_routed_to_a_deleting_workspace_is_refused_too(self, world, lambda_context, method, payload):
        world['aggregates'].put_item(Item=_form('FEEDBACK_FORM', FORM_GONE, 'Seeded'))

        status, body = _call(lambda_context, method, f'/feedback-forms/{FORM_GONE}', claims=EDITOR, body=payload,
                             form_id=FORM_GONE)

        assert (status, body) == (404, NOT_FOUND)
        assert _present(_stored(world, 'FEEDBACK_FORM', FORM_GONE))['title'] == 'Seeded'
        assert _stored(world, f'WS#{WS_GONE}#FEEDBACK_FORM', FORM_GONE) is not None
        assert _lookup(world, FORM_GONE) is not None

    @pytest.mark.parametrize(('method', 'payload'), [('PUT', {'title': 'Stub'}), ('DELETE', None)])
    def test_a_lookup_fault_is_a_500_and_changes_nothing(self, world, lambda_context, method, payload):
        world['aggregates'].put_item(Item=_form('FEEDBACK_FORM', FORM_A, 'Seeded'))

        with patch.object(world['workspaces'], 'get_item', side_effect=ClientError(
                {'Error': {'Code': 'InternalServerError'}}, 'GetItem')):
            status, _ = _call(lambda_context, method, f'/feedback-forms/{FORM_A}', claims=EDITOR, body=payload,
                              form_id=FORM_A)

        assert status == 500
        assert _present(_stored(world, 'FEEDBACK_FORM', FORM_A))['title'] == 'Seeded'
        assert _stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A) is not None

    def test_a_deployment_update_never_upserts(self, world, lambda_context):
        status, body = _call(lambda_context, 'PUT', '/feedback-forms/fd_unknown', claims=EDITOR, body={'title': 'T'},
                             form_id='fd_unknown')
        assert (status, body) == (404, NOT_FOUND)
        assert _stored(world, 'FEEDBACK_FORM', 'fd_unknown') is None

    def test_once_the_workspace_deletes_its_form_the_public_routes_404(self, lambda_context):
        _call(lambda_context, 'PUT', f'/feedback-forms/{FORM_A}', claims=EDITOR, body={'title': 'Stub'},
              form_id=FORM_A)  # refused above: no stub
        assert _call(lambda_context, 'DELETE', f'/feedback-forms/{FORM_A}', claims=EDITOR, ws=WS_A,
                     form_id=FORM_A)[0] == 200

        for method, path in (('GET', 'config'), ('GET', 'iframe'), ('POST', 'submit')):
            status, body = _call(lambda_context, method, f'/feedback-forms/{FORM_A}/{path}', form_id=FORM_A,
                                 body={'text': 'Hello'} if method == 'POST' else None)
            assert (status, body) == (404, NOT_FOUND), path


def test_new_ids_are_unguessable_distinct_and_only_a_workspaces_is_routable():
    workspace_ids = {h.new_form_id(WorkspaceScope(WS_A)) for _ in range(500)}
    deployment_ids = {h.new_form_id() for _ in range(500)}
    assert len(workspace_ids | deployment_ids) == 1000
    assert all(h._ROUTABLE_FORM_ID.fullmatch(form_id) and h._validated_form_id(form_id) == form_id
               for form_id in workspace_ids)
    assert not any(h._ROUTABLE_FORM_ID.fullmatch(form_id) for form_id in deployment_ids)
    assert all(h._validated_form_id(form_id) == form_id for form_id in deployment_ids)


@pytest.mark.usefixtures('world')
class TestAWorkspaceFormsSubmissionIsHeld:
    """While per-workspace ingestion is off (shared/workspace_plugin_settings.py hold_workspace_ingestion), a
    workspace form's submission is ingestion into that workspace: the same 409 as enabling a plugin, before anything
    is archived or queued; a deployment form's submission is accepted as before."""

    def test_a_workspace_forms_submission_answers_the_hold_and_queues_nothing(self, world, lambda_context):
        with raw_lake_client() as s3:
            status, answer = _call(lambda_context, 'POST', f'/feedback-forms/{FORM_A}/submit', body={'text': 'Hello'},
                                   form_id=FORM_A)
            archived = raw_keys(s3)

        assert (status, answer['error']) == (409, workspace_plugin_settings.INGESTION_NOT_YET)
        world['sqs'].send_message.assert_not_called()
        assert archived == []

    def test_a_deployment_forms_submission_is_not_held(self, world, lambda_context):
        status, answer = _call(lambda_context, 'POST', f'/feedback-forms/{LEGACY}/submit', body={'text': 'Hello'},
                               form_id=LEGACY)

        assert status == 200, answer
        assert 'workspace_id' not in _queued(world)


@pytest.mark.usefixtures('world')
def test_a_workspace_form_cannot_be_created_while_ingestion_is_held(world, lambda_context):
    """A workspace form exists to take submissions into its workspace, which the hold refuses: its create answers the
    same 409 and writes nothing (no form, no lookup row)."""
    before = world['workspaces'].scan()['Count'], world['aggregates'].scan()['Count']
    status, body = _call(lambda_context, 'POST', '/feedback-forms', claims=EDITOR, ws=WS_A, body={'name': 'N'})

    assert (status, body['error']) == (409, workspace_plugin_settings.INGESTION_NOT_YET)
    assert (world['workspaces'].scan()['Count'], world['aggregates'].scan()['Count']) == before
