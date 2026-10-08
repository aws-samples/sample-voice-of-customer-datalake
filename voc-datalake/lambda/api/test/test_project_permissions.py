"""Per-project permissions through the real projects handler and a moto table.

The policy itself (who gets which role) is pinned in
shared/test/test_project_access.py. These tests pin the WIRING:

  * the access gate runs for every /projects/{id}/... route in projects_handler.py
    (enumerated from the source, so a new route cannot opt out unnoticed);
  * its refusals reach the registered exception handlers as the contract's
    404 / 403 bodies;
  * create/list/get attach the computed sharing fields, and update_project can
    never write them;
  * the sharing routes (visibility, members, owner) perform the writes the
    contract describes against real DynamoDB semantics (nested map paths,
    size() conditions, PROJECT_WRITABLE_CONDITION);
  * MCP credentials act as their minter and token minting checks reach.

moto rather than MagicMock because the member writes depend on DynamoDB's own
expression semantics, which a mock would accept whatever their shape.
"""
import json
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared import project_access
from shared.indexes import PROJECTS_BY_TYPE_INDEX

OWNER = {'sub': 'owner-sub', 'cognito:username': 'olivia', 'email': 'olivia@example.com'}
EDITOR = {'sub': 'editor-sub', 'cognito:username': 'eddie', 'email': 'eddie@example.com'}
VIEWER = {'sub': 'viewer-sub', 'cognito:username': 'vera', 'email': 'vera@example.com'}
STRANGER = {'sub': 'stranger-sub', 'cognito:username': 'sam', 'email': 'sam@example.com'}
ADMIN = {'sub': 'admin-sub', 'cognito:username': 'ada', 'cognito:groups': 'admins'}

NOT_FOUND = {'success': False, 'error': 'Project not found'}
CANNOT_EDIT = {'success': False, 'error': 'You do not have permission to edit this project'}
CANNOT_MANAGE = {'success': False, 'error': 'You do not have permission to manage this project'}

HANDLER_SOURCE = Path(__file__).resolve().parent.parent / 'projects_handler.py'
_ROUTE_PATTERN = re.compile(r'@app\.(get|post|put|patch|delete)\(\s*"([^"]+)"')


def _delegated(created_by):
    """The claims shared.mcp_delegate.synthetic_claims builds for a token."""
    claims = {'sub': 'mcp:tok1', 'cognito:groups': '', 'email': 'mcp:tok1'}
    if created_by:
        claims[project_access.ACTING_SUBJECT_CLAIM] = created_by
    return claims


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

class FakeCognito:
    """ListUsers over a fixed directory, honouring the three filters the code uses."""

    def __init__(self, users):
        self.users = users
        self.calls = []

    def list_users(self, **kwargs):
        self.calls.append(kwargs)
        found = list(self.users)
        expression = kwargs.get('Filter')
        if expression:
            match = re.fullmatch(r'(\w+) (\^?=) "(.*)"', expression)
            assert match, expression
            field, op, value = match.groups()
            found = [
                user for user in found
                if (_user_field(user, field) or '').startswith(value)
                and (op == '^=' or _user_field(user, field) == value)
            ]
        return {'Users': found[: kwargs['Limit']]}


def _user_field(user, field):
    if field == 'username':
        return user['Username']
    return next((a['Value'] for a in user['Attributes'] if a['Name'] == field), None)


def _cognito_user(sub, username, email, enabled=True, name=''):
    attributes = [{'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': email},
                  {'Name': 'phone_number', 'Value': '+15555550100'}]
    if name:
        attributes.append({'Name': 'name', 'Value': name})
    return {'Username': username, 'Attributes': attributes, 'Enabled': enabled,
            'UserStatus': 'CONFIRMED'}


DIRECTORY = [
    _cognito_user('owner-sub', 'olivia', 'olivia@example.com'),
    _cognito_user('editor-sub', 'eddie', 'eddie@example.com'),
    _cognito_user('viewer-sub', 'vera', 'vera@example.com'),
    _cognito_user('stranger-sub', 'sam', 'sam@example.com', name='Sam Stranger'),
    _cognito_user('sara-sub', 'sara', 'sa@example.com'),
    _cognito_user('disabled-sub', 'sabine', 'sabine@example.com', enabled=False),
]


@pytest.fixture(scope='module')
def _module_table():
    """One moto table per module: creating it is most of a test's runtime."""
    with mock_aws():
        yield pk_sk_table('test-projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)


@pytest.fixture
def table(_module_table):
    """The shared table, emptied after each test so no state leaks between them."""
    yield _module_table
    with _module_table.batch_writer() as batch:
        for item in _module_table.scan(ProjectionExpression='pk, sk')['Items']:
            batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})


@pytest.fixture
def cognito():
    return FakeCognito(DIRECTORY)


@pytest.fixture
def call(table, cognito, api_gateway_event, lambda_context):
    """One request through lambda_handler as ``claims``; returns (status, body)."""
    import projects
    import projects_handler

    def _call(claims, method, path, body=None, query=None):
        event = api_gateway_event(
            method=method, path=path, body=body, query_params=query, claims=claims,
        )
        with (
            patch.object(projects_handler, 'get_projects_table', return_value=table),
            patch.object(projects, 'projects_table', table),
            patch.object(projects, '_get_cognito_client', return_value=cognito),
        ):
            response = projects_handler.lambda_handler(event, lambda_context)
        return response['statusCode'], json.loads(response['body'])

    return _call


