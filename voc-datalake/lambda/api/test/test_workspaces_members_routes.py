"""workspaces_handler.py: the members of the workspace X-Workspace-Id names, under /me/workspaces/current/members
(moto-backed, docs/multi-workspace.md, "Roles" and "Invites"; the rules: shared/test/test_workspace_members.py)."""
import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

import workspaces_handler
from shared import platform_admin_gate
from shared.test.cognito_doubles import live_cognito
from shared.workspace import MembershipCache
from shared.workspace_members import NEW_ACCOUNT_ADMINS_ONLY

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
MEMBERS = '/me/workspaces/current/members'
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'users'}
# The same workspace admin, also in the deployment's `admins` group (the only callers who may create an account).
ADA_DEPLOYMENT_ADMIN = {**ADA, 'cognito:groups': '[admins, users]'}
EDI = {'sub': 'sub-edi', 'cognito:username': 'edi', 'cognito:groups': 'users'}
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}
# An administrator of the deployment who is not a member: the `admins` group grants nothing in a workspace.
NOR = {'sub': 'sub-nor', 'cognito:username': 'nor', 'cognito:groups': 'admins'}
PAT = {'sub': 'sub-pat', 'cognito:username': 'pat', 'cognito:groups': '[admins, platform-admins]'}
ACCOUNTS = {'nia@example.com': ('sub-nia', 'Nia Park'), 'ada@example.com': ('sub-ada', 'Ada Moss')}
FAULT = ClientError({'Error': {'Code': 'InternalErrorException', 'Message': 'us-east-1_pool arn'}}, 'ListUsers')


def _user(sub, email, name=''):
    return {'Username': f'u-{sub}', 'Attributes': [{'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': email},
                                                    {'Name': 'name', 'Value': name}]}


def _list_users(**params):
    """Cognito's ListUsers on the fixture's accounts, for the two filters the code sends (email, sub)."""
    assert params['UserPoolId'] == 'us-east-1_pool'
    field, _, value = params['Filter'].partition(' = ')
    value = value.strip('"')
    accounts = [(sub, email, name) for email, (sub, name) in ACCOUNTS.items()]
    found = [account for account in accounts if value == {'sub': account[0], 'email': account[1]}.get(field)]
    return {'Users': [_user(*account) for account in found][:params['Limit']]}


@dataclass
class World:
    table: Any
    cognito: MagicMock
    #: SES v2 (shared/outbound_mail.py): every notice an add sends.
    ses: MagicMock


@pytest.fixture
def world() -> Iterator[World]:
    cognito = live_cognito()
    cognito.list_users.side_effect = _list_users
    cognito.admin_create_user.return_value = {'User': _user('sub-new', 'new@example.com')}
    ses = MagicMock()
    ses.send_email.return_value = {'MessageId': 'm-1'}
    with mock_aws(), patch.object(workspaces_handler, 'memberships', MembershipCache()), \
            patch('shared.outbound_mail.get_sesv2_client', return_value=ses), \
            patch.object(workspaces_handler, 'USER_POOL_ID', 'us-east-1_pool'), \
            patch.object(workspaces_handler, 'get_cognito_idp_client', return_value=cognito), \
            patch.dict('os.environ', {'USER_POOL_ID': 'us-east-1_pool'}), \
            patch.object(platform_admin_gate, 'get_cognito_idp_client', return_value=cognito):
        table = pk_sk_table('workspaces')
        table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme',
                             'status': 'active'})
        for claims, role in ((ADA, 'admin'), (EDI, 'editor'), (VIC, 'viewer')):
            _seed(table, claims['sub'], role)
        yield World(table, cognito, ses)


#: `-c emailFrom=…` on (lib/stacks/api-workspaces-lambda.ts sets both).
MAIL_ON = {'EMAIL_FROM': 'noreply@voc.example.com', 'FRONTEND_URL': 'https://voc.example.com'}


@pytest.fixture
def mail_on() -> Iterator[None]:
    with patch.dict('os.environ', MAIL_ON):
        yield


