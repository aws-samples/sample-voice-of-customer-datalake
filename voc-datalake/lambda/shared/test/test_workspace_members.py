"""shared/workspace_members.py: a workspace's members (docs/multi-workspace.md, "Roles" and "Invites"), moto-backed."""
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.exceptions import AuthorizationError, ConflictError, NotFoundError, ValidationError
from shared.feedback_cursor import encode_key_cursor
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import NOT_FOUND, WorkspaceContext
from shared.workspace_members import (
    ALREADY_MEMBER,
    AMBIGUOUS_EMAIL,
    CHANGED_MEANWHILE,
    EMAIL_ELSEWHERE,
    LAST_ADMIN,
    MAX_COGNITO_FILLS,
    MEMBER_ADDED,
    MEMBER_LEFT,
    MEMBER_NOT_FOUND,
    MEMBER_REMOVED,
    MEMBER_ROLE_CHANGED,
    NEW_ACCOUNT_ADMINS_ONLY,
    NO_LONGER_ADMIN,
    Account,
    MemberAccountError,
    NewMember,
    add_member,
    change_role,
    find_or_create_account,
    list_members,
    member_sub,
    parse_new_member,
    parse_role_change,
    remove_member,
)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
POOL = 'us-east-1_pool'
CONTEXT = WorkspaceContext(ws=WS, role='admin', name='Acme Outfitters', slug='acme', platform_admin=False)
ADA = 'sub-ada'
NEW = Account(sub='sub-nia', email='nia@example.com', name='Nia Park', created=False)
DENIED = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'table arn'}}, 'PutItem')


#: The workspace's META row, as resolve_workspace reads it (the context above is what it answered).
META = {'pk': f'WS#{WS}', 'sk': 'META', 'name': CONTEXT.name, 'slug': CONTEXT.slug, 'status': 'active'}


@pytest.fixture
def table() -> Iterator:
    """The workspace with ada as its one admin."""
    with mock_aws():
        workspaces = create_pk_sk_table('workspaces')
        workspaces.put_item(Item=META)
        _seed(workspaces, ADA, 'admin')
        yield workspaces


def _seed(table, sub, role, **row):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': f'MEMBER#{sub}', 'role': role, **row})
    table.put_item(Item={'pk': f'USER#{sub}', 'sk': f'WS#{WS}', 'name': 'Acme Outfitters', 'slug': 'acme',
                         'role': role})


def _member_row(table, sub):
    return table.get_item(Key={'pk': f'WS#{WS}', 'sk': f'MEMBER#{sub}'}).get('Item')


def _user_row(table, sub):
    return table.get_item(Key={'pk': f'USER#{sub}', 'sk': f'WS#{WS}'}).get('Item')


def _audits(table):
    return table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']


def _tx_items(table, action):
    """Run ``action`` with the transaction recorded; its TransactItems."""
    client = table.meta.client
    with patch.object(client, 'transact_write_items', wraps=client.transact_write_items) as tx:
        action()
    [recorded] = tx.call_args_list
    assert len(recorded.kwargs['ClientRequestToken']) == 32
    return recorded.kwargs['TransactItems']


# ── Validation ───────────────────────────────────────────────────────────────

def test_a_valid_add_keeps_the_email_as_written():
    assert parse_new_member({'email': ' Nia@Example.com ', 'role': 'editor'}) == NewMember('Nia@Example.com', 'editor')


@pytest.mark.parametrize(('body', 'message'), [
    ({'role': 'viewer'}, 'email must be a string'),
    ({'email': 'not-an-address', 'role': 'viewer'}, 'not a valid address'),
    ({'email': 'a"b@example.com', 'role': 'viewer'}, 'not a valid address'),
    ({'email': 'nia@' + chr(0x212A) + 'ey.com', 'role': 'viewer'}, 'not a valid address'),  # the Kelvin sign
    ({'email': 'nia@example.com'}, 'role must be'),
    ({'email': 'nia@example.com', 'role': 'owner'}, 'role must be'),
    ({'email': 'nia@example.com', 'role': 'viewer', 'name': 'x'}, 'Unknown field'),
], ids=['no-email', 'bad-email', 'quote', 'kelvin-sign', 'no-role', 'bad-role', 'unknown-field'])
def test_a_bad_add_is_a_400(body, message):
    with pytest.raises(ValidationError, match=message):
        parse_new_member(body)


