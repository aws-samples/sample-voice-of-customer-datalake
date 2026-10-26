"""The assistant's reads carry the caller's permissions end to end.

`lambda/stream/src/assistant/tools/internal-api.ts` does not call the projects
table: it invokes the projects Lambda with a SYNTHETIC API Gateway REST proxy
event whose authorizer claims are the caller's forwarded claims (`buildProxyEvent`),
so the route's gate decides exactly as it would for the user's own request.

This test builds that event the way the TypeScript does — only the four forwarded
claim keys, no Authorization header, no `requestContext.identity`, `stage: 'v1'` —
and runs it through the REAL `projects_handler` (gate middleware included) against
a moto table. What it pins is the contract the assistant's `get_project` relies on:

  * a view-only member gets 200 with `access.can_edit == false` (the stream drops
    every project write tool on that answer);
  * a non-member on a private project gets the same 404 as a missing project.

`lambda/stream/src/assistant/tools/internal-api.test.ts` pins the event SHAPE from
the TypeScript side; `build_proxy_event` below is its Python mirror and must stay in step.
"""
import json
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.indexes import PROJECTS_BY_TYPE_INDEX

# `FORWARDED_CLAIM_KEYS` in internal-api.ts: the only claims the stream forwards.
FORWARDED_CLAIM_KEYS = ('sub', 'cognito:groups', 'cognito:username', 'email')

OWNER_SUB = 'owner-sub'
VIEWER = {'sub': 'viewer-sub', 'cognito:username': 'vera', 'email': 'vera@example.com',
          # A real Cognito token carries more than the four forwarded keys.
          'token_use': 'id', 'aud': 'client-id', 'cognito:groups': ''}
STRANGER = {'sub': 'stranger-sub', 'cognito:username': 'sam', 'email': 'sam@example.com'}
PROJECT = 'proj_1'


def build_proxy_event(method: str, path: str, resource: str, path_parameters: dict, claims: dict) -> dict:
    """Python mirror of `buildProxyEvent` in internal-api.ts for a GET."""
    return {
        'httpMethod': method,
        'path': path,
        'resource': resource,
        'queryStringParameters': None,
        'pathParameters': dict(path_parameters) if path_parameters else None,
        'body': None,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {
            'authorizer': {'claims': {
                key: value for key, value in claims.items()
                if key in FORWARDED_CLAIM_KEYS and isinstance(value, str) and value
            }},
            'stage': 'v1',
        },
        'isBase64Encoded': False,
    }


def get_project_event(project_id: str, claims: dict) -> dict:
    """What the `get_project` server tool sends (core.ts)."""
    return build_proxy_event(
        'GET', f'/projects/{project_id}', '/projects/{project_id}',
        {'project_id': project_id}, claims,
    )


@pytest.fixture
def table():
    with mock_aws():
        table = pk_sk_table('assistant-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        table.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'name': 'Private one',
            'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': f'2026-01-01#{PROJECT}', 'status': 'active',
            'visibility': 'private', 'owner_sub': OWNER_SUB, 'owner_username': 'olivia',
            'members': {VIEWER['sub']: {'role': 'viewer', 'username': 'vera'}},
        })
        table.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRD#prd_1', 'document_id': 'prd_1',
                             'document_type': 'prd', 'title': 'Spec'})
        yield table


@pytest.fixture
def invoke(table, lambda_context):
    import projects
    import projects_handler

    def _invoke(event):
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=table),
            patch.object(projects, 'projects_table', table),
        ):
            response = projects_handler.lambda_handler(event, lambda_context)
        return response['statusCode'], json.loads(response['body'])

    return _invoke


def test_the_forwarded_claims_are_exactly_the_four_the_stream_forwards():
    claims = get_project_event(PROJECT, VIEWER)['requestContext']['authorizer']['claims']

    assert set(claims) == {'sub', 'cognito:username', 'email'}  # the blank groups claim is dropped
    assert 'token_use' not in claims
    assert 'aud' not in claims


def test_a_view_only_member_reads_the_project_and_is_told_it_cannot_edit(invoke):
    status, body = invoke(get_project_event(PROJECT, VIEWER))

    assert status == 200, body
    assert body['project']['access'] == {
        'role': 'viewer', 'can_view': True, 'can_edit': False, 'can_manage': False,
    }
    assert [doc['document_id'] for doc in body['documents']] == ['prd_1']


def test_a_non_member_on_a_private_project_gets_the_missing_project_404(invoke):
    status, body = invoke(get_project_event(PROJECT, STRANGER))
    missing_status, missing_body = invoke(get_project_event('proj_nope', STRANGER))

    assert (status, body) == (404, {'success': False, 'error': 'Project not found'})
    assert (missing_status, missing_body) == (status, body)


def test_a_view_only_member_is_refused_a_write_through_the_same_path(invoke):
    """The stream never sends a write, but if one slipped through the gate still says no."""
    event = build_proxy_event('PUT', f'/projects/{PROJECT}', '/projects/{project_id}',
                              {'project_id': PROJECT}, VIEWER)
    event['body'] = json.dumps({'name': 'renamed'})

    status, body = invoke(event)

    assert (status, body) == (403, {'success': False,
                                    'error': 'You do not have permission to edit this project'})


def test_an_event_without_a_subject_fails_closed(invoke):
    status, body = invoke(get_project_event(PROJECT, {'cognito:username': 'nobody'}))

    assert status == 403
    assert body == {'success': False, 'error': 'Caller identity could not be determined'}