def _seed(table, sub, role):
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': f'MEMBER#{sub}', 'role': role})
    table.put_item(Item={'pk': f'USER#{sub}', 'sk': f'WS#{WS}', 'name': 'Acme Outfitters', 'slug': 'acme',
                         'role': role})


def _call(world, lambda_context, method, path, claims=ADA, body=None, query=None, ws: str | None = WS):
    event = rest_event(method, path, claims=claims, body=body)
    event['queryStringParameters'] = query
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.table)


def _role(world, sub):
    item = world.table.get_item(Key={'pk': f'WS#{WS}', 'sk': f'MEMBER#{sub}'}).get('Item')
    return item and item['role']


def _audit_kinds(world):
    rows = world.table.query(KeyConditionExpression='pk = :pk',
                             ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    return sorted(row['kind'] for row in rows)


# ── GET: any member ──────────────────────────────────────────────────────────

@pytest.mark.parametrize('claims', [ADA, EDI, VIC], ids=['admin', 'editor', 'viewer'])
def test_every_member_lists_the_members(world, lambda_context, claims):
    status, body = _call(world, lambda_context, 'GET', MEMBERS, claims=claims)
    assert status == 200
    assert [(m['sub'], m['role']) for m in body['members']] == [
        ('sub-ada', 'admin'), ('sub-edi', 'editor'), ('sub-vic', 'viewer')]
    # ada's row holds no email: Cognito's, by her sub.
    assert (body['members'][0]['email'], body['members'][0]['name']) == ('ada@example.com', 'Ada Moss')
    assert body['next_cursor'] is None


def test_the_list_pages(world, lambda_context):
    _, first = _call(world, lambda_context, 'GET', MEMBERS, query={'limit': '2'})
    _, second = _call(world, lambda_context, 'GET', MEMBERS, query={'limit': '2', 'cursor': first['next_cursor']})
    assert [m['sub'] for m in first['members'] + second['members']] == ['sub-ada', 'sub-edi', 'sub-vic']
    assert second['next_cursor'] is None


@pytest.mark.parametrize('query', [{'limit': 'ten'}, {'cursor': 'bogus'}], ids=['limit', 'cursor'])
def test_a_bad_limit_or_cursor_is_a_400(world, lambda_context, query):
    assert _call(world, lambda_context, 'GET', MEMBERS, query=query) == (
        400, {'success': False, 'error': 'limit or cursor is not valid'})


def test_an_unreadable_member_list_is_a_fixed_500(world, lambda_context):
    fault = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'table arn'}}, 'Query')
    _call(world, lambda_context, 'GET', '/me/workspaces/current')  # the membership is cached first
    with patch.object(world.table, 'query', side_effect=fault):
        assert _call(world, lambda_context, 'GET', MEMBERS) == (
            500, {'success': False, 'error': 'Failed to list the members'})


# ── Who may do what ──────────────────────────────────────────────────────────

WRITES = [('POST', MEMBERS, {'email': 'nia@example.com', 'role': 'viewer'}),
          ('PUT', f'{MEMBERS}/sub-vic', {'role': 'admin'}),
          ('DELETE', f'{MEMBERS}/sub-ada', None)]


@pytest.mark.parametrize('claims', [EDI, VIC], ids=['editor', 'viewer'])
def test_editors_and_viewers_get_403_on_every_write_and_nothing_changes(world, lambda_context, claims):
    for method, path, body in WRITES:
        assert _call(world, lambda_context, method, path, claims=claims, body=body) == (
            403, {'success': False, 'error': 'Workspace admin access required'})
    assert (_role(world, 'sub-nia'), _role(world, 'sub-vic'), _role(world, 'sub-ada')) == (None, 'viewer', 'admin')
    assert _audit_kinds(world) == []
    world.cognito.list_users.assert_not_called()


