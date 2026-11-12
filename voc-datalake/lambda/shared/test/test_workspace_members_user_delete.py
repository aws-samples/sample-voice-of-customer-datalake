"""shared/workspace_members.py: a deleted user's memberships (the users API, DELETE /users/{username}), moto-backed.

Every ``USER#{sub}`` row's workspace loses the user's ``MEMBER#`` and ``USER#`` rows in one transaction, each after its
``member_removed`` audit row (``via: user_deleted``); the last admin of a workspace is refused (409) unless the caller
is a platform admin; nothing is written before every workspace has been checked.
"""
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.exceptions import ConflictError
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace_members import (
    CHANGED_MEANWHILE,
    MEMBER_REMOVED,
    VIA_USER_DELETED,
    last_admin_message,
    plan_user_removal,
    remove_user_memberships,
)

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
NAMES = {WS_A: 'Acme Outfitters', WS_B: 'Harbor Labs'}
GONE = 'sub-gus'
ACTOR = 'sub-root'


@pytest.fixture
def table() -> Iterator:
    with mock_aws():
        workspaces = create_pk_sk_table('workspaces')
        for ws, name in NAMES.items():
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': name, 'slug': ws[-4:].lower(),
                                      'status': 'active'})
        yield workspaces


def _seed(table, ws, sub, role):
    table.put_item(Item={'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}', 'role': role, 'email': f'{sub}@example.com'})
    table.put_item(Item={'pk': f'USER#{sub}', 'sk': f'WS#{ws}', 'name': NAMES[ws], 'slug': 'slug', 'role': role})


def _rows(table):
    return {(row['pk'], row['sk']) for row in table.scan()['Items'] if not str(row['pk']).startswith('AUDIT#')}


def _audits(table, ws):
    return table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'AUDIT#WS#{ws}'})['Items']


def _never() -> bool:
    raise AssertionError('the platform-admin check runs only for a user with a membership')


def _no() -> bool:
    return False


def test_a_platform_admin_deleting_any_member_is_recorded_as_one(table):
    _seed(table, WS_A, GONE, 'editor')
    remove_user_memberships(table, plan_user_removal(table, GONE, caller_is_platform_admin=lambda: True), ACTOR)
    [row] = _audits(table, WS_A)
    assert (row['platform_admin'], row['left_without_admin']) == (True, False)


def test_every_membership_goes_with_its_audit_row_and_meta_stays(table):
    _seed(table, WS_A, GONE, 'editor')
    _seed(table, WS_B, GONE, 'admin')
    _seed(table, WS_B, 'sub-ada', 'admin')
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=_no)
    assert remove_user_memberships(table, removal, ACTOR) == 2
    assert _rows(table) == {(f'WS#{WS_A}', 'META'), (f'WS#{WS_B}', 'META'), (f'WS#{WS_B}', 'MEMBER#sub-ada'),
                            ('USER#sub-ada', f'WS#{WS_B}')}
    [row_a] = _audits(table, WS_A)
    assert {k: row_a[k] for k in ('kind', 'via', 'actor', 'target', 'role_before', 'platform_admin',
                                  'left_without_admin')} == {
        'kind': MEMBER_REMOVED, 'via': VIA_USER_DELETED, 'actor': ACTOR, 'target': GONE, 'role_before': 'editor',
        'platform_admin': False, 'left_without_admin': False}
    assert 'role_after' not in row_a
    [row_b] = _audits(table, WS_B)
    assert (row_b['role_before'], row_b['left_without_admin']) == ('admin', False)


def test_a_user_in_no_workspace_writes_nothing(table):
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=_never)
    assert removal.memberships == ()
    assert remove_user_memberships(table, removal, ACTOR) == 0
    assert _audits(table, WS_A) == []


def test_the_last_admin_is_refused_before_anything_is_written(table):
    _seed(table, WS_A, GONE, 'editor')
    _seed(table, WS_B, GONE, 'admin')
    with pytest.raises(ConflictError) as refused:
        plan_user_removal(table, GONE, caller_is_platform_admin=lambda: False)
    assert str(refused.value) == last_admin_message(['Harbor Labs'])
    assert 'Harbor Labs' in str(refused.value)
    assert (f'WS#{WS_A}', f'MEMBER#{GONE}') in _rows(table)
    assert _audits(table, WS_A) == _audits(table, WS_B) == []


