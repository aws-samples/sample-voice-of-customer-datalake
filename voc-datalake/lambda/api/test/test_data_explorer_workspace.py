"""Data Explorer on both paths (lambda/api/data_explorer_handler.py; docs/multi-workspace.md, "Request flow").

Against moto: one raw bucket holding the deployment's objects and workspaces A's and B's (``ws/{ws}/…``, exports
included), one feedback table with the same feedback id in each place, each place's categories and source profiles.

* every route resolves ``X-Workspace-Id`` first and gates on the admin role of the request's path: without the header
  the deployment's ``admins``, in a workspace its admins only (an editor or viewer 403, even one in ``admins``);
* in a workspace every prefix and key on the wire is relative to the workspace's root ``ws/{ws}/`` (built from the
  resolved scope only), validated, and stripped from every answer; a PUT writes under ``raw/`` only, write-once, under
  the workspace's PII profile, and its reprocess message names the workspace (last) and its raw root;
* deployment-wide nothing reaches a workspace: a prefix or key in ``ws/`` is the one fixed 400, the root listing
  hides the folder, and a body's ``workspace_id`` is dropped from the queued message;
* a feedback edit in a workspace finds, validates (its categories, its PII profile), writes, keeps and bumps in that
  workspace only.

Fictional names only (public-sample rules).
"""
from __future__ import annotations

import inspect
import json
from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import feedback_by_id_table, invoke, pk_sk_table, rest_event

import data_explorer_handler as h
from shared.feedback_field_edits import field_edits
from shared.test.source_profile_fixtures import seeded_source_profiles
from shared.workspace import NOT_FOUND
from shared.workspace_request import RequestWorkspace
from shared.ws_repo import WorkspaceScope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
BUCKET = 'test-raw-data-bucket'
FEEDBACK_TABLE = 'explorer-feedback'

#: A's admin (not in the deployment's ``admins``); A's editor who IS in ``admins``; A's viewer; B's admin; a
#: deployment admin in no workspace.
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'users'}
EDDIE = {'sub': 'sub-eddie', 'cognito:username': 'eddie', 'cognito:groups': '[admins, users]'}
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}
BEA = {'sub': 'sub-bea', 'cognito:username': 'bea', 'cognito:groups': 'users'}
DEE = {'sub': 'sub-dee', 'cognito:username': 'dee', 'cognito:groups': '[admins, users]'}

REVIEW_KEY = 'raw/app/2026/review.json'
#: Every place's objects: the same relative layout, each with its own words.
OBJECTS = {
    '': {REVIEW_KEY: 'deployment words', 'exports/all.csv': 'deployment export'},
    f'ws/{WS_A}/': {REVIEW_KEY: 'alderbrook words', 'exports/a.csv': 'alderbrook export',
                    'raw/app/2026/photo.png': 'png'},
    f'ws/{WS_B}/': {REVIEW_KEY: 'bramblewood words', 'exports/b.csv': 'bramblewood export',
                    'raw/app/2026/bramblewood.json': 'bramblewood only'},
}
#: Each place's categories (A's ``returns`` and B's ``trails`` exist nowhere else).
CATEGORIES = {None: ['delivery', 'billing'], WS_A: ['delivery', 'returns'], WS_B: ['delivery', 'trails']}
#: Each place's source profiles: ``web`` (the feedback) redacts in A only, ``tickets`` refuses raw copies in A only,
#: ``app`` (the raw objects) is allowed everywhere; ``survey`` redacts on the deployment path (and, unnamed there, in
#: every workspace: a workspace's default redacts).
DEPLOYMENT_PROFILES = [{'id': 'app', 'pii': 'allow'}, {'id': 'web', 'pii': 'allow'}, {'id': 'tickets', 'pii': 'allow'},
                       {'id': 'survey', 'pii': 'redact'}]
WORKSPACE_PROFILES = {
    WS_A: [{'id': 'app', 'pii': 'allow'}, {'id': 'web', 'pii': 'redact'}, {'id': 'tickets', 'pii': 'redact'}],
    WS_B: [{'id': 'app', 'pii': 'allow'}, {'id': 'web', 'pii': 'allow'}, {'id': 'tickets', 'pii': 'allow'}],
}
EMAIL_TEXT = 'Write to ada@example.com about the late parcel'


def _item(prefix: str, feedback_id: str, text: str) -> dict[str, Any]:
    return {'pk': f'{prefix}SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'source_platform': 'web', 'gsi4pk': f'{prefix}FEEDBACK#{feedback_id}',
            'gsi2pk': f'{prefix}CATEGORY#delivery', 'gsi2sk': '-0.5#2026-01-01T00:00:00Z', 'category': 'delivery',
            'original_text': text, 'urgency': 'low'}