@pytest.mark.parametrize('method', ['GET', 'POST', 'PUT', 'DELETE'])
def test_a_non_member_gets_the_workspace_404_even_as_a_deployment_admin(world, lambda_context, method):
    path, body = {'GET': (MEMBERS, None), 'POST': WRITES[0][1:], 'PUT': WRITES[1][1:], 'DELETE': WRITES[2][1:]}[method]
    assert _call(world, lambda_context, method, path, claims=NOR, body=body) == (
        404, {'success': False, 'error': 'Workspace not found'})
    assert _audit_kinds(world) == []


def test_a_write_reads_the_callers_role_fresh_not_from_the_cache(world, lambda_context):
    # ada's admin role is cached here; another container demotes her (the table changes, this cache does not).
    _seed(world.table, 'sub-bo', 'admin')
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current')[1]['workspace']['role'] == 'admin'
    world.table.update_item(Key={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada'}, UpdateExpression='SET #r = :v',
                            ExpressionAttributeNames={'#r': 'role'}, ExpressionAttributeValues={':v': 'editor'})
    # Reads may serve the cached role for up to 30 s; a write cannot use it to promote herself back.
    assert _call(world, lambda_context, 'PUT', f'{MEMBERS}/sub-ada', body={'role': 'admin'})[0] == 403
    assert (_role(world, 'sub-ada'), _audit_kinds(world)) == ('editor', [])


def test_every_route_needs_the_header(world, lambda_context):
    assert _call(world, lambda_context, 'GET', MEMBERS, ws=None)[0] == 400


def test_a_platform_admin_enters_live_checked_and_adds_a_member(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', MEMBERS, claims=PAT,
                         body={'email': 'nia@example.com', 'role': 'editor'})
    assert (status, body['member']['role'], body['member']['invited_by']) == (201, 'editor', 'sub-pat')
    world.cognito.admin_get_user.assert_called_once_with(UserPoolId='us-east-1_pool', Username='pat')
    assert _audit_kinds(world) == ['member_added', 'platform_admin_entry']


@pytest.mark.parametrize(('method', 'path', 'body'), [
    ('POST', '/me/workspaces/current/members', {'email': 'not-an-email', 'role': 'editor'}),
    ('PUT', '/me/workspaces/current/members/sub-edi', {'role': 'owner'}),
], ids=['add', 'role-change'])
def test_a_platform_admins_bad_body_is_refused_before_the_entry_is_audited(world, lambda_context, method, path, body):
    # The body is read first, so a request refused for its body leaves no platform_admin_entry row.
    status, _ = _call(world, lambda_context, method, path, claims=PAT, body=body)
    assert status == 400
    assert _audit_kinds(world) == []


def test_a_revoked_platform_admin_cannot_add(world, lambda_context):
    world.cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': 'admins'}]}
    assert _call(world, lambda_context, 'POST', MEMBERS, claims=PAT,
                 body={'email': 'nia@example.com', 'role': 'editor'})[0] == 404
    assert _role(world, 'sub-nia') is None


# ── POST: add ────────────────────────────────────────────────────────────────

def test_an_email_with_an_account_is_a_member_at_once(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'nia@example.com', 'role': 'editor'})
    assert status == 201
    member = body['member']
    assert {k: member[k] for k in ('sub', 'role', 'email', 'name', 'invited_by', 'account')} == {
        'sub': 'sub-nia', 'role': 'editor', 'email': 'nia@example.com', 'name': 'Nia Park', 'invited_by': 'sub-ada',
        'account': 'existing'}
    world.cognito.admin_create_user.assert_not_called()
    # Her picker lists it, and she can enter.
    nia = {'sub': 'sub-nia', 'cognito:groups': 'users'}
    assert _call(world, lambda_context, 'GET', '/me/workspaces', claims=nia, ws=None)[1]['workspaces'][0]['role'] == (
        'editor')
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=nia)[1]['workspace']['role'] == 'editor'