def test_a_role_change_takes_one_of_the_three_roles():
    assert parse_role_change({'role': 'viewer'}) == 'viewer'
    for body in ({'role': 'platform-admin'}, {'role': 'admin', 'sub': 'x'}):
        with pytest.raises(ValidationError):
            parse_role_change(body)


@pytest.mark.parametrize('value', ['', 'a/b', 'x' * 65, 'sub ada', 'sub"'])
def test_a_path_sub_that_cannot_be_a_member_is_the_members_404(value):
    with pytest.raises(NotFoundError, match=MEMBER_NOT_FOUND):
        member_sub(value)


# ── Cognito: find or create the account ──────────────────────────────────────

def _user(sub, email, **attrs):
    return {'Username': f'u-{sub}', 'Attributes': [{'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': email},
                                                    *({'Name': k, 'Value': v} for k, v in attrs.items())]}


def test_an_email_with_an_account_is_that_account():
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': [_user('sub-nia', 'nia@example.com', name='Nia Park')]}
    # An existing account needs no right to create one.
    assert find_or_create_account(cognito, POOL, 'nia@example.com', may_create=False) == NEW
    cognito.list_users.assert_called_once_with(UserPoolId=POOL, Filter='email = "nia@example.com"', Limit=2)
    cognito.admin_create_user.assert_not_called()


def test_a_new_email_without_the_right_to_create_an_account_is_a_403_and_creates_nothing():
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': []}
    with pytest.raises(AuthorizationError, match=NEW_ACCOUNT_ADMINS_ONLY):
        find_or_create_account(cognito, POOL, 'new@example.com', may_create=False)
    cognito.admin_create_user.assert_not_called()


def test_a_name_is_built_from_the_given_and_family_names_when_there_is_no_name():
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': [_user('sub-nia', 'n@example.com', given_name='Nia',
                                                       family_name='Park')]}
    assert find_or_create_account(cognito, POOL, 'n@example.com', may_create=True).name == 'Nia Park'


def test_a_new_email_gets_an_account_with_the_temporary_password_emailed():
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': []}
    cognito.admin_create_user.return_value = {'User': _user('sub-new', 'new@example.com')}
    account = find_or_create_account(cognito, POOL, 'new@example.com', may_create=True)
    assert account == Account(sub='sub-new', email='new@example.com', name='', created=True)
    kwargs = cognito.admin_create_user.call_args.kwargs
    assert (kwargs['UserPoolId'], kwargs['DesiredDeliveryMediums']) == (POOL, ['EMAIL'])
    assert kwargs['UserAttributes'] == [{'Name': 'email', 'Value': 'new@example.com'},
                                        {'Name': 'email_verified', 'Value': 'true'}]
    assert 'MessageAction' not in kwargs  # Cognito sends the invitation (the users API's path)


def test_two_accounts_with_the_email_are_a_409():
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': [_user('a', 'x@example.com'), _user('b', 'x@example.com')]}
    with pytest.raises(ConflictError, match=AMBIGUOUS_EMAIL):
        find_or_create_account(cognito, POOL, 'x@example.com', may_create=True)


@pytest.mark.parametrize('code', ['AliasExistsException', 'UsernameExistsException'])
def test_an_email_cognito_holds_for_another_account_is_a_409(code):
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': []}
    cognito.admin_create_user.side_effect = ClientError({'Error': {'Code': code, 'Message': 'pool'}}, 'AdminCreateUser')
    with pytest.raises(ConflictError, match=EMAIL_ELSEWHERE):
        find_or_create_account(cognito, POOL, 'x@example.com', may_create=True)


