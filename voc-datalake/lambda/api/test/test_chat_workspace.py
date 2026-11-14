"""The caller's conversations inside a workspace (api/chat_handler.py; shared/conversations.py)."""
from __future__ import annotations

import sys
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from cross_workspace_worlds import ADA, ADA_MEMBER_ONLY, B_MARK, WS_A, WS_B, chat_world

from memory.scanner import handler as scanner
from shared.test.repo_paths import load_module_from_path, repo_root


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


# ── The workspace's list of conversation owners (7.19.00): WS#{ws}#CONVERSANTS / {sub} ──

_CONVERSANTS = f'WS#{WS_A}#CONVERSANTS'
#: A's viewer, who stays a member.
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}


def _conversations_table():
    return boto3.resource('dynamodb', region_name='us-east-1').Table('conversations')


def _conversants() -> dict[str, dict]:
    """The owner rows of workspace A, by sub, read the way the export and the delete will: one Query on the
    workspace's own partition, knowing only its id."""
    items = _conversations_table().query(KeyConditionExpression=Key('pk').eq(_CONVERSANTS), ConsistentRead=True)['Items']
    return {str(item['sk']): item for item in items}


def _second_body(body: dict) -> dict:
    """The same save shape for another conversation (an assistant save names its id in the body too)."""
    return {**body, 'id': 'conv_two'} if 'kind' in body else body


@pytest.mark.parametrize('body', [{'title': 'Trip notes', 'messages': []}, _assistant_body('conv_new', 0)],
                         ids=['legacy', 'assistant'])
def test_a_first_save_in_a_workspace_lists_its_owner_once(lambda_context, body):
    with chat_world(lambda_context) as world:
        assert _conversants() == {}
        assert world.call('POST', '/chat/conversations/conv_new', ws=WS_A, body=body)[0] == 200
        listed = _conversants()
        assert list(listed) == ['sub-ada']
        row = listed['sub-ada']
        assert set(row) == {'pk', 'sk', 'first_at'}
        assert (row['pk'], row['sk']) == (_CONVERSANTS, 'sub-ada')
        assert world.call('POST', '/chat/conversations/conv_new', ws=WS_A, body=body)[0] == 200
        assert world.call('POST', '/chat/conversations/conv_two', ws=WS_A, body=_second_body(body))[0] == 200
        assert _conversants() == {'sub-ada': row}


def test_a_save_outside_a_workspace_lists_nobody(lambda_context):
    with chat_world(lambda_context) as world:
        status, _ = world.call('POST', '/chat/conversations/conv_own', ws=None, body={'title': 'Mine', 'messages': []})
        assert status == 200
        assert [pk for pk in _rows() if pk.endswith('#CONVERSANTS')] == []


def test_a_refused_save_lists_nobody(lambda_context):
    """A body the route refuses (an id that does not match the path) writes neither the list nor the conversation."""
    with chat_world(lambda_context) as world:
        status, _ = world.call('POST', '/chat/conversations/conv_new', ws=WS_A,
                               body={'id': 'conv_other', 'title': 'x', 'messages': []})
        assert status == 400
        assert _conversants() == {}


def test_the_owner_is_listed_before_the_conversation_is_written(lambda_context):
    """A fault listing the owner fails the save, and no conversation row is stored unlisted."""
    import chat_handler

    fault = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}}, 'PutItem')
    with chat_world(lambda_context) as world, patch.object(chat_handler, 'record_conversant', side_effect=fault):
        before = _rows()
        with pytest.raises(ClientError, match='ProvisionedThroughputExceeded'):
            world.call('POST', '/chat/conversations/conv_new', ws=WS_A, body={'title': 'x', 'messages': []})
        assert _rows() == before


def test_a_removed_members_conversations_stay_findable_through_the_list(lambda_context):
    """The member saves, is removed (their MEMBER# row deleted) and can no longer write there; their conversations
    are kept, and the workspace's list still names their partition."""
    with chat_world(lambda_context) as world:
        status, _ = world.call('POST', '/chat/conversations/conv_new', ws=WS_A, body={'title': 'Kept', 'messages': []})
        assert status == 200
        workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        workspaces.delete_item(Key={'pk': f'WS#{WS_A}', 'sk': 'MEMBER#sub-ada'})
        status, _ = world.call('POST', '/chat/conversations/conv_late', ws=WS_A, body={'title': 'Late', 'messages': []})
        assert status == 404
        # A member who stays saves after the removal: the list then names both, the former member first listed.
        status, _ = world.call('POST', '/chat/conversations/conv_vic', ws=WS_A, caller=VIC,
                               body={'title': 'Returns desk', 'messages': []})
        assert status == 200
        listed = _conversants()
        assert sorted(listed) == ['sub-ada', 'sub-vic']
        assert listed['sub-ada']['first_at'] <= listed['sub-vic']['first_at']
        # Every conversation of the workspace is reached through the list, as a whole-table read finds them.
        through_list = {(sub, str(item['sk'])) for sub in listed for item in _conversations_table().query(
            KeyConditionExpression=Key('pk').eq(f'WS#{WS_A}#USER#{sub}'))['Items']}
        everywhere = {(pk.removeprefix(f'WS#{WS_A}#USER#'), sk) for pk, sks in _rows().items()
                      if pk.startswith(f'WS#{WS_A}#USER#') for sk in sks}
        assert through_list == everywhere == {('sub-ada', 'CONV#conv_a'), ('sub-ada', 'CONV#conv_new'),
                                              ('sub-vic', 'CONV#conv_vic')}
        # The backfill (a dry run) finds nobody of A missing (B's seeded owner, never saved through a route, is).
        backfill = load_module_from_path('backfill_conversants_removed_member',
                                         repo_root() / 'scripts' / 'conversations' / 'backfill_conversants.py')
        missing: list[str] = []
        try:
            backfill.run(_conversations_table(), apply=False, out=missing.append)
        finally:
            sys.modules.pop(backfill.__name__, None)
        assert [line.split()[:2] for line in missing] == [[WS_B, f'sub-{B_MARK}-bea']]