def _seed(table, project_id='p1', *, visibility: str | None = 'private',
          owner: dict[str, str] | None = OWNER, members: dict | None = None,
          **extra):
    item = {
        'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id,
        'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': f'2026-01-01#{project_id}',
        'name': f'Project {project_id}', 'status': 'active',
        **extra,
    }
    if visibility is not None:
        item['visibility'] = visibility
    if owner is not None:
        item.update(owner_sub=owner['sub'], owner_username=owner['cognito:username'],
                    owner_email=owner['email'])
    if members is not None:
        item['members'] = members
    table.put_item(Item=item)
    return item


def _member(claims, role):
    return {'role': role, 'username': claims['cognito:username'], 'email': claims['email'],
            'added_by': OWNER['sub'], 'added_at': '2026-01-01T00:00:00+00:00'}


@pytest.fixture
def private_project(table):
    return _seed(table, members={
        EDITOR['sub']: _member(EDITOR, 'editor'),
        VIEWER['sub']: _member(VIEWER, 'viewer'),
    })


def _meta(table, project_id='p1'):
    return table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'})['Item']


# ---------------------------------------------------------------------------
# The gate cannot be skipped
# ---------------------------------------------------------------------------

def _handler_routes():
    return _ROUTE_PATTERN.findall(HANDLER_SOURCE.read_text())


def _concrete(template):
    return re.sub(r'<(\w+)>', lambda m: 'p1' if m.group(1) == 'project_id' else f'{m.group(1)}-x',
                  template)


PROJECT_ROUTES = [
    (method.upper(), template) for method, template in _handler_routes()
    if template.startswith('/projects/<project_id>')
]


class TestEveryRouteIsGated:
    def test_the_route_list_is_not_empty(self):
        # A regex that silently matched nothing would make every test below vacuous.
        assert len(PROJECT_ROUTES) > 30

    def test_the_gate_is_registered_for_every_route(self):
        import projects_handler

        assert projects_handler.project_access_middleware in projects_handler.app._router_middlewares

    @pytest.mark.parametrize(('method', 'template'), PROJECT_ROUTES)
    def test_every_project_route_is_classified(self, method, template):
        route = project_access.project_route(template)

        assert route is not None
        assert route[0] == '<project_id>'
        assert project_access.required_level(method, route[1]) in {
            project_access.LEVEL_VIEW, project_access.LEVEL_EDIT, project_access.LEVEL_MANAGE,
        }

    def test_every_other_projects_route_is_a_declared_workspace_route(self):
        for _method, template in _handler_routes():
            if not template.startswith('/projects/') or template.startswith('/projects/<project_id>'):
                continue
            first = template.split('/')[2]
            assert first in project_access.NON_PROJECT_SEGMENTS, template

    @pytest.mark.parametrize(('method', 'template'), PROJECT_ROUTES)
    @pytest.mark.usefixtures('private_project')
    def test_a_stranger_gets_404_on_every_route_of_a_private_project(
        self, call, method, template,
    ):
        status, body = call(STRANGER, method, _concrete(template), body={})

        assert (status, body) == (404, NOT_FOUND)

    @pytest.mark.parametrize(('method', 'path'), [
        ('GET', '/projects/p1'),
        ('GET', '/projects/p1/jobs'),
        ('POST', '/projects/p1/chat-context'),
        ('POST', '/projects/p1/product-docs/upload-url'),
        ('POST', '/projects/p1/build-prototype'),
        ('PUT', '/projects/p1'),
        ('DELETE', '/projects/p1'),
    ])
    @pytest.mark.usefixtures('private_project')
    def test_named_sample_refuses_a_stranger(self, call, method, path):
        assert call(STRANGER, method, path, body={'name': 'x'}) == (404, NOT_FOUND)

    @pytest.mark.usefixtures('private_project')
    def test_a_missing_project_looks_the_same_as_a_hidden_one(self, call):
        assert call(STRANGER, 'GET', '/projects/nope') == (404, NOT_FOUND)

    def test_a_tombstoned_project_is_not_found(self, call, table):
        _seed(table, visibility='public', status='deleted')

        assert call(STRANGER, 'GET', '/projects/p1') == (404, NOT_FOUND)

    @pytest.mark.usefixtures('private_project')
    def test_a_caller_without_a_subject_is_refused(self, call):
        status, body = call({'sub': '  '}, 'GET', '/projects/p1')

        assert status == 403
        assert body == {'success': False, 'error': 'Caller identity could not be determined'}

    def test_workspace_routes_are_untouched(self, call):
        status, body = call(STRANGER, 'GET', '/projects')

        assert status == 200
        assert body['projects'] == []