def test_any_other_cognito_error_propagates():
    cognito = MagicMock()
    cognito.list_users.side_effect = ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'p'}},
                                                 'ListUsers')
    with pytest.raises(ClientError):
        find_or_create_account(cognito, POOL, 'x@example.com', may_create=True)


def test_an_account_without_a_sub_is_a_fault():
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': []}
    cognito.admin_create_user.return_value = {'User': {'Attributes': [{'Name': 'email', 'Value': 'x@example.com'}]}}
    with pytest.raises(MemberAccountError):
        find_or_create_account(cognito, POOL, 'x@example.com', may_create=True)


# ── List ─────────────────────────────────────────────────────────────────────

def test_the_list_is_one_page_of_member_rows_with_the_stored_emails(table):
    _seed(table, 'sub-edi', 'editor', email='edi@example.com', name='Edi Lund', invited_by=ADA, joined_at='t1')
    _seed(table, 'sub-vic', 'viewer', email='vic@example.com', name='', invited_by=ADA, joined_at='t2')
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': [_user(ADA, 'ada@example.com', name='Ada Moss')]}
    first, cursor = list_members(table, WS, limit=2, cursor=None, cognito=cognito, user_pool_id=POOL)
    # The creator's row (6.09.00) holds no email: filled from Cognito by its sub.
    assert first == [
        {'sub': ADA, 'role': 'admin', 'email': 'ada@example.com', 'name': 'Ada Moss', 'invited_by': '', 'joined_at': ''},
        {'sub': 'sub-edi', 'role': 'editor', 'email': 'edi@example.com', 'name': 'Edi Lund', 'invited_by': ADA,
         'joined_at': 't1'},
    ]
    cognito.list_users.assert_called_once_with(UserPoolId=POOL, Filter=f'sub = "{ADA}"', Limit=1)
    second, end = list_members(table, WS, limit=2, cursor=cursor, cognito=cognito, user_pool_id=POOL)
    assert ([m['sub'] for m in second], end) == (['sub-vic'], None)


def test_at_most_a_few_rows_a_page_are_looked_up_in_cognito(table):
    for n in range(MAX_COGNITO_FILLS + 3):
        _seed(table, f'sub-m{n}', 'viewer')
    cognito = MagicMock()
    cognito.list_users.return_value = {'Users': []}
    list_members(table, WS, limit=25, cursor=None, cognito=cognito, user_pool_id=POOL)
    assert cognito.list_users.call_count == MAX_COGNITO_FILLS


def test_a_failed_cognito_fill_leaves_the_email_blank_and_is_counted(table):
    cognito = MagicMock()
    cognito.list_users.side_effect = ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'p'}},
                                                 'ListUsers')
    with patch('shared.workspace_members.logger') as log:
        members, _ = list_members(table, WS, limit=25, cursor=None, cognito=cognito, user_pool_id=POOL)
    assert members[0]['email'] == ''
    log.warning.assert_called_once_with('Left member emails blank: the Cognito look-up failed', extra={'count': 1})


def test_a_member_row_with_an_unknown_role_is_left_out(table):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-odd', 'role': 'owner', 'email': 'o@example.com'})
    members, _ = list_members(table, WS, limit=25, cursor=None, cognito=MagicMock(), user_pool_id=POOL)
    assert [m['sub'] for m in members] == [ADA]


@pytest.mark.parametrize('cursor', [
    'not-a-cursor',
    # This partition, but not a member row.
    encode_key_cursor({'pk': f'WS#{WS}', 'sk': 'META'}),
    encode_key_cursor({'pk': f'USER#{ADA}', 'sk': f'WS#{WS}'}),
], ids=['garbage', 'meta', 'other-partition'])
def test_a_cursor_from_elsewhere_is_refused(table, cursor):
    with pytest.raises(ValueError, match='not valid'):
        list_members(table, WS, limit=25, cursor=cursor, cognito=MagicMock(), user_pool_id=POOL)