def test_a_new_email_gets_an_account_then_the_membership_from_a_deployment_admin(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', MEMBERS, claims=ADA_DEPLOYMENT_ADMIN,
                         body={'email': 'new@example.com', 'role': 'viewer'})
    assert (status, body['member']['sub'], body['member']['account'], body['member']['notified']) == (
        201, 'sub-new', 'created', False)
    assert world.cognito.admin_create_user.call_args.kwargs['DesiredDeliveryMediums'] == ['EMAIL']
    assert _role(world, 'sub-new') == 'viewer'
    # The account's creation is recorded first (before AdminCreateUser), then the membership.
    assert sorted(_audit_kinds(world)) == ['account_created', 'member_added']
    # The email only as its hash: no role can ever change or remove an audit row, so no raw address goes there.
    rows = world.table.query(KeyConditionExpression='pk = :pk',
                             ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    [created] = [row for row in rows if row['kind'] == 'account_created']
    assert 'email' not in created
    assert created['email_sha256'] == hashlib.sha256(b'new@example.com').hexdigest()


def test_a_new_account_whose_audit_row_cannot_be_written_is_never_created(world, lambda_context):
    denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'AUDIT#WS'}}, 'PutItem')
    with patch.object(world.table, 'put_item', side_effect=denied):
        status, _ = _call(world, lambda_context, 'POST', MEMBERS, claims=ADA_DEPLOYMENT_ADMIN,
                          body={'email': 'new@example.com', 'role': 'viewer'})
    assert status == 500
    world.cognito.admin_create_user.assert_not_called()


def test_a_workspace_admin_outside_admins_cannot_create_an_account(world, lambda_context):
    # Until the data path is keyed by workspace every account reads the whole deployment, so creating one stays
    # with the deployment's administrators (the users API's rule); an existing account can still be added.
    status, body = _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'new@example.com', 'role': 'viewer'})
    assert (status, body['error']) == (403, NEW_ACCOUNT_ADMINS_ONLY)
    assert NEW_ACCOUNT_ADMINS_ONLY.startswith('This email has no account yet: only a deployment administrator')
    world.cognito.admin_create_user.assert_not_called()
    assert (_role(world, 'sub-new'), _audit_kinds(world)) == (None, [])


def test_adding_a_member_again_is_a_409(world, lambda_context):
    assert _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'ada@example.com', 'role': 'viewer'}) == (
        409, {'success': False, 'error': 'That person is already a member of this workspace'})
    assert _role(world, 'sub-ada') == 'admin'


def test_a_bad_add_is_a_400(world, lambda_context):
    assert _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'nia@example.com', 'role': 'owner'})[0] == 400
    assert _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'nope', 'role': 'viewer'})[0] == 400


@pytest.mark.parametrize(('broken', 'audited'), [
    ('list_users', []),
    # The creation's audit row is written first and records the attempt; the add then never happened.
    ('admin_create_user', ['account_created']),
])
def test_a_cognito_fault_on_add_is_a_fixed_500_and_adds_nothing(world, lambda_context, broken, audited):
    getattr(world.cognito, broken).side_effect = FAULT
    assert _call(world, lambda_context, 'POST', MEMBERS, claims=ADA_DEPLOYMENT_ADMIN,
                 body={'email': 'new@example.com', 'role': 'viewer'}) == (
        500, {'success': False, 'error': 'Failed to add the member'})
    assert (_role(world, 'sub-new'), _audit_kinds(world)) == (None, audited)


def test_an_add_whose_audit_row_cannot_be_written_is_a_fixed_500_and_adds_nothing(world, lambda_context):
    _call(world, lambda_context, 'GET', MEMBERS)  # ada's membership is cached: the next put is the change's audit
    denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'AUDIT#WS'}}, 'PutItem')
    with patch.object(world.table, 'put_item', side_effect=denied):
        assert _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'nia@example.com', 'role': 'viewer'}) == (
            500, {'success': False, 'error': 'Failed to add the member'})
    assert _role(world, 'sub-nia') is None


# ── POST: the notice to an existing account (shared/member_notice.py) ───────

NIA = {'email': 'nia@example.com', 'role': 'editor'}