def test_a_platform_admin_may_leave_a_workspace_without_an_admin(table):
    _seed(table, WS_B, GONE, 'admin')
    _seed(table, WS_B, 'sub-vic', 'viewer')
    asked = MagicMock(return_value=True)
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=asked)
    asked.assert_called_once_with()
    remove_user_memberships(table, removal, ACTOR)
    assert (f'WS#{WS_B}', f'MEMBER#{GONE}') not in _rows(table)
    assert table.get_item(Key={'pk': f'WS#{WS_B}', 'sk': 'MEMBER#sub-vic'})['Item']['role'] == 'viewer'
    [row] = _audits(table, WS_B)
    assert (row['platform_admin'], row['left_without_admin']) == (True, True)


def test_the_refusal_names_up_to_three_workspaces():
    assert last_admin_message(['A']).startswith('This user is the last admin of the workspace "A": ')
    assert 'the workspaces "A", "B", "C" and 2 more:' in last_admin_message(['A', 'B', 'C', 'D', 'E'])
    assert 'an unnamed workspace' in last_admin_message([''])


def test_an_admin_with_another_admin_checks_that_one_in_its_transaction(table):
    _seed(table, WS_A, GONE, 'admin')
    _seed(table, WS_A, 'sub-ada', 'admin')
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=_no)
    client = table.meta.client
    with patch.object(client, 'transact_write_items', wraps=client.transact_write_items) as tx:
        remove_user_memberships(table, removal, ACTOR)
    [call] = tx.call_args_list
    items = call.kwargs['TransactItems']
    assert [next(iter(item)) for item in items] == ['Delete', 'Delete', 'ConditionCheck']
    assert items[0]['Delete']['Key'] == {'pk': f'WS#{WS_A}', 'sk': f'MEMBER#{GONE}'}
    assert items[1]['Delete']['Key'] == {'pk': f'USER#{GONE}', 'sk': f'WS#{WS_A}'}
    assert items[2]['ConditionCheck']['Key'] == {'pk': f'WS#{WS_A}', 'sk': 'MEMBER#sub-ada'}


def test_the_other_admin_demoted_meanwhile_is_a_409(table):
    _seed(table, WS_A, GONE, 'admin')
    _seed(table, WS_A, 'sub-ada', 'admin')
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=_no)
    table.update_item(Key={'pk': f'WS#{WS_A}', 'sk': 'MEMBER#sub-ada'}, UpdateExpression='SET #r = :v',
                      ExpressionAttributeNames={'#r': 'role'}, ExpressionAttributeValues={':v': 'viewer'})
    with pytest.raises(ConflictError, match=CHANGED_MEANWHILE):
        remove_user_memberships(table, removal, ACTOR)
    assert (f'WS#{WS_A}', f'MEMBER#{GONE}') in _rows(table)


def test_a_role_changed_meanwhile_is_a_409(table):
    _seed(table, WS_A, GONE, 'editor')
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=_no)
    table.update_item(Key={'pk': f'WS#{WS_A}', 'sk': f'MEMBER#{GONE}'}, UpdateExpression='SET #r = :v',
                      ExpressionAttributeNames={'#r': 'role'}, ExpressionAttributeValues={':v': 'admin'})
    with pytest.raises(ConflictError, match=CHANGED_MEANWHILE):
        remove_user_memberships(table, removal, ACTOR)


def test_an_inverse_row_without_its_member_row_is_removed_too(table):
    table.put_item(Item={'pk': f'USER#{GONE}', 'sk': f'WS#{WS_A}', 'name': NAMES[WS_A], 'slug': 'x', 'role': 'viewer'})
    table.put_item(Item={'pk': f'USER#{GONE}', 'sk': 'WS#not-a-workspace', 'name': 'x', 'slug': 'x', 'role': 'x'})
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=_no)
    assert [(m.ws, m.role) for m in removal.memberships] == [(WS_A, None)]
    remove_user_memberships(table, removal, ACTOR)
    assert (f'USER#{GONE}', f'WS#{WS_A}') not in _rows(table)
    assert 'role_before' not in _audits(table, WS_A)[0]


def test_an_audit_row_that_cannot_be_written_removes_nothing(table):
    _seed(table, WS_A, GONE, 'editor')
    removal = plan_user_removal(table, GONE, caller_is_platform_admin=_no)
    denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'x'}}, 'PutItem')
    with patch.object(table, 'put_item', side_effect=denied), pytest.raises(ClientError):
        remove_user_memberships(table, removal, ACTOR)
    assert (f'WS#{WS_A}', f'MEMBER#{GONE}') in _rows(table)