# ── Add ──────────────────────────────────────────────────────────────────────

def test_an_add_writes_the_member_and_user_rows_and_checks_the_workspace_in_one_transaction(table):
    items = _tx_items(table, lambda: add_member(table, CONTEXT, NEW, 'editor', ADA))
    # The two puts, the workspace still active, and the acting admin still admin.
    assert [next(iter(item)) for item in items] == ['Put', 'Put', 'ConditionCheck', 'ConditionCheck']
    assert items[3]['ConditionCheck']['Key'] == {'pk': f'WS#{WS}', 'sk': f'MEMBER#{ADA}'}
    assert [(i['Put']['Item']['pk'], i['Put']['Item']['sk']) for i in items[:2]] == [
        (f'WS#{WS}', 'MEMBER#sub-nia'), ('USER#sub-nia', f'WS#{WS}')]
    assert {i['Put']['ConditionExpression'] for i in items[:2]} == {'attribute_not_exists(pk)'}
    assert items[2]['ConditionCheck']['Key'] == {'pk': f'WS#{WS}', 'sk': 'META'}
    member = _member_row(table, 'sub-nia')
    assert {k: member[k] for k in ('role', 'invited_by', 'email', 'name')} == {
        'role': 'editor', 'invited_by': ADA, 'email': 'nia@example.com', 'name': 'Nia Park'}
    assert _user_row(table, 'sub-nia') == {'pk': 'USER#sub-nia', 'sk': f'WS#{WS}', 'name': 'Acme Outfitters',
                                           'slug': 'acme', 'role': 'editor'}
    [audit] = _audits(table)
    assert {k: audit[k] for k in ('kind', 'actor', 'target', 'role_after', 'account', 'platform_admin')} == {
        'kind': MEMBER_ADDED, 'actor': ADA, 'target': 'sub-nia', 'role_after': 'editor', 'account': 'existing',
        'platform_admin': False}
    assert 'role_before' not in audit


def test_an_add_of_a_member_is_a_409_and_records_nothing(table):
    with pytest.raises(ConflictError, match=ALREADY_MEMBER):
        add_member(table, CONTEXT, Account(sub=ADA, email='a@example.com', name='', created=False), 'viewer', ADA)
    assert _audits(table) == []


def test_a_member_added_meanwhile_is_a_409_from_the_transaction(table):
    with patch('shared.workspace_members._stored_role', return_value=None), \
            pytest.raises(ConflictError, match=ALREADY_MEMBER):
        add_member(table, CONTEXT, Account(sub=ADA, email='a@example.com', name='', created=False), 'viewer', ADA)
    assert _member_row(table, ADA)['role'] == 'admin'


def test_an_add_to_a_workspace_no_longer_active_is_the_workspace_404(table):
    table.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :d',
                      ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':d': 'deleting'})
    with pytest.raises(NotFoundError, match=NOT_FOUND):
        add_member(table, CONTEXT, NEW, 'viewer', ADA)
    assert _member_row(table, 'sub-nia') is None


def test_an_add_whose_audit_row_cannot_be_written_adds_nothing(table):
    with patch.object(table, 'put_item', side_effect=DENIED), pytest.raises(ClientError):
        add_member(table, CONTEXT, NEW, 'viewer', ADA)
    assert (_member_row(table, 'sub-nia'), _user_row(table, 'sub-nia')) == (None, None)


def test_the_audit_row_is_written_before_the_transaction(table):
    order = MagicMock()
    client = table.meta.client
    with patch.object(table, 'put_item', wraps=table.put_item) as put, \
            patch.object(client, 'transact_write_items', wraps=client.transact_write_items) as tx:
        order.attach_mock(put, 'audit')
        order.attach_mock(tx, 'transaction')
        add_member(table, CONTEXT, NEW, 'viewer', ADA)
        change_role(table, CONTEXT, 'sub-nia', 'editor', ADA)
        remove_member(table, CONTEXT, 'sub-nia', ADA)
    assert [name for name, *_ in order.mock_calls] == ['audit', 'transaction'] * 3