def _notices(world):
    return [call.kwargs for call in world.ses.send_email.call_args_list]


def test_without_email_from_an_existing_account_is_added_and_not_notified(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', MEMBERS, body=NIA)
    assert (status, body['member']['account'], body['member']['notified']) == (201, 'existing', False)
    world.ses.send_email.assert_not_called()


@pytest.mark.usefixtures('mail_on')
def test_with_email_from_an_existing_account_gets_one_notice(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', MEMBERS, body=NIA)
    assert status == 201
    member = body['member']
    # Every field of before, and `notified`.
    assert {k: member[k] for k in ('sub', 'role', 'email', 'name', 'invited_by', 'account', 'notified')} == {
        'sub': 'sub-nia', 'role': 'editor', 'email': 'nia@example.com', 'name': 'Nia Park', 'invited_by': 'sub-ada',
        'account': 'existing', 'notified': True}
    [notice] = _notices(world)
    assert notice['Destination'] == {'ToAddresses': ['nia@example.com']}
    simple = notice['Content']['Simple']
    assert simple['Subject']['Data'] == 'VoC Analytics - You were added to "Acme Outfitters"'
    text = simple['Body']['Text']['Data']
    assert 'as an editor' in text
    assert 'https://voc.example.com/workspace/acme/' in text
    assert _role(world, 'sub-nia') == 'editor'


@pytest.mark.usefixtures('mail_on')
def test_the_notice_goes_to_the_address_cognito_holds_never_the_bodys(world, lambda_context):
    # Cognito's filter matched, but the account's own attribute is what the notice uses.
    world.cognito.list_users.side_effect = lambda **params: {
        'Users': [_user('sub-nia', 'nia.park@example.com', 'Nia Park')] if 'email' in params['Filter'] else []}
    assert _call(world, lambda_context, 'POST', MEMBERS, body=NIA)[1]['member']['notified'] is True
    assert _notices(world)[0]['Destination'] == {'ToAddresses': ['nia.park@example.com']}
    # No body field names a recipient: an extra one is refused before anything happens.
    assert _call(world, lambda_context, 'POST', MEMBERS,
                 body={**NIA, 'email': 'vic@example.com', 'to': 'x@example.com'})[0] == 400
    assert len(_notices(world)) == 1


@pytest.mark.usefixtures('mail_on')
def test_a_remove_and_add_again_within_a_day_sends_no_second_notice(world, lambda_context):
    assert _call(world, lambda_context, 'POST', MEMBERS, body=NIA)[1]['member']['notified'] is True
    assert _call(world, lambda_context, 'DELETE', f'{MEMBERS}/sub-nia')[0] == 200
    status, body = _call(world, lambda_context, 'POST', MEMBERS, body={**NIA, 'role': 'admin'})
    assert (status, body['member']['role'], body['member']['notified']) == (201, 'admin', False)
    assert len(_notices(world)) == 1


@pytest.mark.usefixtures('mail_on')
def test_a_send_failure_still_adds_the_member_and_answers_not_notified(world, lambda_context):
    world.ses.send_email.side_effect = ClientError(
        {'Error': {'Code': 'MessageRejected', 'Message': 'Email address is not verified'}}, 'SendEmail')
    with patch('shared.member_notice.logger') as log:
        status, body = _call(world, lambda_context, 'POST', MEMBERS, body=NIA)
    assert (status, body['member']['account'], body['member']['notified']) == (201, 'existing', False)
    assert _role(world, 'sub-nia') == 'editor'
    assert log.warning.call_args.kwargs['extra']['code'] == 'MessageRejected'
    assert 'nia@example.com' not in repr(log.mock_calls)


@pytest.mark.usefixtures('mail_on')
def test_an_unexpected_notice_fault_never_fails_the_add(world, lambda_context):
    with patch('shared.member_notice.notice_request', side_effect=RuntimeError('boom')):
        status, body = _call(world, lambda_context, 'POST', MEMBERS, body=NIA)
    assert (status, body['member']['notified']) == (201, False)
    assert _role(world, 'sub-nia') == 'editor'


@pytest.mark.usefixtures('mail_on')
def test_a_new_account_gets_cognitos_invitation_only(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', MEMBERS, claims=ADA_DEPLOYMENT_ADMIN,
                         body={'email': 'new@example.com', 'role': 'viewer'})
    # One contract: `notified` is always in an add's answer, false for a created account.
    assert (status, body['member']['account'], body['member']['notified']) == (201, 'created', False)
    world.cognito.admin_create_user.assert_called_once()
    world.ses.send_email.assert_not_called()


@pytest.mark.usefixtures('mail_on')
@pytest.mark.parametrize('claims', [EDI, VIC], ids=['editor', 'viewer'])
def test_an_editor_or_viewers_add_is_a_403_and_sends_nothing(world, lambda_context, claims):
    assert _call(world, lambda_context, 'POST', MEMBERS, claims=claims, body=NIA)[0] == 403
    world.ses.send_email.assert_not_called()


@pytest.mark.usefixtures('mail_on')
def test_a_role_change_sends_nothing_and_a_re_add_with_another_role_within_a_day_neither(world, lambda_context):
    # A role change is never a notice: not of a member added by the routes, nor of a seeded one.
    assert _call(world, lambda_context, 'PUT', f'{MEMBERS}/sub-vic', body={'role': 'editor'})[0] == 200
    world.ses.send_email.assert_not_called()
    assert _call(world, lambda_context, 'POST', MEMBERS, body=NIA)[1]['member']['notified'] is True
    assert _call(world, lambda_context, 'PUT', f'{MEMBERS}/sub-nia', body={'role': 'admin'})[0] == 200
    assert _call(world, lambda_context, 'PUT', f'{MEMBERS}/sub-nia', body={'role': 'viewer'})[0] == 200
    # Removed, then added back with yet another role, within the day: still the one notice.
    assert _call(world, lambda_context, 'DELETE', f'{MEMBERS}/sub-nia')[0] == 200
    assert _call(world, lambda_context, 'POST', MEMBERS, body={**NIA, 'role': 'admin'})[1]['member']['notified'] is False
    assert len(_notices(world)) == 1


def _send_fails(world):
    world.ses.send_email.side_effect = ClientError(
        {'Error': {'Code': 'MessageRejected', 'Message': 'nia@example.com is not verified'}}, 'SendEmail')


@pytest.mark.parametrize(('env', 'fails', 'notified'), [
    ({}, False, False),
    (MAIL_ON, False, True),
    (MAIL_ON, True, False),
], ids=['flag-off', 'flag-on', 'send-failure'])
def test_no_log_line_holds_the_address(world, lambda_context, capsys, caplog, env, fails, notified):
    if fails:
        _send_fails(world)
    # The Lambda's level (LOG_LEVEL INFO, lib/stacks/api-workspaces-lambda.ts). At DEBUG, botocore's own wire log
    # (off in Lambda) quotes every request, the membership's transaction included.
    caplog.set_level('INFO')
    with patch.dict('os.environ', env):
        status, body = _call(world, lambda_context, 'POST', MEMBERS, body=NIA)
    assert (status, body['member']['notified']) == (201, notified)
    captured = capsys.readouterr()
    logs = captured.out + captured.err + caplog.text
    # The capture sees the route's logs (the notice's own line names its outcome), and none holds the address.
    assert 'Workspace member notice' in logs
    assert 'nia@example.com' not in logs
    assert 'sub-nia' not in logs
    # Nor a hash of the sub (an unsalted one is undone by a list of subs).
    assert hashlib.sha256(b'sub-nia').hexdigest()[:16] not in logs
    assert 'sha256' not in logs


@pytest.mark.usefixtures('mail_on')
def test_a_refused_add_sends_nothing(world, lambda_context):
    # Already a member (409), and a non-member's add (the workspace 404).
    assert _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'ada@example.com', 'role': 'viewer'})[0] == 409
    assert _call(world, lambda_context, 'POST', MEMBERS, claims=NOR, body=NIA)[0] == 404
    world.ses.send_email.assert_not_called()