@dataclass
class World:
    s3: Any
    feedback: Any
    aggregates: Any
    sqs: MagicMock
    lambda_context: Any

    def call(self, method: str, path: str, *, ws: str | None, caller: dict = ADA, body: dict | None = None,
             query: dict[str, str] | None = None) -> tuple[int, Any]:
        event = rest_event(method, path, claims=caller, body=body)
        event['queryStringParameters'] = query
        if ws is not None:
            event['headers']['X-Workspace-Id'] = ws
        return invoke(h, event, self.lambda_context, aggregates=self.aggregates)

    def objects(self) -> dict[str, bytes]:
        listed = self.s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])
        return {o['Key']: self.s3.get_object(Bucket=BUCKET, Key=o['Key'])['Body'].read() for o in listed}

    def queued(self) -> list[dict]:
        return [json.loads(c.kwargs['MessageBody']) for c in self.sqs.send_message.call_args_list]


def _seed_workspace(table: Any, ws: str, members: dict[str, str]) -> None:
    table.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': ws, 'slug': ws[-4:].lower(), 'status': 'active'})
    for sub, role in members.items():
        table.put_item(Item={'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}', 'role': role, 'email': f'{sub}@example.com'})
        table.put_item(Item={'pk': f'USER#{sub}', 'sk': f'WS#{ws}', 'role': role})


@pytest.fixture
def world(lambda_context, monkeypatch) -> Iterator[World]:
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    with mock_aws():
        workspaces = pk_sk_table('workspaces')
        _seed_workspace(workspaces, WS_A, {'sub-ada': 'admin', 'sub-eddie': 'editor', 'sub-vic': 'viewer'})
        _seed_workspace(workspaces, WS_B, {'sub-bea': 'admin'})
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        for root, objects in OBJECTS.items():
            for key, text in objects.items():
                body = json.dumps({'text': text}) if key.endswith('.json') else text
                s3.put_object(Bucket=BUCKET, Key=f'{root}{key}', Body=body.encode())
        feedback, aggregates = feedback_by_id_table(FEEDBACK_TABLE), pk_sk_table('aggregates')
        for ws, names in CATEGORIES.items():
            pk = 'SETTINGS#categories' if ws is None else f'WS#{ws}#SETTINGS#categories'
            aggregates.put_item(Item={'pk': pk, 'sk': 'config', 'categories': [{'name': n} for n in names]})
        feedback.put_item(Item=_item('', 'f1', 'the deployment review'))
        feedback.put_item(Item=_item(f'WS#{WS_A}#', 'f1', 'alderbrook parcel came late'))
        feedback.put_item(Item=_item(f'WS#{WS_B}#', 'f1', 'bramblewood chain slipped'))
        feedback.put_item(Item=_item(f'WS#{WS_B}#', 'fb', 'bramblewood only'))
        sqs = MagicMock(name='sqs')
        resolver = RequestWorkspace(table=lambda: workspaces, confirm_platform_admin=lambda _event: False)
        with patch.object(h, 's3_client', s3), patch.object(h, 'sqs_client', sqs), \
                patch.object(h, 'dynamodb', boto3.resource('dynamodb', region_name='us-east-1')), \
                patch.object(h, 'FEEDBACK_TABLE', FEEDBACK_TABLE), \
                patch.object(h, 'PROCESSING_QUEUE_URL', 'https://queue.example.com/q'), \
                patch.object(h._request, 'workspace', resolver), \
                seeded_source_profiles(DEPLOYMENT_PROFILES, WORKSPACE_PROFILES):
            yield World(s3, feedback, aggregates, sqs, lambda_context)


# ── 1. Resolution and the admin gate on each path ────────────────────────────

ROUTES = [
    ('GET', '/data-explorer/buckets', None, None),
    ('GET', '/data-explorer/s3', None, {'prefix': 'raw/app/2026'}),
    ('GET', '/data-explorer/s3/preview', None, {'key': REVIEW_KEY}),
    ('PUT', '/data-explorer/s3', {'key': 'raw/app/2026/new.json', 'content': {'text': 'new words'}}, None),
    ('PUT', '/data-explorer/feedback', {'feedback_id': 'f1', 'data': {'urgency': 'high'}}, None),
]
_ROUTE_IDS = [f'{m} {p}' for m, p, _b, _q in ROUTES]


