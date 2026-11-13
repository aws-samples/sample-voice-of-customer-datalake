"""The caller's conversations inside a workspace (api/chat_handler.py; shared/conversations.py)."""
from __future__ import annotations

from unittest.mock import patch

import boto3
import pytest
from cross_workspace_worlds import ADA, ADA_MEMBER_ONLY, WS_A, WS_B, chat_world

from memory.scanner import handler as scanner


def _rows() -> dict[str, list[str]]:
    table = boto3.resource('dynamodb', region_name='us-east-1').Table('conversations')
    rows: dict[str, list[str]] = {}
    for item in table.scan(ConsistentRead=True)['Items']:
        rows.setdefault(str(item['pk']), []).append(str(item['sk']))
    return rows


def test_a_save_inside_a_workspace_lands_in_the_callers_partition_there(lambda_context):
    with chat_world(lambda_context) as world:
        status, _ = world.call('POST', '/chat/conversations/conv_new', ws=WS_A,
                               body={'title': 'Trip notes', 'messages': []})
        assert status == 200
        assert 'CONV#conv_new' in _rows()[f'WS#{WS_A}#USER#sub-ada']
        assert 'CONV#conv_new' not in _rows()['USER#sub-ada']
        status, _ = world.call('POST', '/chat/conversations/conv_old', ws=None,
                               body={'title': 'Before', 'messages': []})
        assert status == 200
        assert 'CONV#conv_old' in _rows()['USER#sub-ada']


def test_the_list_inside_a_workspace_is_only_the_callers_conversations_there(lambda_context):
    with chat_world(lambda_context) as world:
        status, body = world.call('GET', '/chat/conversations/_list', ws=WS_A)
        assert status == 200
        assert [c['id'] for c in body['conversations']] == ['conv_a']
        assert body['conversations'][0]['title'] == 'alderbrook returns'
        status, body = world.call('GET', '/chat/conversations/_list', ws=None)
        assert [c['title'] for c in body['conversations']] == ['Before workspaces']


@pytest.mark.parametrize('caller', [ADA, ADA_MEMBER_ONLY, {**ADA, 'cognito:groups': '[platform-admins, users]'}],
                         ids=['deployment-admin', 'member', 'platform-admin'])
def test_a_workspace_the_caller_is_not_a_member_of_is_the_one_404(lambda_context, caller):
    """Without a platform admin's elevation: the stream Lambda, which writes the same rows, checks membership only."""
    with chat_world(lambda_context) as world:
        before = _rows()
        assert world.call('POST', '/chat/conversations/conv_new', ws=WS_B, caller=caller,
                          body={'title': 'x', 'messages': []}) == (404, {'success': False, 'error': 'Workspace not found'})
        assert _rows() == before


def test_a_live_platform_admin_is_not_elevated_into_a_workspace_they_are_not_a_member_of(lambda_context):
    """elevate=False, even for a platform admin the live check would confirm: never consulted, the one 404."""
    from shared import platform_admin_gate
    from shared.test.cognito_doubles import live_cognito

    caller = {**ADA, 'cognito:groups': '[platform-admins, users]'}
    cognito = live_cognito(groups=('platform-admins', 'users'), sub='sub-ada')
    with chat_world(lambda_context) as world, patch.object(platform_admin_gate, 'get_cognito_idp_client',
                                                            return_value=cognito):
        before = _rows()
        assert world.call('GET', '/chat/conversations/_list', ws=WS_B, caller=caller) == (
            404, {'success': False, 'error': 'Workspace not found'})
        assert _rows() == before
    cognito.admin_list_groups_for_user.assert_not_called()


def test_a_delete_inside_a_workspace_is_audited_with_its_workspace(lambda_context):
    with chat_world(lambda_context) as world:
        assert world.call('DELETE', '/chat/conversations/conv_a', ws=WS_A)[0] == 200
        table = boto3.resource('dynamodb', region_name='us-east-1').Table('conversations')
        [audit] = [i for i in table.scan()['Items'] if i['pk'] == 'AUDIT#delete']
        assert audit['target'] == {'conversation_id': 'conv_a', 'workspace': WS_A}
        assert 'CONV#conv_a' in _rows()['USER#sub-ada']


def test_the_memory_scanner_mines_a_workspace_conversation_in_its_workspace():
    """A person's own conversation as before; one kept in a workspace is mined there (memory/test/
    test_extraction_workspaces.py), never as the deployment's."""
    row = {'sk': 'CONV#conv_a', 'message_count': 3, 'updated_at': '2026-11-01T00:00:00+00:00'}
    own = scanner._session_from_row({**row, 'pk': 'USER#sub-ada'}) or {}
    assert (own.get('owner_sub'), own.get('workspace')) == ('sub-ada', None)
    kept = scanner._session_from_row({**row, 'pk': f'WS#{WS_A}#USER#sub-ada'}) or {}
    assert (kept.get('owner_sub'), getattr(kept.get('workspace'), 'ws', None)) == ('sub-ada', WS_A)


def _assistant_body(conversation_id: str, base_revision: int) -> dict:
    return {'kind': 'assistant', 'id': conversation_id, 'title': 'Returns', 'messages': [], 'page': {},
            'pending': [], 'createdAt': '2026-11-01T00:00:00+00:00', 'baseRevision': base_revision}


def test_an_assistant_save_inside_a_workspace_keeps_its_revision_rules(lambda_context):
    """The web app's own save shape: read back, revision-conditioned, through the workspace's view of the table."""
    with chat_world(lambda_context) as world:
        status, _ = world.call('POST', '/chat/conversations/conv_a', ws=WS_A, body=_assistant_body('conv_a', 1))
        assert status == 200
        table = boto3.resource('dynamodb', region_name='us-east-1').Table('conversations')
        stored = table.get_item(Key={'pk': f'WS#{WS_A}#USER#sub-ada', 'sk': 'CONV#conv_a'}).get('Item') or {}
        assert stored.get('title') == 'Returns'
        table.update_item(Key={'pk': f'WS#{WS_A}#USER#sub-ada', 'sk': 'CONV#conv_a'},
                          UpdateExpression='SET revision = :r', ExpressionAttributeValues={':r': 5})
        status, _ = world.call('POST', '/chat/conversations/conv_a', ws=WS_A, body=_assistant_body('conv_a', 1))
        assert status == 409


def test_a_credential_has_no_conversations_inside_a_workspace(lambda_context):
    with chat_world(lambda_context) as world:
        caller = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-ada', 'cognito:groups': ''}
        assert world.call('GET', '/chat/conversations/_list', ws=WS_A, caller=caller) == (
            404, {'success': False, 'error': 'Workspace not found'})