# ── PUT: change a role ───────────────────────────────────────────────────────

def test_an_admin_changes_a_role_and_the_member_acts_with_it_at_once(world, lambda_context):
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=VIC)[1]['workspace']['role'] == 'viewer'
    assert _call(world, lambda_context, 'PUT', f'{MEMBERS}/sub-vic', body={'role': 'editor'}) == (
        200, {'member': {'sub': 'sub-vic', 'role': 'editor'}})
    # The cached viewer entry of this container was dropped.
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=VIC)[1]['workspace']['role'] == 'editor'
    assert _audit_kinds(world) == ['member_role_changed']


def test_demoting_the_last_admin_is_a_409(world, lambda_context):
    assert _call(world, lambda_context, 'PUT', f'{MEMBERS}/sub-ada', body={'role': 'editor'}) == (
        409, {'success': False, 'error': 'A workspace needs an admin: make another member an admin first'})
    assert _role(world, 'sub-ada') == 'admin'


def test_a_role_change_of_a_non_member_or_a_bad_sub_is_a_404(world, lambda_context):
    for path in (f'{MEMBERS}/sub-nobody', f'{MEMBERS}/sub%22x'):
        assert _call(world, lambda_context, 'PUT', path, body={'role': 'editor'}) == (
            404, {'success': False, 'error': 'Member not found'})