def test_a_new_account_is_recorded_as_created_and_an_existing_one_is_logged_without_an_email(table):
    with patch('shared.workspace_members.logger') as log:
        add_member(table, CONTEXT, NEW, 'viewer', ADA)
    log.info.assert_called_once_with('Workspace member added; no notification email is sent',
                                     extra={'workspace_id': WS})
    created = Account(sub='sub-new', email='new@example.com', name='', created=True)
    add_member(table, CONTEXT, created, 'viewer', ADA)
    assert sorted(row['account'] for row in _audits(table)) == ['created', 'existing']


def test_a_platform_admins_change_is_flagged_in_its_audit_row(table):
    entered = WorkspaceContext(ws=WS, role='admin', name='Acme Outfitters', slug='acme', platform_admin=True)
    add_member(table, entered, NEW, 'viewer', 'sub-pat')
    [audit] = _audits(table)
    assert (audit['actor'], audit['platform_admin']) == ('sub-pat', True)


# ── Change a role ────────────────────────────────────────────────────────────

def test_a_role_change_updates_both_rows_after_its_audit_row(table):
    _seed(table, 'sub-vic', 'viewer')
    items = _tx_items(table, lambda: change_role(table, CONTEXT, 'sub-vic', 'editor', ADA))
    # The two updates, then the acting admin still admin.
    assert [list(item) for item in items] == [['Update'], ['Update'], ['ConditionCheck']]
    assert items[2]['ConditionCheck']['Key'] == {'pk': f'WS#{WS}', 'sk': f'MEMBER#{ADA}'}
    assert [item['Update']['Key'] for item in items[:2]] == [
        {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-vic'}, {'pk': 'USER#sub-vic', 'sk': f'WS#{WS}'}]
    assert (_member_row(table, 'sub-vic')['role'], _user_row(table, 'sub-vic')['role']) == ('editor', 'editor')
    [audit] = _audits(table)
    assert {k: audit[k] for k in ('kind', 'target', 'role_before', 'role_after')} == {
        'kind': MEMBER_ROLE_CHANGED, 'target': 'sub-vic', 'role_before': 'viewer', 'role_after': 'editor'}


def test_the_same_role_changes_and_records_nothing(table):
    with patch.object(table.meta.client, 'transact_write_items') as tx:
        assert change_role(table, CONTEXT, ADA, 'admin', ADA) == {'sub': ADA, 'role': 'admin'}
    tx.assert_not_called()
    assert _audits(table) == []


def test_a_role_change_of_a_non_member_is_the_members_404(table):
    with pytest.raises(NotFoundError, match=MEMBER_NOT_FOUND):
        change_role(table, CONTEXT, 'sub-nobody', 'viewer', ADA)


def test_demoting_the_last_admin_is_a_409_and_records_nothing(table):
    _seed(table, 'sub-edi', 'editor')
    with pytest.raises(ConflictError, match=LAST_ADMIN):
        change_role(table, CONTEXT, ADA, 'editor', ADA)
    assert (_member_row(table, ADA)['role'], _audits(table)) == ('admin', [])


def test_demoting_an_admin_checks_in_the_transaction_that_another_is_still_admin(table):
    _seed(table, 'sub-bo', 'admin')
    items = _tx_items(table, lambda: change_role(table, CONTEXT, ADA, 'viewer', ADA))
    assert items[-1]['ConditionCheck']['Key'] == {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-bo'}
    assert items[-1]['ConditionCheck']['ExpressionAttributeValues'] == {':admin': 'admin'}
    assert _user_row(table, ADA)['role'] == 'viewer'


def test_two_admins_demoting_each_other_cannot_both_succeed(table):
    _seed(table, 'sub-bo', 'admin')
    # Both read the other as admin; the second transaction finds its "other admin" demoted by the first.
    with patch('shared.workspace_members._another_admin', side_effect=['sub-bo', ADA]):
        change_role(table, CONTEXT, ADA, 'viewer', ADA)
        with pytest.raises(ConflictError, match=CHANGED_MEANWHILE):
            change_role(table, CONTEXT, 'sub-bo', 'viewer', 'sub-bo')
    assert _member_row(table, 'sub-bo')['role'] == 'admin'


def test_a_role_changed_meanwhile_is_a_409(table):
    _seed(table, 'sub-vic', 'viewer')
    with patch('shared.workspace_members._stored_role', return_value='editor'), \
            pytest.raises(ConflictError, match=CHANGED_MEANWHILE):
        change_role(table, CONTEXT, 'sub-vic', 'admin', ADA)
    assert _member_row(table, 'sub-vic')['role'] == 'viewer'


@pytest.mark.parametrize('change', [
    lambda table: change_role(table, CONTEXT, 'sub-vic', 'editor', ADA),
    lambda table: remove_member(table, CONTEXT, 'sub-vic', ADA),
], ids=['role', 'remove'])
def test_a_concurrent_change_of_the_same_rows_is_a_409_not_a_fault(table, change):
    # Another request was changing these rows at the same moment: DynamoDB cancels with TransactionConflict.
    _seed(table, 'sub-vic', 'viewer')
    conflict = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'conflict'},
                            'CancellationReasons': [{'Code': 'TransactionConflict'}, {'Code': 'None'}]},
                           'TransactWriteItems')
    with patch.object(table.meta.client, 'transact_write_items', side_effect=conflict), \
            pytest.raises(ConflictError, match=CHANGED_MEANWHILE):
        change(table)
    assert _member_row(table, 'sub-vic')['role'] == 'viewer'