@pytest.mark.parametrize(('method', 'path', 'body', 'query'), ROUTES, ids=_ROUTE_IDS)
def test_every_route_serves_a_workspace_admin(world, method, path, body, query):
    status, answer = world.call(method, path, ws=WS_A, caller=ADA, body=body, query=query)
    assert status == 200, answer


@pytest.mark.parametrize('caller', [EDDIE, VIC], ids=['editor-in-admins', 'viewer'])
@pytest.mark.parametrize(('method', 'path', 'body', 'query'), ROUTES, ids=_ROUTE_IDS)
def test_in_a_workspace_only_its_admins_pass_and_the_deployment_group_grants_nothing(
        world, method, path, body, query, caller):
    before = world.objects()
    status, answer = world.call(method, path, ws=WS_A, caller=caller, body=body, query=query)
    assert (status, answer) == (403, {'success': False, 'error': 'Workspace admin access required'})
    assert world.objects() == before
    world.sqs.send_message.assert_not_called()


@pytest.mark.parametrize('ws', [WS_B, 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'], ids=['another-workspace', 'unknown'])
@pytest.mark.parametrize(('method', 'path', 'body', 'query'), ROUTES, ids=_ROUTE_IDS)
def test_a_workspace_the_caller_is_not_in_is_the_one_404(world, method, path, body, query, ws):
    status, answer = world.call(method, path, ws=ws, caller=DEE, body=body, query=query)
    assert (status, answer) == (404, {'success': False, 'error': NOT_FOUND})


@pytest.mark.parametrize(('method', 'path', 'body', 'query'), ROUTES, ids=_ROUTE_IDS)
def test_without_the_header_the_deployment_admins_as_before(world, method, path, body, query):
    assert world.call(method, path, ws=None, caller=ADA, body=body, query=query)[0] == 403
    status, answer = world.call(method, path, ws=None, caller=DEE, body=body, query=query)
    assert status == 200, answer


def test_an_empty_header_is_refused_not_served_deployment_wide(world):
    status, _ = world.call('GET', '/data-explorer/s3', ws='', caller=DEE)
    assert status == 400


def test_the_buckets_answer_is_the_same_on_both_paths(world):
    inside = world.call('GET', '/data-explorer/buckets', ws=WS_A, caller=ADA)
    assert inside == world.call('GET', '/data-explorer/buckets', ws=None, caller=DEE)
    assert inside[1]['buckets'][0]['id'] == 'raw-data'


# ── 2. Objects in a workspace: relative on the wire, under its root only ───────

def test_the_workspace_root_lists_its_own_folders_only(world):
    status, body = world.call('GET', '/data-explorer/s3', ws=WS_A)
    assert status == 200
    assert body['prefix'] == ''
    assert [(o['key'], o['isFolder']) for o in body['objects']] == [('exports', True), ('raw', True)]
    assert WS_A not in json.dumps(body)


def test_a_workspace_listing_is_relative_and_its_summaries_are_its_own(world):
    status, body = world.call('GET', '/data-explorer/s3', ws=WS_A, query={'prefix': 'raw/app/2026'})
    assert status == 200
    assert body['prefix'] == 'raw/app/2026'
    files = {o['key']: o for o in body['objects']}
    assert sorted(files) == ['photo.png', 'review.json']
    assert files['review.json']['fullKey'] == REVIEW_KEY
    assert files['review.json']['summary'] == {'title': 'alderbrook words'}
    text = json.dumps(body)
    assert 'bramblewood' not in text
    assert 'deployment words' not in text
    assert f'ws/{WS_A}' not in text


def test_a_workspace_lists_its_exports_not_another_workspaces(world):
    _, body = world.call('GET', '/data-explorer/s3', ws=WS_A, query={'prefix': 'exports'})
    assert [o['fullKey'] for o in body['objects']] == ['exports/a.csv']


@pytest.mark.parametrize('prefix', ['..', 'raw/../..', 'raw//app', 'raw/./app', 'raw/\x00app', 'raw/app\n'],
                         ids=['dotdot', 'climbs', 'empty-segment', 'dot', 'nul', 'newline'])
def test_a_workspace_prefix_that_names_another_place_is_refused(world, prefix):
    with patch.object(h, 's3_client', wraps=world.s3) as s3:
        status, body = world.call('GET', '/data-explorer/s3', ws=WS_A, query={'prefix': prefix})
    assert (status, body) == (400, {'success': False, 'error': h.INVALID_PATH})
    s3.list_objects_v2.assert_not_called()


def test_a_workspace_preview_reads_its_own_object_and_answers_the_relative_key(world):
    status, body = world.call('GET', '/data-explorer/s3/preview', ws=WS_A, query={'key': REVIEW_KEY})
    assert status == 200
    assert body['content'] == {'text': 'alderbrook words'}
    assert body['key'] == REVIEW_KEY


def test_a_workspace_presigns_its_own_object_only(world):
    status, body = world.call('GET', '/data-explorer/s3/preview', ws=WS_A, query={'key': 'raw/app/2026/photo.png'})
    assert status == 200
    assert body['isPresignedUrl'] is True
    assert body['key'] == 'raw/app/2026/photo.png'
    assert f'ws/{WS_A}/raw/app/2026/photo.png' in body['content']


@pytest.mark.parametrize('key', ['raw/app/2026/bramblewood.json', f'ws/{WS_B}/{REVIEW_KEY}', 'raw/app/2026/none.json'],
                         ids=['b-only-key', 'b-absolute-key', 'unknown'])
def test_another_workspaces_object_is_not_found_inside_a(world, key):
    assert world.call('GET', '/data-explorer/s3/preview', ws=WS_A, query={'key': key}) == (
        404, {'success': False, 'error': 'File not found'})


#: The answer to a key that is not plain names, on every keyed route and both paths.
_INVALID_PATH = (400, {'success': False, 'error': h.INVALID_PATH})


def _put_key(world, key, ws, **caller):
    """`PUT /data-explorer/s3` of *key* (any JSON value) with a one-character content, in *ws* (None: deployment)."""
    return world.call('PUT', '/data-explorer/s3', ws=ws, body={'key': key, 'content': 'x'}, **caller)


@pytest.mark.parametrize('key', [f'/{REVIEW_KEY}', f'../{WS_B}/{REVIEW_KEY}', 'raw/./x.json', 'raw//x.json',
                                 'raw/x.json/', 'raw/\x07x.json'],
                         ids=['leading-slash', 'climbs', 'dot', 'empty-segment', 'trailing-slash', 'control'])
def test_a_workspace_key_that_names_another_place_is_refused_on_every_keyed_route(world, key):
    before = world.objects()
    assert world.call('GET', '/data-explorer/s3/preview', ws=WS_A, query={'key': key}) == _INVALID_PATH
    assert _put_key(world, key, WS_A) == _INVALID_PATH
    assert world.objects() == before


@pytest.mark.parametrize('key', [7, ['raw', 'x.json'], {'key': 'raw/x.json'}], ids=['number', 'list', 'object'])
def test_a_workspace_key_that_is_not_text_is_the_same_400(world, key):
    before = world.objects()
    assert _put_key(world, key, WS_A) == _INVALID_PATH
    assert world.objects() == before


def test_a_workspace_put_creates_its_raw_object_once_with_its_connector(world):
    body = {'key': 'raw/app/2026/new.json', 'content': {'text': 'new words'}}
    status, answer = world.call('PUT', '/data-explorer/s3', ws=WS_A, body=body)
    assert status == 200
    assert answer == {'success': True, 'message': 'File saved', 'key': 'raw/app/2026/new.json', 'synced': False}
    bucket_key = f'ws/{WS_A}/raw/app/2026/new.json'
    assert json.loads(world.objects()[bucket_key]) == {'text': 'new words'}
    assert world.s3.head_object(Bucket=BUCKET, Key=bucket_key)['Metadata']['connector'] == 'data_explorer'
    assert 'raw/app/2026/new.json' not in world.objects()
    # Write-once: the same key again is the raw tier's 409, the object unchanged.
    assert world.call('PUT', '/data-explorer/s3', ws=WS_A, body={**body, 'content': 'other'})[0] == 409
    assert json.loads(world.objects()[bucket_key]) == {'text': 'new words'}


def test_a_workspace_put_sends_the_conditional_write_the_bucket_policy_needs(world):
    with patch.object(h, 's3_client', wraps=world.s3) as s3:
        world.call('PUT', '/data-explorer/s3', ws=WS_A, body={'key': 'raw/app/x.json', 'content': 'x'})
    kwargs = s3.put_object.call_args.kwargs
    assert (kwargs['Key'], kwargs['IfNoneMatch']) == (f'ws/{WS_A}/raw/app/x.json', '*')
    assert kwargs['Metadata']['connector'] == 'data_explorer'


@pytest.mark.parametrize('key', ['exports/new.csv', 'silver/web/f1/x.json', 'prototypes/p.html', 'notes.json',
                                 'engineering/cache/x', 'ws/x.json', 'rawish/x.json'])
def test_a_workspace_writes_under_raw_only(world, key):
    before = world.objects()
    assert world.call('PUT', '/data-explorer/s3', ws=WS_A, body={'key': key, 'content': 'x'}) == (
        400, {'success': False, 'error': h.WORKSPACE_READ_ONLY})
    assert world.objects() == before


def test_the_raw_archive_check_reads_the_workspaces_profile(world):
    key = 'raw/tickets/2026/t.json'
    status, body = world.call('PUT', '/data-explorer/s3', ws=WS_A, body={'key': key, 'content': 'x'})
    assert (status, 'keeps no raw copies' in body['error']) == (400, True)
    assert f'ws/{WS_A}/{key}' not in world.objects()
    # The deployment and B allow the same source.
    assert world.call('PUT', '/data-explorer/s3', ws=None, caller=DEE, body={'key': key, 'content': 'x'})[0] == 200
    assert world.call('PUT', '/data-explorer/s3', ws=WS_B, caller=BEA, body={'key': key, 'content': 'x'})[0] == 200
    assert {key, f'ws/{WS_B}/{key}'} <= set(world.objects())


@pytest.mark.parametrize('sync', [False, True], ids=['saved', 'saved-and-synced'])
def test_a_workspace_raw_object_whose_content_names_a_redacting_source_is_refused(world, sync):
    # The key says `app` (allowed in A) but the content says `tickets` (redacts in A): the stricter refuses.
    content = {'id': 'r2', 'source_platform': 'tickets', 'text': 'Mail a@example.io'}
    before = world.objects()
    status, body = world.call('PUT', '/data-explorer/s3', ws=WS_A,
                              body={'key': 'raw/app/2026/r2.json', 'content': content, 'sync_to_dynamo': sync})
    assert (status, body) == (400, {'success': False,
                                    'error': 'Source "tickets" keeps no raw copies (its PII policy is not "allow")'})
    assert world.objects() == before
    world.sqs.send_message.assert_not_called()


@pytest.mark.parametrize('sync', [False, True], ids=['saved', 'saved-and-synced'])
def test_a_deployment_raw_object_whose_content_names_a_redacting_source_is_refused(world, sync):
    content = {'id': 'r4', 'source_platform': 'survey', 'text': 'Mail a@example.io'}
    before = world.objects()
    status, body = world.call('PUT', '/data-explorer/s3', ws=None, caller=DEE,
                              body={'key': 'raw/app/2026/r4.json', 'content': content, 'sync_to_dynamo': sync})
    assert (status, body) == (400, {'success': False,
                                    'error': 'Source "survey" keeps no raw copies (its PII policy is not "allow")'})
    assert world.objects() == before
    world.sqs.send_message.assert_not_called()


@pytest.mark.parametrize('ws', [None, WS_A], ids=['deployment', 'workspace'])
def test_a_raw_object_whose_content_names_an_allowed_source_or_none_is_saved(world, ws):
    caller = DEE if ws is None else ADA
    for name, content in [('a.json', {'source_platform': 'app', 'text': 'x'}), ('b.json', {'text': 'x'}),
                          ('c.json', 'not json'), ('d.json', '["a list"]')]:
        status, body = world.call('PUT', '/data-explorer/s3', ws=ws, caller=caller,
                                  body={'key': f'raw/app/2026/{name}', 'content': content})
        assert status == 200, (name, body)


def test_a_redacting_key_source_still_refuses_when_the_content_names_an_allowed_one(world):
    content = {'source_platform': 'app', 'text': 'x'}
    status, body = world.call('PUT', '/data-explorer/s3', ws=WS_A,
                              body={'key': 'raw/tickets/2026/t.json', 'content': content})
    assert (status, 'Source "tickets" keeps no raw copies' in body['error']) == (400, True)


# ── 3. The deployment path never reaches a workspace ──────────────────────────

def test_the_deployment_root_listing_hides_the_workspaces_folder(world):
    status, body = world.call('GET', '/data-explorer/s3', ws=None, caller=DEE)
    assert status == 200
    assert [o['key'] for o in body['objects']] == ['exports', 'raw']


def test_the_deployment_listing_is_its_own(world):
    _, body = world.call('GET', '/data-explorer/s3', ws=None, caller=DEE, query={'prefix': 'raw/app/2026'})
    assert [o['fullKey'] for o in body['objects']] == [REVIEW_KEY]
    assert body['objects'][0]['summary'] == {'title': 'deployment words'}


@pytest.mark.parametrize('prefix', ['ws', f'ws/{WS_A}', f'/ws/{WS_A}/raw/', f'ws/{WS_A}/exports', 'ws/'])
def test_a_deployment_listing_of_the_workspaces_folder_is_the_one_400(world, prefix):
    with patch.object(h, 's3_client', wraps=world.s3) as s3:
        assert world.call('GET', '/data-explorer/s3', ws=None, caller=DEE, query={'prefix': prefix}) == (
            400, {'success': False, 'error': h.WORKSPACES_FOLDER})
    s3.list_objects_v2.assert_not_called()


@pytest.mark.parametrize('key', [f'ws/{WS_A}/{REVIEW_KEY}', f'ws/{WS_B}/exports/b.csv', f'ws/{WS_A}/nothing.json'])
def test_a_deployment_preview_or_put_in_the_workspaces_folder_is_the_one_400(world, key):
    before = world.objects()
    refused = (400, {'success': False, 'error': h.WORKSPACES_FOLDER})
    assert world.call('GET', '/data-explorer/s3/preview', ws=None, caller=DEE, query={'key': key}) == refused
    assert world.call('PUT', '/data-explorer/s3', ws=None, caller=DEE, body={'key': key, 'content': 'x'}) == refused
    assert world.objects() == before


#: Deployment keys that are not plain names: each could read as the workspaces' folder once normalised.
_NOT_PLAIN_KEYS = [f'raw/../ws/{WS_B}/raw/x.json', f'./ws/{WS_B}/x', f'/ws/{WS_B}/raw/x.json', 'raw//x.json',
                   'raw/x.json/', 'raw/\x07x.json']
_NOT_PLAIN_IDS = ['climbs-into-ws', 'dot-ws', 'leading-slash-ws', 'empty-segment', 'trailing-slash', 'control']


@pytest.mark.parametrize('key', _NOT_PLAIN_KEYS, ids=_NOT_PLAIN_IDS)
def test_a_deployment_key_that_is_not_plain_names_is_refused_on_every_keyed_route(world, key):
    before = world.objects()
    with patch.object(h, 's3_client', wraps=world.s3) as s3:
        assert world.call('GET', '/data-explorer/s3/preview', ws=None, caller=DEE, query={'key': key}) == _INVALID_PATH
        assert _put_key(world, key, None, caller=DEE) == _INVALID_PATH
    s3.head_object.assert_not_called()
    s3.get_object.assert_not_called()
    s3.put_object.assert_not_called()
    s3.generate_presigned_url.assert_not_called()
    assert world.objects() == before


@pytest.mark.parametrize('key', [7, ['raw', 'x.json']], ids=['number', 'list'])
def test_a_deployment_key_that_is_not_text_is_the_same_400(world, key):
    before = world.objects()
    assert _put_key(world, key, None, caller=DEE) == _INVALID_PATH
    assert world.objects() == before


@pytest.mark.parametrize(('prefix', 'error'), [
    (f'raw/../ws/{WS_B}/raw', h.INVALID_PATH), (f'./ws/{WS_B}/raw', h.INVALID_PATH), ('raw//app', h.INVALID_PATH),
    ('raw/./app', h.INVALID_PATH), ('raw/\x00app', h.INVALID_PATH),
    # (a prefix's outer slashes are trimmed first, as before: what is left is the workspaces' folder)
    (f'/ws/{WS_B}/raw/x.json', h.WORKSPACES_FOLDER),
], ids=['climbs-into-ws', 'dot-ws', 'empty-segment', 'dot', 'nul', 'leading-slash-ws'])
def test_a_deployment_prefix_that_is_not_plain_names_is_refused(world, prefix, error):
    with patch.object(h, 's3_client', wraps=world.s3) as s3:
        assert world.call('GET', '/data-explorer/s3', ws=None, caller=DEE, query={'prefix': prefix}) == (
            400, {'success': False, 'error': error})
    s3.list_objects_v2.assert_not_called()


def test_a_deployment_prefix_keeps_its_outer_slashes_trimmed(world):
    _, body = world.call('GET', '/data-explorer/s3', ws=None, caller=DEE, query={'prefix': '/raw/app/2026/'})
    assert [o['fullKey'] for o in body['objects']] == [REVIEW_KEY]


def test_a_deployment_preview_reads_the_deployments_object(world):
    _, body = world.call('GET', '/data-explorer/s3/preview', ws=None, caller=DEE, query={'key': REVIEW_KEY})
    assert (body['content'], body['key']) == ({'text': 'deployment words'}, REVIEW_KEY)


def test_the_deployment_still_writes_outside_raw(world):
    assert world.call('PUT', '/data-explorer/s3', ws=None, caller=DEE,
                      body={'key': 'notes/n.json', 'content': 'x'})[0] == 200
    assert 'notes/n.json' in world.objects()


# ── 4. Reprocess: the workspace's policy, raw root and workspace_id ────────────

def test_a_workspace_reprocess_names_the_workspace_and_its_raw_root(world):
    content = {'id': 'r1', 'source_platform': 'app', 'text': 'Great trail shoes', 'workspace_id': WS_B}
    status, body = world.call('PUT', '/data-explorer/s3', ws=WS_A,
                              body={'key': 'raw/app/2026/r1.json', 'content': content, 'sync_to_dynamo': True})
    assert (status, body['synced']) == (200, True)
    [message] = world.queued()
    assert message['workspace_id'] == WS_A
    assert list(message)[-1] == 'workspace_id'
    assert message['s3_raw_uri'] == f's3://{BUCKET}/ws/{WS_A}/raw/app/2026/r1.json'
    assert message['pii_policy_applied'] == 'allow'


def test_a_workspace_reprocess_applies_the_workspaces_policy(world):
    # The content's `tickets` redacts in A: no raw object and no message there (the test above); B allows it, so B's
    # save keeps the raw copy and queues the text as it is, under B's raw root.
    content = {'id': 'r2', 'source_platform': 'tickets', 'text': 'Mail a@example.io'}
    assert world.call('PUT', '/data-explorer/s3', ws=WS_A,
                      body={'key': 'raw/app/2026/r2.json', 'content': content, 'sync_to_dynamo': True})[0] == 400
    status, _ = world.call('PUT', '/data-explorer/s3', ws=WS_B, caller=BEA,
                           body={'key': 'raw/app/2026/r2.json', 'content': content, 'sync_to_dynamo': True})
    assert status == 200
    [message] = world.queued()
    assert (message['text'], message['pii_policy_applied']) == ('Mail a@example.io', 'allow')
    assert message['s3_raw_uri'] == f's3://{BUCKET}/ws/{WS_B}/raw/app/2026/r2.json'
    assert message['workspace_id'] == WS_B


def test_the_deployment_reprocess_is_unchanged_and_drops_a_bodys_workspace_id(world):
    content = {'id': 'r3', 'source_platform': 'tickets', 'text': 'Mail a@example.io', 'workspace_id': WS_A}
    world.call('PUT', '/data-explorer/s3', ws=None, caller=DEE,
               body={'key': 'raw/app/2026/r3.json', 'content': content, 'sync_to_dynamo': True})
    [message] = world.queued()
    assert message == {'id': 'r3', 'source_platform': 'tickets', 'text': 'Mail a@example.io',
                       'pii_policy_applied': 'allow', 's3_raw_uri': f's3://{BUCKET}/raw/app/2026/r3.json'}


# ── 5. Feedback edits in a workspace ─────────────────────────────────────────

def _feedback(world: World, prefix: str, feedback_id: str = 'f1') -> dict:
    return world.feedback.get_item(Key={'pk': f'{prefix}SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}'})['Item']


def _silver_keys(world: World) -> list[str]:
    return sorted(key for key in world.objects() if '/silver/' in f'/{key}')


@pytest.mark.parametrize('data', [{'urgency': 'high'}, {'urgency': 'high', 'source_platform': 'web'}],
                         ids=['by-id', 'by-source-hint'])
def test_a_workspace_edit_changes_its_own_item_only(world, data):
    status, body = world.call('PUT', '/data-explorer/feedback', ws=WS_A, body={'feedback_id': 'f1', 'data': data})
    assert (status, body) == (200, {'success': True, 'message': 'Feedback updated'})
    mine = _feedback(world, f'WS#{WS_A}#')
    assert mine['urgency'] == 'high'
    assert mine['updated_by'] == {'sub': 'sub-ada', 'kind': 'admin'}
    assert mine['change_reason'] == 'data_explorer_edit'
    assert _feedback(world, '')['urgency'] == 'low'
    assert _feedback(world, f'WS#{WS_B}#')['urgency'] == 'low'
    # Kept under A's silver tier; A's own data version moved, not the deployment's.
    assert [key.split('/')[:5] for key in _silver_keys(world)] == [['ws', WS_A, 'silver', 'web', 'f1']]
    assert world.aggregates.get_item(Key={'pk': f'WS#{WS_A}#METRIC#meta', 'sk': 'data_version'}).get('Item')
    assert 'Item' not in world.aggregates.get_item(Key={'pk': 'METRIC#meta', 'sk': 'data_version'})


@pytest.mark.parametrize('data', [{'urgency': 'high'}, {'urgency': 'high', 'source_platform': 'web'}],
                         ids=['by-id', 'by-source-hint'])
def test_another_workspaces_feedback_is_not_found_inside_a(world, data):
    before = world.feedback.scan()['Items']
    assert world.call('PUT', '/data-explorer/feedback', ws=WS_A, body={'feedback_id': 'fb', 'data': data}) == (
        404, {'success': False, 'error': 'Feedback not found'})
    assert world.feedback.scan()['Items'] == before
    assert _silver_keys(world) == []


def test_the_deployment_edit_changes_the_deployments_item_only(world):
    status, _ = world.call('PUT', '/data-explorer/feedback', ws=None, caller=DEE,
                           body={'feedback_id': 'f1', 'data': {'urgency': 'high'}})
    assert status == 200
    assert _feedback(world, '')['urgency'] == 'high'
    assert _feedback(world, f'WS#{WS_A}#')['urgency'] == 'low'
    assert [key.split('/')[0] for key in _silver_keys(world)] == ['silver']


def test_a_workspace_category_change_uses_its_categories_and_partitions(world):
    assert world.call('PUT', '/data-explorer/feedback', ws=WS_A,
                      body={'feedback_id': 'f1', 'data': {'category': 'billing'}})[0] == 400
    status, _ = world.call('PUT', '/data-explorer/feedback', ws=WS_A,
                           body={'feedback_id': 'f1', 'data': {'category': 'returns'}})
    assert status == 200
    mine = _feedback(world, f'WS#{WS_A}#')
    assert (mine['category'], mine['gsi2pk'], mine['category_source']) == (
        'returns', f'WS#{WS_A}#CATEGORY#returns', 'manual')
    # The deployment keeps its own list: A's category is not one of its.
    assert world.call('PUT', '/data-explorer/feedback', ws=None, caller=DEE,
                      body={'feedback_id': 'f1', 'data': {'category': 'returns'}})[0] == 400
    assert _feedback(world, '')['gsi2pk'] == 'CATEGORY#delivery'


def test_a_workspace_edit_applies_the_workspaces_pii_policy(world):
    world.call('PUT', '/data-explorer/feedback', ws=WS_A, body={'feedback_id': 'f1', 'data': {'original_text': EMAIL_TEXT}})
    assert _feedback(world, f'WS#{WS_A}#')['original_text'] == 'Write to [EMAIL] about the late parcel'
    world.call('PUT', '/data-explorer/feedback', ws=None, caller=DEE,
               body={'feedback_id': 'f1', 'data': {'original_text': EMAIL_TEXT}})
    assert _feedback(world, '')['original_text'] == EMAIL_TEXT


# ── shared/feedback_field_edits.py: the policy is the scope's ─────────────────

def test_field_edits_reads_the_scopes_profile_and_none_is_the_deployments():
    item = {'source_platform': 'web', 'original_text': 'old'}
    with seeded_source_profiles(DEPLOYMENT_PROFILES, WORKSPACE_PROFILES):
        inside = field_edits(item, {'original_text': EMAIL_TEXT}, scope=WorkspaceScope(WS_A))
        deployment = field_edits(item, {'original_text': EMAIL_TEXT})
        other = field_edits(item, {'original_text': EMAIL_TEXT}, scope=WorkspaceScope(WS_B))
    assert (inside.pii_policy, inside.sets['original_text']) == ('redact', 'Write to [EMAIL] about the late parcel')
    assert (deployment.pii_policy, deployment.sets['original_text']) == ('allow', EMAIL_TEXT)
    assert other.pii_policy == 'allow'


def test_field_edits_takes_the_scope_by_keyword_only():
    # A positional scope is refused by the signature itself (keyword-only, defaulting to the deployment's), so a call
    # cannot pass a workspace in the place of another argument.
    parameter = inspect.signature(field_edits).parameters['scope']
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is None


def test_a_numeric_edit_in_a_workspace_is_a_decimal_as_before(world):
    world.call('PUT', '/data-explorer/feedback', ws=WS_A, body={'feedback_id': 'f1', 'data': {'rating': 4}})
    assert _feedback(world, f'WS#{WS_A}#')['rating'] == Decimal(4)