class TestGateRefusalsReachTheExceptionHandlers:
    """Errors raised inside the middleware get the shared {success, error} body."""

    @pytest.mark.usefixtures('private_project')
    def test_viewer_cannot_edit(self, call):
        assert call(VIEWER, 'PUT', '/projects/p1', body={'name': 'x'}) == (403, CANNOT_EDIT)

    @pytest.mark.usefixtures('private_project')
    def test_editor_cannot_manage(self, call):
        assert call(EDITOR, 'DELETE', '/projects/p1') == (403, CANNOT_MANAGE)

    @pytest.mark.usefixtures('private_project')
    def test_editor_can_edit(self, call, table):
        status, _ = call(EDITOR, 'PUT', '/projects/p1', body={'name': 'Renamed'})

        assert status == 200
        assert _meta(table)['name'] == 'Renamed'

    @pytest.mark.usefixtures('private_project')
    def test_viewer_can_read_chat_context_and_sees_its_access(self, call):
        status, body = call(VIEWER, 'POST', '/projects/p1/chat-context',
                            body={'selected_document_ids': []})

        assert status == 200
        assert body['access'] == {'role': 'viewer', 'can_view': True,
                                  'can_edit': False, 'can_manage': False}
        assert 'members' not in body['project']

    def test_a_public_legacy_project_is_editable_by_everyone_but_managed_by_admins(
        self, call, table,
    ):
        _seed(table, visibility=None, owner=None)

        assert call(STRANGER, 'GET', '/projects/p1')[0] == 200
        assert call(STRANGER, 'PUT', '/projects/p1', body={'name': 'x'})[0] == 200
        assert call(STRANGER, 'DELETE', '/projects/p1') == (403, CANNOT_MANAGE)

    @pytest.mark.usefixtures('private_project', 'table')
    def test_admins_skip_the_gate_read(self, call):
        import projects_handler

        with patch.object(projects_handler, '_gate_meta') as gate_read:
            status, _ = call(ADMIN, 'POST', '/projects/p1/chat-context',
                             body={'selected_document_ids': []})

        assert status == 200
        gate_read.assert_not_called()


# ---------------------------------------------------------------------------
# MCP credentials act as their minter
# ---------------------------------------------------------------------------

class TestDelegatedCallers:
    @pytest.mark.usefixtures('private_project')
    def test_a_token_acts_as_its_minter_capped_at_editor(self, call):
        assert call(_delegated(OWNER['sub']), 'GET', '/projects/p1')[0] == 200
        assert call(_delegated(OWNER['sub']), 'DELETE', '/projects/p1') == (403, CANNOT_MANAGE)

    @pytest.mark.usefixtures('private_project')
    def test_a_token_of_a_stranger_sees_nothing_private(self, call):
        assert call(_delegated(STRANGER['sub']), 'GET', '/projects/p1') == (404, NOT_FOUND)

    @pytest.mark.usefixtures('private_project')
    def test_a_legacy_token_reaches_public_projects_only(self, call, table):
        _seed(table, 'p2', visibility='public')

        assert call(_delegated(None), 'GET', '/projects/p1') == (404, NOT_FOUND)
        assert call(_delegated(None), 'GET', '/projects/p2')[0] == 200

    def test_a_token_cannot_create_projects(self, call):
        status, _ = call(_delegated(OWNER['sub']), 'POST', '/projects', body={'name': 'x'})

        assert status == 403

    @pytest.mark.usefixtures('private_project')
    def test_a_token_cannot_make_its_minter_leave(self, call):
        status, _ = call(_delegated(VIEWER['sub']), 'DELETE', f'/projects/p1/members/{VIEWER["sub"]}')

        assert status == 403


class TestCreateListGet:
    def test_create_stamps_the_owner_and_defaults_private(self, call, table):
        status, body = call(OWNER, 'POST', '/projects', body={'name': 'Mine'})

        assert status == 200
        project = body['project']
        assert project['visibility'] == 'private'
        assert project['owner'] == {'sub': 'owner-sub', 'username': 'olivia',
                                    'email': 'olivia@example.com'}
        assert project['access']['role'] == 'owner'
        assert project['members'] == []
        assert project['member_count'] == 0
        stored = _meta(table, project['project_id'])
        assert stored['owner_sub'] == 'owner-sub'
        assert stored['members'] == {}
        assert 'access' not in stored
        assert 'member_count' not in stored

    def test_create_accepts_public(self, call):
        assert call(OWNER, 'POST', '/projects',
                    body={'name': 'x', 'visibility': 'public'})[1]['project']['visibility'] == 'public'

    def test_create_rejects_an_unknown_visibility(self, call):
        assert call(OWNER, 'POST', '/projects', body={'name': 'x', 'visibility': 'team'})[0] == 400

    @pytest.mark.usefixtures('private_project')
    def test_list_shows_only_viewable_projects_with_sharing_fields(self, call, table):
        _seed(table, 'p2', visibility='public', owner=STRANGER)

        stranger = call(STRANGER, 'GET', '/projects')[1]['projects']
        viewer = call(VIEWER, 'GET', '/projects')[1]['projects']

        assert [p['project_id'] for p in stranger] == ['p2']
        by_id = {p['project_id']: p for p in viewer}
        assert set(by_id) == {'p1', 'p2'}
        assert by_id['p1']['access']['role'] == 'viewer'
        assert by_id['p1']['member_count'] == 2
        assert by_id['p1']['owner']['sub'] == 'owner-sub'
        assert 'members' not in by_id['p1']

    @pytest.mark.usefixtures('private_project')
    def test_list_tells_each_caller_whether_it_may_edit_and_manage(self, call):
        # The Projects list shows Edit on can_edit and the visibility choice on
        # can_manage, reading these from GET /projects without a per-card fetch.
        def flags(claims):
            access = call(claims, 'GET', '/projects')[1]['projects'][0]['access']
            return access['can_edit'], access['can_manage']

        assert flags(OWNER) == (True, True)
        assert flags(ADMIN) == (True, True)
        assert flags(EDITOR) == (True, False)
        assert flags(VIEWER) == (False, False)

    @pytest.mark.usefixtures('private_project')
    def test_a_blank_rename_is_a_400_and_leaves_the_name(self, call, table):
        status, body = call(EDITOR, 'PUT', '/projects/p1', body={'name': '  '})

        assert status == 400
        assert body['success'] is False
        assert _meta(table)['name'] == 'Project p1'

    @pytest.mark.usefixtures('private_project')
    def test_get_attaches_the_members_list(self, call):
        status, body = call(VIEWER, 'GET', '/projects/p1')

        assert status == 200
        members = body['project']['members']
        assert [m['sub'] for m in members] == ['editor-sub', 'viewer-sub']
        # No `email`: a viewer cannot manage the project (see TestEmailsAreForManagers).
        assert set(members[0]) == {'sub', 'role', 'username', 'added_by', 'added_at'}
        assert body['project']['access']['role'] == 'viewer'

    @pytest.mark.usefixtures('private_project')
    def test_update_project_can_never_write_sharing_fields(self, call, table):
        status, _ = call(EDITOR, 'PUT', '/projects/p1', body={
            'name': 'Renamed', 'visibility': 'public', 'owner_sub': EDITOR['sub'],
            'members': {}, 'owner': {'sub': 'x'}, 'access': {'role': 'owner'},
        })

        meta = _meta(table)
        assert status == 200
        assert meta['name'] == 'Renamed'
        assert meta['visibility'] == 'private'
        assert meta['owner_sub'] == OWNER['sub']
        assert set(meta['members']) == {EDITOR['sub'], VIEWER['sub']}
        assert 'owner' not in meta
        assert 'access' not in meta