@pytest.mark.parametrize('change', [
    lambda table: change_role(table, CONTEXT, 'sub-vic', 'admin', ADA),
    lambda table: remove_member(table, CONTEXT, 'sub-vic', ADA),
    lambda table: add_member(table, CONTEXT, NEW, 'admin', ADA),
], ids=['promote', 'remove', 'add'])
def test_an_admin_demoted_between_the_read_and_the_write_is_refused(table, change):
    # ADA was read as admin (CONTEXT), then demoted before her transaction committed: its check of her row refuses.
    _seed(table, 'sub-vic', 'viewer')
    table.update_item(Key={'pk': f'WS#{WS}', 'sk': f'MEMBER#{ADA}'}, UpdateExpression='SET #r = :v',
                      ExpressionAttributeNames={'#r': 'role'}, ExpressionAttributeValues={':v': 'viewer'})
    with pytest.raises(AuthorizationError, match=NO_LONGER_ADMIN):
        change(table)
    assert (_member_row(table, 'sub-vic')['role'], _member_row(table, 'sub-nia')) == ('viewer', None)


def test_an_add_that_finds_an_orphan_inverse_row_is_a_409_and_logged(table):
    # A USER# row with no MEMBER# row: the add refuses (409) and the inconsistency is logged for repair.
    table.put_item(Item={'pk': 'USER#sub-nia', 'sk': f'WS#{WS}', 'role': 'viewer'})
    with patch('shared.workspace_members.logger') as log, pytest.raises(ConflictError):
        add_member(table, CONTEXT, NEW, 'editor', ADA)
    log.warning.assert_called_once_with('Workspace member add found a USER# row without its MEMBER# row',
                                        extra={'workspace_id': WS})


def test_a_member_without_an_inverse_row_is_not_given_a_half_row(table):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-vic', 'role': 'viewer'})
    with pytest.raises(ClientError, match='TransactionCanceled'):
        change_role(table, CONTEXT, 'sub-vic', 'editor', ADA)
    assert (_member_row(table, 'sub-vic')['role'], _user_row(table, 'sub-vic')) == ('viewer', None)