def test_a_failed_role_change_is_a_fixed_500(world, lambda_context):
    fault = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'arn'}}, 'TransactWriteItems')
    with patch.object(world.table.meta.client, 'transact_write_items', side_effect=fault):
        assert _call(world, lambda_context, 'PUT', f'{MEMBERS}/sub-vic', body={'role': 'editor'}) == (
            500, {'success': False, 'error': "Failed to change the member's role"})


# ── DELETE: remove and leave ─────────────────────────────────────────────────

def test_an_admin_removes_a_member_who_then_gets_the_404(world, lambda_context):
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=EDI)[0] == 200
    assert _call(world, lambda_context, 'DELETE', f'{MEMBERS}/sub-edi') == (200, {'removed': 'sub-edi'})
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=EDI)[0] == 404
    assert _call(world, lambda_context, 'GET', '/me/workspaces', claims=EDI, ws=None)[1] == {'workspaces': []}
    assert _audit_kinds(world) == ['member_removed']


@pytest.mark.parametrize('claims', [EDI, VIC], ids=['editor', 'viewer'])
def test_a_member_leaves(world, lambda_context, claims):
    assert _call(world, lambda_context, 'DELETE', f'{MEMBERS}/{claims["sub"]}', claims=claims) == (
        200, {'removed': claims['sub']})
    assert _role(world, claims['sub']) is None
    assert _audit_kinds(world) == ['member_left']


def test_the_last_admin_cannot_leave(world, lambda_context):
    assert _call(world, lambda_context, 'DELETE', f'{MEMBERS}/sub-ada')[0] == 409
    assert _role(world, 'sub-ada') == 'admin'


def test_a_failed_removal_is_a_fixed_500(world, lambda_context):
    fault = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'arn'}}, 'TransactWriteItems')
    with patch.object(world.table.meta.client, 'transact_write_items', side_effect=fault):
        assert _call(world, lambda_context, 'DELETE', f'{MEMBERS}/sub-vic') == (
            500, {'success': False, 'error': 'Failed to remove the member'})
    assert _role(world, 'sub-vic') == 'viewer'


def test_an_unconfigured_user_pool_refuses_an_add(world, lambda_context):
    _call(world, lambda_context, 'GET', MEMBERS)
    with patch.object(workspaces_handler, 'USER_POOL_ID', ''):
        assert _call(world, lambda_context, 'POST', MEMBERS, body={'email': 'nia@example.com', 'role': 'viewer'})[0] == (
            500)
    assert _role(world, 'sub-nia') is None