def _emails_in(value) -> list[str]:
    """Every string containing '@' anywhere in a response body."""
    if isinstance(value, dict):
        return [found for item in value.values() for found in _emails_in(item)]
    if isinstance(value, list):
        return [found for item in value for found in _emails_in(item)]
    return [value] if isinstance(value, str) and '@' in value else []


class TestEmailsAreForManagers:
    """Owner and member emails reach only a caller who can MANAGE the project.

    An email is a contact detail; the owner and admins manage membership and need
    it, everyone else sees the same owner and member entries without it. Every
    read that carries owner or member identity is covered: the list, the project
    GET (including the raw `owner_email` a META copy carries) and the members route.
    """

    MEMBER_KEYS = frozenset({'sub', 'role', 'username', 'added_by', 'added_at'})

    @pytest.mark.usefixtures('private_project')
    @pytest.mark.parametrize('caller', [VIEWER, EDITOR], ids=['viewer', 'editor'])
    def test_a_member_sees_no_email_on_any_read(self, call, caller):
        listed = call(caller, 'GET', '/projects')
        project = call(caller, 'GET', '/projects/p1')
        members = call(caller, 'GET', '/projects/p1/members')

        assert [listed[0], project[0], members[0]] == [200, 200, 200]
        assert _emails_in([listed[1], project[1], members[1]]) == []
        assert members[1]['owner'] == {'sub': OWNER['sub'], 'username': 'olivia'}
        assert all(set(m) == self.MEMBER_KEYS for m in members[1]['members'])
        assert 'owner_email' not in project[1]['project']

    @pytest.mark.usefixtures('private_project')
    @pytest.mark.parametrize('caller', [OWNER, ADMIN], ids=['owner', 'admin'])
    def test_a_manager_sees_every_email(self, call, caller):
        listed = call(caller, 'GET', '/projects')[1]['projects']
        project = call(caller, 'GET', '/projects/p1')[1]['project']
        members = call(caller, 'GET', '/projects/p1/members')[1]

        assert listed[0]['owner']['email'] == OWNER['email']
        assert project['owner']['email'] == OWNER['email']
        assert project['owner_email'] == OWNER['email']
        assert {m['email'] for m in project['members']} == {EDITOR['email'], VIEWER['email']}
        assert members['owner']['email'] == OWNER['email']
        assert {m['email'] for m in members['members']} == {EDITOR['email'], VIEWER['email']}

    def test_a_public_projects_non_member_editor_sees_no_email(self, call, table):
        _seed(table, visibility='public', members={VIEWER['sub']: _member(VIEWER, 'viewer')})

        project = call(STRANGER, 'GET', '/projects/p1')
        members = call(STRANGER, 'GET', '/projects/p1/members')

        assert project[1]['project']['access']['role'] == 'editor'
        assert _emails_in([project[1], members[1]]) == []


# ---------------------------------------------------------------------------
# Sharing routes
# ---------------------------------------------------------------------------

class TestVisibility:
    @pytest.mark.usefixtures('private_project')
    def test_owner_makes_it_public(self, call, table):
        assert call(OWNER, 'PUT', '/projects/p1/visibility', body={'visibility': 'public'}) == (
            200, {'success': True, 'visibility': 'public'})
        assert _meta(table)['visibility'] == 'public'
        assert call(STRANGER, 'GET', '/projects/p1')[0] == 200

    @pytest.mark.usefixtures('private_project')
    def test_editor_cannot(self, call):
        assert call(EDITOR, 'PUT', '/projects/p1/visibility',
                    body={'visibility': 'public'}) == (403, CANNOT_MANAGE)

    @pytest.mark.usefixtures('private_project')
    def test_validates(self, call):
        assert call(OWNER, 'PUT', '/projects/p1/visibility', body={'visibility': 'x'})[0] == 400


