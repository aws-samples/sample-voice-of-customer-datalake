"""shared/request_workspace.py and shared/workspace_settings.py: a domain API request's workspace, and the key of a
workspace's settings row (moto; the rules of the resolution itself: shared/test/test_workspace.py)."""
from collections.abc import Iterator
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import request_workspace as rw
from shared.exceptions import AuthorizationError, ConfigurationError, NotFoundError, ServiceError
from shared.test.cognito_doubles import live_cognito
from shared.workspace import MembershipCache, WorkspaceContext
from shared.workspace_settings import settings_key

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'


def _event(sub='sub-ada', groups='users', ws: str | None = WS) -> dict:
    headers = {} if ws is None else {'X-Workspace-Id': ws}
    return {'headers': headers, 'requestContext': {'authorizer': {'claims': {
        'sub': sub, 'cognito:username': sub.removeprefix('sub-'), 'cognito:groups': groups}}}}


@pytest.fixture
def table(monkeypatch) -> Iterator:
    import boto3
    monkeypatch.setenv('WORKSPACES_TABLE', 'workspaces')
    monkeypatch.setenv('USER_POOL_ID', 'us-east-1_pool')
    with mock_aws(), patch.object(rw, '_MEMBERSHIPS', MembershipCache()):
        created = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='workspaces', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                  {'AttributeName': 'sk', 'AttributeType': 'S'}])
        created.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme',
                               'status': 'active'})
        created.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada', 'role': 'editor'})
        with patch('shared.request_workspace.cached_table', return_value=created):
            yield created


@pytest.mark.usefixtures('table')
def test_a_member_acts_in_the_workspace_with_their_role():
    context = rw.request_workspace(_event(), 'Failed')
    assert context is not None
    assert (context.ws, context.role, context.platform_admin) == (WS, 'editor', False)


@pytest.mark.parametrize('event', [_event(ws=None), _event(ws='  ')], ids=['no-header', 'a-blank-header'])
def test_a_request_that_names_no_workspace_is_the_deployment_as_before(monkeypatch, event):
    monkeypatch.delenv('WORKSPACES_TABLE', raising=False)
    with patch('shared.request_workspace.resolve_workspace') as resolve:
        assert rw.request_workspace(event, 'Failed') is None
    resolve.assert_not_called()


@pytest.mark.parametrize(('event', 'error'), [
    (_event(ws=OTHER), NotFoundError), (_event(ws='ws_bad'), NotFoundError), (_event(sub='sub-nobody'), NotFoundError),
], ids=['another-workspace', 'malformed', 'not-a-member'])
@pytest.mark.usefixtures('table')
def test_everyone_else_gets_the_workspace_api_s_answers(event, error):
    with pytest.raises(error):
        rw.request_workspace(event, 'Failed')


def test_a_write_reads_the_role_from_the_table_not_the_warm_cache(table):
    assert rw.request_workspace(_event(), 'Failed') is not None
    table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada', 'role': 'viewer'})
    cached = rw.request_workspace(_event(), 'Failed')
    fresh = rw.request_workspace(_event(), 'Failed', fresh=True)
    assert cached is not None
    assert fresh is not None
    assert (cached.role, fresh.role) == ('editor', 'viewer')


def test_a_platform_admin_enters_as_admin_checked_live_and_audited(table):
    pat = _event(sub='sub-pat', groups='[admins, platform-admins]')
    with patch('shared.platform_admin_gate.get_cognito_idp_client', return_value=live_cognito()):
        context = rw.request_workspace(pat, 'Failed')
    assert context is not None
    assert (context.role, context.platform_admin) == ('admin', True)
    rows = table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})
    assert [row['kind'] for row in rows['Items']] == ['platform_admin_entry']


@pytest.mark.usefixtures('table')
def test_a_fault_answers_the_route_s_fixed_error():
    fault = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'arn:aws:dynamodb:x'}}, 'GetItem')
    with patch('shared.request_workspace.resolve_workspace', side_effect=fault), \
            pytest.raises(ServiceError, match=r'^Failed to read$'):
        rw.request_workspace(_event(), 'Failed to read')


@pytest.mark.parametrize('variable', ['WORKSPACES_TABLE', 'USER_POOL_ID'])
def test_an_unconfigured_lambda_is_a_configuration_error(monkeypatch, variable):
    monkeypatch.setenv('WORKSPACES_TABLE', 'workspaces')
    monkeypatch.delenv(variable, raising=False)
    with patch('shared.request_workspace.resolve_workspace',
               side_effect=lambda _table, event, _cache, confirm_platform_admin: confirm_platform_admin(event)), \
            patch('shared.request_workspace.cached_table'), pytest.raises(ConfigurationError):
        rw.request_workspace(_event(), 'Failed')


@pytest.mark.parametrize(('role', 'writes'), [('admin', True), ('editor', True), ('viewer', False)])
def test_an_editor_or_an_admin_writes_a_viewer_reads(role, writes):
    context = WorkspaceContext(ws=WS, role=role, name='', slug='', platform_admin=False)
    if writes:
        rw.require_workspace_writer(context)
    else:
        with pytest.raises(AuthorizationError, match='Workspace editor access required'):
            rw.require_workspace_writer(context)


def test_a_workspace_settings_key_is_under_its_workspace():
    assert settings_key(WS, 'resolved_problems') == {'pk': f'WS#{WS}#SETTINGS#resolved_problems', 'sk': 'config'}


@pytest.mark.parametrize(('ws', 'kind'), [('ws_bad', 'brand'), (WS, 'Brand'), (WS, 'brand#x'), (WS, '')])
def test_no_settings_key_from_a_bad_workspace_or_kind(ws, kind):
    with pytest.raises(ValueError, match=r'not a (workspace id|settings kind)'):
        settings_key(ws, kind)


@pytest.mark.parametrize(('groups', 'role', 'refused'), [
    ('admins', None, False), ('users', None, True),
    ('users', 'admin', False), ('admins', 'editor', True), ('admins', 'viewer', True),
], ids=['no-workspace-admins', 'no-workspace-user', 'workspace-admin', 'deployment-admin-as-editor',
        'deployment-admin-as-viewer'])
def test_a_settings_admin_is_the_workspace_s_admin_or_without_one_the_deployment_s(groups, role, refused):
    """Both branches refuse: the route-gate inventory counts require_settings_admin as a gate."""
    context = None if role is None else WorkspaceContext(ws=WS, role=role, name='', slug='', platform_admin=False)
    event = _event(groups=groups)
    if refused:
        with pytest.raises(AuthorizationError):
            rw.require_settings_admin(event, context)
    else:
        rw.require_settings_admin(event, context)
