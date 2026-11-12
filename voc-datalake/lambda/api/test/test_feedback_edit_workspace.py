"""PUT /feedback/{id}/category and /dimensions on both paths (docs/multi-workspace.md, "Request flow").

With ``X-Workspace-Id`` the edit finds, reads and updates the workspace's own item through ``ws_table``
(``gsi2pk`` to ``WS#{ws}#CATEGORY#…``), keeps its previous version under the workspace and bumps the workspace's
data_version; a viewer is refused (403), a non-member gets the one 404, another workspace's id is not found, and
the deployment's copy of the same source item is never touched. Without the header nothing changes.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from category_access_fixtures import CATEGORIES_CONFIG
from feedback_edit_fixtures import ADMIN_CLAIMS, ITEM
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event, seeded_category_edit_tables

import feedback_edit_handler
from shared.workspace_request import RequestWorkspace

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
EDITOR = {'sub': 'sub-ed', 'cognito:groups': 'users', 'cognito:username': 'ed'}
VIEWER = {'sub': 'sub-vi', 'cognito:groups': 'users', 'cognito:username': 'vi'}
MEMBER_B = {'sub': 'sub-bo', 'cognito:groups': 'users', 'cognito:username': 'bo'}
PREFIX = f'WS#{WS_A}#'
WORKSPACE_ITEM = {**ITEM, 'pk': f'{PREFIX}SOURCE#web', 'gsi4pk': f'{PREFIX}FEEDBACK#f1',
                  'gsi2pk': f'{PREFIX}CATEGORY#delivery'}
ONLY_B = {**ITEM, 'pk': f'WS#{WS_B}#SOURCE#web', 'sk': 'FEEDBACK#only-b', 'feedback_id': 'only-b',
          'gsi4pk': f'WS#{WS_B}#FEEDBACK#only-b', 'gsi2pk': f'WS#{WS_B}#CATEGORY#delivery'}


@pytest.fixture
def world() -> Iterator[tuple[Any, Any, RequestWorkspace, Any]]:
    with mock_aws():
        feedback, aggregates = seeded_category_edit_tables(ITEM, CATEGORIES_CONFIG)
        feedback.put_item(Item=WORKSPACE_ITEM)
        feedback.put_item(Item=ONLY_B)
        workspaces = pk_sk_table('workspaces')
        for ws, member, role in ((WS_A, EDITOR, 'editor'), (WS_A, VIEWER, 'viewer'), (WS_B, MEMBER_B, 'admin')):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active', 'name': ws, 'slug': ws[-6:]})
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{member['sub']}", 'role': role})
        resolver = RequestWorkspace(table=lambda: workspaces, confirm_platform_admin=lambda _event: False)
        yield feedback, aggregates, resolver, workspaces


def _put(world, lambda_context, path: str, body: dict, *, claims: dict, ws: str | None,
         feedback_id: str = 'f1') -> tuple[int, Any]:
    feedback, aggregates, resolver, _workspaces = world
    event = rest_event('PUT', f'/feedback/{feedback_id}/{path}', claims=claims, body=body,
                       path_params={'id': feedback_id})
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    with patch.object(feedback_edit_handler, '_workspace', resolver):
        return invoke(feedback_edit_handler, event, lambda_context, feedback=feedback, aggregates=aggregates)


def _stored(world, item: dict) -> dict:
    return world[0].get_item(Key={'pk': item['pk'], 'sk': item['sk']})['Item']


class TestACategoryEditInAWorkspace:
    def test_it_moves_the_workspaces_item_only(self, world, lambda_context):
        with patch('shared.feedback_category.keep_silver_version') as keep:
            status, body = _put(world, lambda_context, 'category', {'category': 'billing'}, claims=EDITOR, ws=WS_A)

        assert status == 200, body
        stored = _stored(world, WORKSPACE_ITEM)
        assert (stored['category'], stored['gsi2pk']) == ('billing', f'{PREFIX}CATEGORY#billing')
        assert _stored(world, ITEM)['category'] == 'delivery'  # the deployment's copy untouched
        assert keep.call_args.kwargs['scope'].ws == WS_A  # kept under ws/{ws}/silver/
        versions = {row['pk']: row['v'] for row in world[1].scan()['Items'] if row['sk'] == 'data_version'}
        assert versions == {f'{PREFIX}METRIC#meta': 1}

    def test_without_the_header_the_deployments_item_moves(self, world, lambda_context):
        status, _ = _put(world, lambda_context, 'category', {'category': 'billing'}, claims=ADMIN_CLAIMS, ws=None)

        assert status == 200
        assert (_stored(world, ITEM)['gsi2pk'], _stored(world, WORKSPACE_ITEM)['category']) == (
            'CATEGORY#billing', 'delivery')

    def test_a_viewer_is_refused(self, world, lambda_context):
        status, body = _put(world, lambda_context, 'category', {'category': 'billing'}, claims=VIEWER, ws=WS_A)

        assert status == 403, body
        assert _stored(world, WORKSPACE_ITEM)['category'] == 'delivery'

    @pytest.mark.parametrize(('claims', 'ws'), [(ADMIN_CLAIMS, WS_A), (MEMBER_B, WS_A)])
    def test_a_non_member_gets_the_one_404(self, world, lambda_context, claims, ws):
        status, body = _put(world, lambda_context, 'category', {'category': 'billing'}, claims=claims, ws=ws)

        assert (status, body['error']) == (404, 'Workspace not found')
        assert _stored(world, WORKSPACE_ITEM)['category'] == 'delivery'

    def test_another_workspaces_id_is_not_found(self, world, lambda_context):
        status, body = _put(world, lambda_context, 'category', {'category': 'billing'}, claims=EDITOR, ws=WS_A,
                            feedback_id='only-b')

        assert (status, body['error']) == (404, 'Feedback not found')
        assert _stored(world, ONLY_B)['category'] == 'delivery'


class TestTheRoleIsReadFromTheTable:
    def test_an_editor_demoted_a_moment_ago_cannot_edit(self, world, lambda_context):
        """The edit never trusts the 30 s membership cache: a role changed after a cached read is the one used."""
        _feedback, _aggregates, resolver, workspaces = world
        assert resolver.context({'headers': {'X-Workspace-Id': WS_A},
                                 'requestContext': {'authorizer': {'claims': EDITOR}}}).role == 'editor'  # cached
        workspaces.put_item(Item={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{EDITOR['sub']}", 'role': 'viewer'})

        status, _ = _put(world, lambda_context, 'category', {'category': 'billing'}, claims=EDITOR, ws=WS_A)

        assert status == 403
        assert _stored(world, WORKSPACE_ITEM)['category'] == 'delivery'

    def test_an_editor_removed_a_moment_ago_gets_the_one_404(self, world, lambda_context):
        _feedback, _aggregates, resolver, workspaces = world
        resolver.context({'headers': {'X-Workspace-Id': WS_A}, 'requestContext': {'authorizer': {'claims': EDITOR}}})
        workspaces.delete_item(Key={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{EDITOR['sub']}"})

        status, body = _put(world, lambda_context, 'dimensions', {'tags': ['x']}, claims=EDITOR, ws=WS_A)

        assert (status, body['error']) == (404, 'Workspace not found')


@pytest.mark.parametrize(('path', 'body'), [('category', {'category': ''}), ('dimensions', {'dimensions': 'x'}),
                                            ('category', {})])
def test_a_non_member_gets_the_one_404_before_the_body_is_checked(world, lambda_context, path, body):
    status, answer = _put(world, lambda_context, path, body, claims=MEMBER_B, ws=WS_A)

    assert (status, answer) == (404, {'success': False, 'error': 'Workspace not found'})


def test_a_dimensions_edit_writes_the_workspaces_item(world, lambda_context):
    status, body = _put(world, lambda_context, 'dimensions', {'tags': ['Refund']}, claims=EDITOR, ws=WS_A)

    assert status == 200, body
    assert _stored(world, WORKSPACE_ITEM)['tags'] == ['Refund']
    assert 'tags' not in _stored(world, ITEM)


def test_the_writer_refuses_a_key_outside_the_workspace(world):
    """The edit's update goes through ``ws_table``: a key of another scope never reaches DynamoDB."""
    from shared.ws_repo import OutOfScopeError, scope_of

    class _Context:
        ws = WS_A

    writer = feedback_edit_handler._ItemWriter(scope_of(_Context()), world[0])
    with pytest.raises(OutOfScopeError):
        writer.update_item(Key={'pk': ITEM['pk'], 'sk': ITEM['sk']}, UpdateExpression='SET #c = :c',
                           ExpressionAttributeNames={'#c': 'category'}, ExpressionAttributeValues={':c': 'x'})