class TestMembers:
    @pytest.mark.usefixtures('private_project')
    def test_list(self, call):
        status, body = call(VIEWER, 'GET', '/projects/p1/members')

        assert status == 200
        assert body['visibility'] == 'private'
        assert body['owner']['sub'] == OWNER['sub']
        assert len(body['members']) == 2
        assert body['access']['role'] == 'viewer'

    @pytest.mark.usefixtures('private_project')
    def test_add(self, call, table):
        status, body = call(OWNER, 'POST', '/projects/p1/members',
                            body={'sub': 'stranger-sub', 'role': 'viewer'})

        assert status == 200
        assert body['member']['username'] == 'sam'
        stored = _meta(table)['members']['stranger-sub']
        assert stored['role'] == 'viewer'
        assert stored['added_by'] == OWNER['sub']
        assert call(STRANGER, 'GET', '/projects/p1')[0] == 200

    def test_add_to_a_legacy_project_without_a_members_map(self, call, table):
        _seed(table, visibility='private', members=None)

        assert call(OWNER, 'POST', '/projects/p1/members',
                    body={'sub': 'stranger-sub', 'role': 'editor'})[0] == 200
        assert _meta(table)['members']['stranger-sub']['role'] == 'editor'

    @pytest.mark.parametrize(('sub', 'status'), [
        ('editor-sub', 409), ('owner-sub', 409), ('nobody-sub', 404), ('disabled-sub', 404),
    ])
    @pytest.mark.usefixtures('private_project')
    def test_add_refusals(self, call, sub, status):
        assert call(OWNER, 'POST', '/projects/p1/members',
                    body={'sub': sub, 'role': 'viewer'})[0] == status

    @pytest.mark.parametrize('body', [
        {'sub': 'stranger-sub', 'role': 'owner'},
        {'sub': 'stranger-sub'},
        {'sub': 'a"b', 'role': 'viewer'},
        {'sub': '', 'role': 'viewer'},
        {'sub': 'mcp:tok', 'role': 'viewer'},
    ])
    @pytest.mark.usefixtures('private_project')
    def test_add_validates(self, call, body):
        assert call(OWNER, 'POST', '/projects/p1/members', body=body)[0] == 400

    def test_add_enforces_the_member_cap(self, call, table):
        full = {f'user-{i}': {'role': 'viewer'} for i in range(project_access.MAX_PROJECT_MEMBERS)}
        _seed(table, members=full)

        assert call(OWNER, 'POST', '/projects/p1/members',
                    body={'sub': 'stranger-sub', 'role': 'viewer'})[0] == 400

    @pytest.mark.usefixtures('private_project')
    def test_editor_cannot_add(self, call):
        assert call(EDITOR, 'POST', '/projects/p1/members',
                    body={'sub': 'stranger-sub', 'role': 'viewer'}) == (403, CANNOT_MANAGE)

    @pytest.mark.usefixtures('private_project')
    def test_update_role(self, call, table):
        status, body = call(OWNER, 'PUT', '/projects/p1/members/viewer-sub', body={'role': 'editor'})

        assert status == 200
        assert body['member']['role'] == 'editor'
        assert _meta(table)['members']['viewer-sub']['role'] == 'editor'

    @pytest.mark.usefixtures('private_project')
    def test_update_a_non_member(self, call):
        assert call(OWNER, 'PUT', '/projects/p1/members/stranger-sub',
                    body={'role': 'editor'})[0] == 404

    def test_update_on_a_project_without_a_members_map(self, call, table):
        _seed(table, members=None)

        assert call(OWNER, 'PUT', '/projects/p1/members/stranger-sub',
                    body={'role': 'editor'})[0] == 404

    @pytest.mark.usefixtures('private_project')
    def test_owner_removes(self, call, table):
        assert call(OWNER, 'DELETE', '/projects/p1/members/editor-sub') == (200, {'success': True})
        assert 'editor-sub' not in _meta(table)['members']

    @pytest.mark.usefixtures('private_project', 'table')
    def test_member_leaves(self, call):
        assert call(VIEWER, 'DELETE', '/projects/p1/members/viewer-sub')[0] == 200
        assert call(VIEWER, 'GET', '/projects/p1') == (404, NOT_FOUND)

    @pytest.mark.usefixtures('private_project')
    def test_member_cannot_remove_someone_else(self, call):
        assert call(VIEWER, 'DELETE', '/projects/p1/members/editor-sub') == (403, CANNOT_MANAGE)

    @pytest.mark.usefixtures('private_project')
    def test_remove_a_non_member(self, call):
        assert call(OWNER, 'DELETE', '/projects/p1/members/stranger-sub')[0] == 404

    def test_writes_respect_the_tombstone(self, call, table):
        _seed(table, members={}, status='deleting', deletion_started_at='2026-01-01')

        assert call(ADMIN, 'POST', '/projects/p1/members',
                    body={'sub': 'stranger-sub', 'role': 'viewer'})[0] == 404