def test_a_role_change_whose_audit_row_cannot_be_written_changes_nothing(table):
    _seed(table, 'sub-vic', 'viewer')
    with patch.object(table, 'put_item', side_effect=DENIED), pytest.raises(ClientError):
        change_role(table, CONTEXT, 'sub-vic', 'admin', ADA)
    assert (_member_row(table, 'sub-vic')['role'], _user_row(table, 'sub-vic')['role']) == ('viewer', 'viewer')


# ── Remove and leave ─────────────────────────────────────────────────────────

def test_a_removal_deletes_the_member_and_user_rows_only(table):
    _seed(table, 'sub-vic', 'viewer')
    items = _tx_items(table, lambda: remove_member(table, CONTEXT, 'sub-vic', ADA))
    assert items[-1]['ConditionCheck']['Key'] == {'pk': f'WS#{WS}', 'sk': f'MEMBER#{ADA}'}
    assert [item['Delete']['Key'] for item in items[:-1]] == [
        {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-vic'}, {'pk': 'USER#sub-vic', 'sk': f'WS#{WS}'}]
    assert (_member_row(table, 'sub-vic'), _user_row(table, 'sub-vic')) == (None, None)
    assert table.get_item(Key={'pk': f'WS#{WS}', 'sk': 'META'})['Item']['status'] == 'active'
    [audit] = _audits(table)
    assert {k: audit[k] for k in ('kind', 'actor', 'target', 'role_before')} == {
        'kind': MEMBER_REMOVED, 'actor': ADA, 'target': 'sub-vic', 'role_before': 'viewer'}
    assert 'role_after' not in audit


def test_a_member_leaving_is_recorded_as_a_leave(table):
    _seed(table, 'sub-vic', 'viewer')
    remove_member(table, CONTEXT, 'sub-vic', 'sub-vic')
    assert [row['kind'] for row in _audits(table)] == [MEMBER_LEFT]


def test_removing_or_leaving_as_the_last_admin_is_a_409(table):
    _seed(table, 'sub-vic', 'viewer')
    for actor in (ADA, 'sub-pat'):
        with pytest.raises(ConflictError, match=LAST_ADMIN):
            remove_member(table, CONTEXT, ADA, actor)
    assert (_member_row(table, ADA)['role'], _audits(table)) == ('admin', [])


def test_an_admin_leaves_when_another_admin_stays(table):
    _seed(table, 'sub-bo', 'admin')
    items = _tx_items(table, lambda: remove_member(table, CONTEXT, ADA, ADA))
    assert items[-1]['ConditionCheck']['Key'] == {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-bo'}
    assert _member_row(table, ADA) is None


def test_removing_a_non_member_is_the_members_404(table):
    with pytest.raises(NotFoundError, match=MEMBER_NOT_FOUND):
        remove_member(table, CONTEXT, 'sub-nobody', ADA)


def test_a_removal_whose_audit_row_cannot_be_written_removes_nothing(table):
    _seed(table, 'sub-vic', 'viewer')
    with patch.object(table, 'put_item', side_effect=DENIED), pytest.raises(ClientError):
        remove_member(table, CONTEXT, 'sub-vic', ADA)
    assert _member_row(table, 'sub-vic')['role'] == 'viewer'


def test_a_transaction_fault_propagates(table):
    _seed(table, 'sub-vic', 'viewer')
    fault = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'x'}}, 'TransactWriteItems')
    with patch.object(table.meta.client, 'transact_write_items', side_effect=fault), \
            pytest.raises(ClientError, match='InternalServerError'):
        remove_member(table, CONTEXT, 'sub-vic', ADA)
    # The audit row stays: it recorded the attempt.
    assert [row['kind'] for row in _audits(table)] == [MEMBER_REMOVED]