class TestCandidates:
    @pytest.mark.usefixtures('private_project')
    def test_prefix_search_merges_dedups_and_excludes(self, call, cognito):
        status, body = call(OWNER, 'GET', '/projects/p1/members/candidates', query={'q': 'sam'})

        assert status == 200
        # sam: username + email both match -> listed once; sabine is disabled.
        assert [u['sub'] for u in body['users']] == ['stranger-sub']
        assert body['users'][0] == {'sub': 'stranger-sub', 'username': 'sam',
                                    'email': 'sam@example.com', 'name': 'Sam Stranger'}
        assert [c['Filter'] for c in cognito.calls] == ['username ^= "sam"', 'email ^= "sam"']
        assert all(c['UserPoolId'] == 'us-east-1_testpool' for c in cognito.calls)

    @pytest.mark.usefixtures('private_project')
    def test_an_email_only_match_is_found(self, call):
        body = call(OWNER, 'GET', '/projects/p1/members/candidates', query={'q': 'sa@'})[1]

        assert [u['sub'] for u in body['users']] == ['sara-sub']

    @pytest.mark.usefixtures('private_project')
    def test_excludes_owner_and_members(self, call):
        body = call(OWNER, 'GET', '/projects/p1/members/candidates', query={'q': 'example'})[1]
        assert body['users'] == []

        # Prefixes that would match them by username still exclude them.
        for q in ('oli', 'edd', 'ver', 'sab'):
            assert call(OWNER, 'GET', '/projects/p1/members/candidates',
                        query={'q': q})[1]['users'] == []

    @pytest.mark.parametrize('q', ['', 's', 'sa', '  ', ' s '])
    @pytest.mark.usefixtures('private_project')
    def test_short_queries_are_refused_without_a_directory_call(
        self, call, cognito, q,
    ):
        status, body = call(OWNER, 'GET', '/projects/p1/members/candidates', query={'q': q})

        assert status == 400
        assert body['success'] is False
        assert cognito.calls == []

    @pytest.mark.usefixtures('private_project')
    def test_a_missing_query_is_refused(self, call, cognito):
        assert call(OWNER, 'GET', '/projects/p1/members/candidates')[0] == 400
        assert cognito.calls == []

    def test_the_minimum_is_three(self):
        import projects

        assert projects.MIN_CANDIDATE_QUERY_LENGTH == 3

    @pytest.mark.parametrize('q', ['a"bc', 'a\\bc', 'x' * 65])
    @pytest.mark.usefixtures('private_project')
    def test_rejects_unsafe_queries(self, call, q):
        assert call(OWNER, 'GET', '/projects/p1/members/candidates', query={'q': q})[0] == 400

    @pytest.mark.usefixtures('private_project')
    def test_viewer_cannot_search(self, call):
        assert call(VIEWER, 'GET', '/projects/p1/members/candidates',
                    query={'q': 'sam'}) == (403, CANNOT_MANAGE)

    @pytest.mark.usefixtures('private_project')
    def test_requires_a_user_pool(self, call, monkeypatch):
        monkeypatch.delenv('USER_POOL_ID')

        assert call(OWNER, 'GET', '/projects/p1/members/candidates', query={'q': 'sam'})[0] == 500


class TestOwnerTransfer:
    @pytest.mark.usefixtures('private_project')
    def test_to_a_member(self, call, table):
        status, body = call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'viewer-sub'})

        assert status == 200
        assert body['owner'] == {'sub': 'viewer-sub', 'username': 'vera', 'email': 'vera@example.com'}
        meta = _meta(table)
        assert meta['owner_sub'] == 'viewer-sub'
        assert 'viewer-sub' not in meta['members']
        assert meta['members']['owner-sub']['role'] == 'editor'
        assert call(OWNER, 'DELETE', '/projects/p1') == (403, CANNOT_MANAGE)

    def test_to_a_directory_user_on_a_legacy_project(self, call, table):
        _seed(table, visibility=None, owner=None, members=None)

        assert call(ADMIN, 'POST', '/projects/p1/owner', body={'sub': 'stranger-sub'})[0] == 200
        meta = _meta(table)
        assert meta['owner_sub'] == 'stranger-sub'
        assert meta['members'] == {}

    @pytest.mark.usefixtures('private_project')
    def test_to_an_unknown_user(self, call):
        assert call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'nobody'})[0] == 404

    @pytest.mark.usefixtures('private_project')
    def test_editor_cannot_transfer(self, call):
        assert call(EDITOR, 'POST', '/projects/p1/owner',
                    body={'sub': 'editor-sub'}) == (403, CANNOT_MANAGE)


class TestOwnerTransferSafety:
    def test_a_disabled_member_cannot_become_owner(self, call, table):
        _seed(table, members={'disabled-sub': {**_member(VIEWER, 'editor'), 'username': 'sabine'}})

        assert call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'disabled-sub'})[0] == 404
        assert _meta(table)['owner_sub'] == OWNER['sub']

    @pytest.mark.usefixtures('private_project')
    def test_a_member_is_resolved_through_the_directory(self, call, cognito):
        status, body = call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'viewer-sub'})

        assert status == 200
        assert body['owner']['username'] == 'vera'
        assert [c['Filter'] for c in cognito.calls] == ['sub = "viewer-sub"']

    def test_identity_comes_from_cognito_not_the_stale_member_entry(self, call, table):
        _seed(table, members={'viewer-sub': {**_member(VIEWER, 'viewer'),
                                             'username': 'old-name', 'email': 'old@x'}})

        owner = call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'viewer-sub'})[1]['owner']

        assert owner == {'sub': 'viewer-sub', 'username': 'vera', 'email': 'vera@example.com'}
        assert _meta(table)['owner_username'] == 'vera'

    def test_a_demoted_owner_is_refused_on_the_fresh_read(self, table, cognito):
        import projects

        _seed(table, owner=VIEWER, members={OWNER['sub']: _member(OWNER, 'editor')})
        with (
            patch.object(projects, 'projects_table', table),
            patch.object(projects, '_get_cognito_client', return_value=cognito),
            pytest.raises(projects.ConflictError, match='Project ownership changed; reload and retry'),
        ):
            projects.transfer_project_owner(
                'p1', {'sub': 'stranger-sub'}, project_access.Caller(subject=OWNER['sub']),
            )
        assert _meta(table)['owner_sub'] == VIEWER['sub']

    @pytest.mark.usefixtures('private_project')
    def test_a_demoted_owner_loses_the_race_at_the_write(self, call, table):
        """The read saw OLIVIA as owner; by the write, ownership already moved."""
        import projects

        real_read = projects.read_project_meta
        reads = []

        def read_then_lose_ownership(project_id):
            # Passes the gate and the fresh read as OLIVIA, then a concurrent
            # transfer lands before this request's conditional write.
            meta = real_read(project_id)
            if not reads:
                table.update_item(Key={'pk': 'PROJECT#p1', 'sk': 'META'},
                                  UpdateExpression='SET owner_sub = :v',
                                  ExpressionAttributeValues={':v': VIEWER['sub']})
            reads.append(meta)
            return meta

        with patch.object(projects, 'read_project_meta', side_effect=read_then_lose_ownership):
            status, body = call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'stranger-sub'})

        assert (status, body) == (409, {'success': False,
                                        'error': 'Project ownership changed; reload and retry'})
        assert _meta(table)['owner_sub'] == VIEWER['sub']

    @pytest.mark.usefixtures('private_project')
    def test_admins_are_not_held_to_being_the_owner(self, call, table):
        assert call(ADMIN, 'POST', '/projects/p1/owner', body={'sub': 'viewer-sub'})[0] == 200
        assert _meta(table)['owner_sub'] == 'viewer-sub'

    def test_re_adding_the_previous_owner_respects_the_cap_at_the_write(
        self, call, table,
    ):
        import projects

        cap = project_access.MAX_PROJECT_MEMBERS
        _seed(table, members={f'user-{i}': {'role': 'viewer'} for i in range(cap)})
        stale = dict(_meta(table))
        stale['members'] = {f'user-{i}': {'role': 'viewer'} for i in range(cap - 1)}
        with patch.object(projects, 'read_project_meta', side_effect=[stale, stale]):
            status, _ = call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'stranger-sub'})

        meta = _meta(table)
        assert status == 409
        assert meta['owner_sub'] == OWNER['sub']
        assert len(meta['members']) == cap

    def test_a_full_project_can_still_hand_over_to_a_member(self, call, table):
        cap = project_access.MAX_PROJECT_MEMBERS
        members = {f'user-{i}': {'role': 'viewer'} for i in range(cap - 1)}
        members['viewer-sub'] = _member(VIEWER, 'viewer')
        _seed(table, members=members)

        assert call(OWNER, 'POST', '/projects/p1/owner', body={'sub': 'viewer-sub'})[0] == 200
        meta = _meta(table)
        assert meta['owner_sub'] == 'viewer-sub'
        assert len(meta['members']) == cap
        assert meta['members'][OWNER['sub']]['role'] == 'editor'


# ---------------------------------------------------------------------------
# Warm-container isolation and gate read failures
# ---------------------------------------------------------------------------

class TestNoCallerLeaksAcrossInvocations:
    """A request that raised must not leave its caller for the next request."""

    def _boom(self, *_args, **_kwargs):
        raise RuntimeError('unexpected failure inside the route')

    @pytest.mark.usefixtures('private_project')
    def test_a_failed_request_does_not_hand_its_caller_to_list(self, call, table):
        import projects_handler

        _seed(table, 'p2', visibility='public', owner=STRANGER)
        with patch.object(projects_handler, 'get_project', side_effect=self._boom):
            assert call(VIEWER, 'GET', '/projects/p1')[0] == 500
        assert projects_handler.app.context == {}

        status, body = call(STRANGER, 'GET', '/projects')

        assert status == 200
        # The viewer could see p1; the stranger must not inherit that.
        assert [p['project_id'] for p in body['projects']] == ['p2']
        assert body['projects'][0]['access']['role'] == 'owner'
        assert projects_handler.app.context == {}

    @pytest.mark.usefixtures('private_project')
    def test_a_failed_request_does_not_hand_its_caller_to_create(self, call, table):
        import projects_handler

        with patch.object(projects_handler, 'get_project', side_effect=self._boom):
            assert call(OWNER, 'GET', '/projects/p1')[0] == 500

        status, body = call(STRANGER, 'POST', '/projects', body={'name': 'Theirs'})

        assert status == 200
        assert body['project']['owner']['sub'] == STRANGER['sub']
        assert _meta(table, body['project']['project_id'])['owner_sub'] == STRANGER['sub']
        assert projects_handler.app.context == {}

    @pytest.mark.usefixtures('private_project')
    def test_stale_context_is_overwritten_even_if_it_survived(self, call):
        """Belt and braces: the middleware rewrites both keys on every request."""
        import projects_handler

        projects_handler.app.append_context(**{
            projects_handler._CALLER_CONTEXT_KEY: project_access.Caller(subject=VIEWER['sub']),
            projects_handler._ACCESS_CONTEXT_KEY: project_access.ProjectAccess(role='viewer'),
        })

        body = call(STRANGER, 'GET', '/projects')[1]

        assert body['projects'] == []
        assert projects_handler.app.context == {}

    def test_request_caller_fails_closed_without_context(self):
        import projects_handler

        projects_handler.app.clear_context()
        with pytest.raises(projects_handler.AuthorizationError):
            projects_handler._request_caller()


class TestGateReadFailure:
    @pytest.mark.parametrize(('method', 'path'), [
        ('GET', '/projects/p1'), ('PUT', '/projects/p1'), ('POST', '/projects/p1/members'),
    ])
    @pytest.mark.usefixtures('private_project')
    def test_a_failed_gate_read_is_a_json_500(self, call, table, method, path):
        from botocore.exceptions import ClientError

        error = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'x'}}, 'GetItem')
        with patch.object(table, 'get_item', side_effect=error):
            status, body = call(VIEWER, method, path, body={'name': 'x'})

        assert (status, body) == (500, {'success': False,
                                        'error': 'Could not verify project access. Please retry.'})


# ---------------------------------------------------------------------------
# get_project signs nothing for a refused caller; list follows every page
# ---------------------------------------------------------------------------

class TestTheInternalReadCarriesNoEmail:
    """``get_project`` without a caller (the generation pipelines) withholds every
    owner/member email by default, so a future route that forgets the caller
    cannot leak one; the rest of META (filters, name, members' roles) survives."""

    def test_no_owner_or_member_email_without_a_caller(self, table):
        import projects

        _seed(table, members={VIEWER['sub']: _member(VIEWER, 'viewer'),
                              EDITOR['sub']: _member(EDITOR, 'editor')},
              filters={'sources': ['webscraper']})
        with patch.object(projects, 'projects_table', table):
            project = projects.get_project('p1')['project']

        assert _emails_in(project) == []
        assert 'owner_email' not in project
        assert project['owner_sub'] == OWNER['sub']
        assert project['filters'] == {'sources': ['webscraper']}
        assert project['members'][VIEWER['sub']] == {
            key: value for key, value in _member(VIEWER, 'viewer').items() if key != 'email'}

    def test_the_stored_row_is_not_modified(self, table):
        import projects

        _seed(table, members={VIEWER['sub']: _member(VIEWER, 'viewer')})
        with patch.object(projects, 'projects_table', table):
            projects.get_project('p1')

        stored = table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'META'})['Item']
        assert stored['owner_email'] == OWNER['email']
        assert stored['members'][VIEWER['sub']]['email'] == VIEWER['email']


class TestGetProjectSigning:
    def _seed_signable(self, table):
        _seed(table, members={VIEWER['sub']: _member(VIEWER, 'viewer')})
        table.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'persona_id': 'a',
                             'avatar_url': 's3://bucket/avatars/p1/a.png'})
        table.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#d1', 'document_id': 'd1',
                             'document_type': 'prototype', 'title': 'Proto'})

    def test_a_stranger_causes_no_signing(self, table):
        import projects

        self._seed_signable(table)
        with (
            patch.object(projects, 'projects_table', table),
            patch.object(projects, 'get_avatar_cdn_url') as avatar_signer,
            patch.object(projects, 'prototype_signed_url') as prototype_signer,
            pytest.raises(projects.NotFoundError),
        ):
            projects.get_project('p1', project_access.Caller(subject=STRANGER['sub']))

        avatar_signer.assert_not_called()
        prototype_signer.assert_not_called()

    def test_a_viewer_gets_signed_urls(self, table):
        import projects

        self._seed_signable(table)
        with (
            patch.object(projects, 'projects_table', table),
            patch.object(projects, 'get_avatar_cdn_url', return_value='https://cdn/a') as avatar,
            patch.object(projects, 'prototype_signed_url', return_value='https://cdn/p') as proto,
        ):
            result = projects.get_project('p1', project_access.Caller(subject=VIEWER['sub']))

        assert result['personas'][0]['avatar_url'] == 'https://cdn/a'
        assert result['documents'][0]['prototype_url'] == 'https://cdn/p'
        avatar.assert_called_once()
        proto.assert_called_once_with('p1', 'd1')


class TestListProjectsPagination:
    def _row(self, project_id):
        return {'pk': f'PROJECT#{project_id}', 'sk': 'META', 'project_id': project_id,
                'name': project_id, 'visibility': 'public'}

    def test_follows_the_index_and_count_cursors(self):
        from unittest.mock import MagicMock

        import projects

        index_pages = [
            {'Items': [self._row('a')], 'LastEvaluatedKey': {'k': 1}},
            {'Items': [self._row('b')]},
        ]
        count_pages = {
            'PROJECT#a': [
                {'Items': [{'sk': 'META'}, {'sk': 'PERSONA#1'}], 'LastEvaluatedKey': {'k': 2}},
                {'Items': [{'sk': 'PERSONA#2'}, {'sk': 'PRD#1'}]},
            ],
            'PROJECT#b': [{'Items': [{'sk': 'META'}, {'sk': 'PROTOTYPE#1'}]}],
        }
        calls = []

        def query(**kwargs):
            calls.append(kwargs)
            if kwargs.get('IndexName'):
                return index_pages.pop(0)
            partition = kwargs['KeyConditionExpression'].get_expression()['values'][1]
            return count_pages[partition].pop(0)

        table = MagicMock()
        table.query.side_effect = query
        with patch.object(projects, 'projects_table', table):
            result = projects.list_projects(project_access.Caller(subject=STRANGER['sub']))

        counts = {p['project_id']: (p['persona_count'], p['document_count'])
                  for p in result['projects']}
        assert counts == {'a': (2, 1), 'b': (0, 1)}
        index_calls = [c for c in calls if c.get('IndexName')]
        assert index_calls[1]['ExclusiveStartKey'] == {'k': 1}
        assert 'ExclusiveStartKey' not in index_calls[0]
        count_calls_a = [c for c in calls if not c.get('IndexName')][:2]
        assert count_calls_a[1]['ExclusiveStartKey'] == {'k': 2}
