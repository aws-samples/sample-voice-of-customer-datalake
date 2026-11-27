"""The project core routes in a workspace, behind the seam (docs/multi-workspace.md, "3h, the switch"; 3h-S3a).

The projects API takes its scope from shared/project_request_scope.py ``project_scope``, which answers the deployment
until the flip (3h-S12): ``RESOLVE`` is off, so ``X-Workspace-Id`` is ignored as it always was (pinned below, and
by every other suite of the API). These cases turn ``RESOLVE`` on and prove the routes that take the seam are ready:
in moto, two workspaces, A (``alderbrook``) and B (``bramblewood``), each with a project, and a deployment project
beside them. A's member sees A's projects only; B's member gets, for A's project, exactly the 404 of an id that
exists nowhere, on every threaded route; the deployment's ``admins`` group grants nothing in A; A's viewer reads and
does not write; a project's members and owner are A's members only; an agent creates nothing in A; and every route
the seam does not reach yet is refused by name in a workspace, never served from the deployment's rows.

The routes stay in cross_workspace_pending.py: in production they act deployment-wide until the flip.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event, workspace_route_call

import projects_handler
from shared.indexes import PROJECTS_BY_TYPE_INDEX

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
P_A = 'proj_20261127090000_aaaa0000'
P_B = 'proj_20261127090000_bbbb1111'
P_DEP = 'proj_20261127090000_dddd3333'
UNKNOWN = 'proj_20261127090000_eeee4444'
#: A project of A whose owner has since left A (seeded by its own case).
P_GONE = 'proj_20261127090000_ffff5555'
NOW = '2026-11-27T09:00:00+00:00'

ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'users'}  # A's admin, owns A's project
ED = {'sub': 'sub-ed', 'cognito:username': 'ed', 'cognito:groups': 'users'}  # A's editor, an editor of it
#: A's viewer, an editor of A's project, and in the deployment's ``admins``: still only a viewer in A.
VI = {'sub': 'sub-vi', 'cognito:username': 'vi', 'cognito:groups': '[admins, users]'}
BEA = {'sub': 'sub-bramblewood-bea', 'cognito:username': 'bramblewood-bea', 'cognito:groups': 'users'}  # B's admin
#: In the deployment's ``admins``, no workspace's member.
DEPLOYMENT_ADMIN = {'sub': 'sub-dan', 'cognito:username': 'dan', 'cognito:groups': '[admins, users]'}
#: An agent acting for A's editor.
AGENT = {'sub': 'agent:agent-1', 'voc:acting_subject': 'sub-ed'}
OUTSIDER = 'sub-otto'  # a real account, in no workspace

#: Fay is A's editor and on none of its projects (the picker's and the add's member).
MEMBERS = {WS_A: {'sub-ada': 'admin', 'sub-ed': 'editor', 'sub-vi': 'viewer', 'sub-fay': 'editor'},
           WS_B: {'sub-bramblewood-bea': 'admin'}}


def _meta(pk: str, project_id: str, gsi1pk: str, name: str, owner: str, members: dict[str, str]) -> dict:
    return {'pk': pk, 'sk': 'META', 'gsi1pk': gsi1pk, 'gsi1sk': NOW, 'project_id': project_id, 'name': name,
            'description': '', 'status': 'active', 'created_at': NOW, 'updated_at': NOW, 'visibility': 'private',
            'owner_sub': owner, 'owner_username': owner.removeprefix('sub-'), 'owner_email': f'{owner}@example.com',
            'members': {sub: {'role': role, 'username': sub.removeprefix('sub-'), 'email': f'{sub}@example.com',
                              'added_by': owner, 'added_at': NOW} for sub, role in members.items()}}


def _seed(projects: Any, workspaces: Any) -> None:
    for ws, members in MEMBERS.items():
        workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': ws, 'slug': ws, 'status': 'active'})
        for sub, role in members.items():
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f'MEMBER#{sub}', 'role': role})
    for ws, project_id, name, owner, members in (
            (WS_A, P_A, 'alderbrook launch', 'sub-ada', {'sub-ed': 'editor', 'sub-vi': 'editor'}),
            (WS_B, P_B, 'bramblewood launch', 'sub-bramblewood-bea', {})):
        pk = f'WS#{ws}#PROJECT#{project_id}'
        projects.put_item(Item=_meta(pk, project_id, f'WS#{ws}#TYPE#PROJECT', name, owner, members))
        projects.put_item(Item={'pk': pk, 'sk': 'PERSONA#pe1', 'persona_id': 'pe1', 'name': f'{name} persona'})
        projects.put_item(Item={'pk': pk, 'sk': 'DOC#d1', 'document_id': 'd1', 'document_type': 'custom',
                                'title': f'{name} notes', 'content': name, 'created_at': NOW,
                                'gsi1pk': f'{pk}#DOCUMENTS', 'gsi1sk': NOW})
    projects.put_item(Item={**_meta(f'PROJECT#{P_DEP}', P_DEP, 'TYPE#PROJECT', 'deployment launch', 'sub-dan', {}),
                            'visibility': 'public'})


def _cognito_user(sub: str) -> dict:
    return {'Username': sub.removeprefix('sub-'), 'Enabled': True,
            'Attributes': [{'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': f'{sub}@example.com'}]}


def _list_users(**params: Any) -> dict:
    """ListUsers: a sub filter finds that account; a prefix search finds A's editor Fay and the outsider Otto."""
    field, _, value = params.get('Filter', '').partition(' ')
    if field == 'sub':
        return {'Users': [_cognito_user(value.split('"')[1])]}
    return {'Users': [_cognito_user('sub-fay'), _cognito_user(OUTSIDER)]}


@dataclass(frozen=True)
class World:
    """``world(method, path, claims, ws=None, body=None, query=None) -> (status, body)`` with the seam ON, and the
    projects table it reads."""

    call: Callable[..., tuple[int, Any]]
    table: Any

    def __call__(self, method: str, path: str, claims: dict, **options: Any) -> tuple[int, Any]:
        return self.call(method, path, claims, **options)


@pytest.fixture
def world(lambda_context, monkeypatch) -> Iterator[World]:
    """The two workspaces and the deployment project in moto, the projects API over them, the seam ON."""
    import projects
    from shared import project_request_scope, request_workspace
    from shared.workspace import MembershipCache

    monkeypatch.setenv('WORKSPACES_TABLE', 'workspaces')
    monkeypatch.setenv('PROJECTS_TABLE', 'projects')  # a workspace's create checks its claim's table by name
    monkeypatch.setattr(project_request_scope, 'RESOLVE', True)
    monkeypatch.setattr(request_workspace, '_MEMBERSHIPS', MembershipCache())
    cognito = MagicMock()
    cognito.list_users.side_effect = _list_users
    with mock_aws():
        table = pk_sk_table('projects', gsi1_index=PROJECTS_BY_TYPE_INDEX)
        workspaces = pk_sk_table('workspaces')
        _seed(table, workspaces)
        monkeypatch.setattr(request_workspace, 'cached_table', lambda *_: workspaces)
        monkeypatch.setattr(projects, 'projects_table', table)
        monkeypatch.setattr(projects, '_get_cognito_client', lambda: cognito)
        monkeypatch.setattr(projects_handler, 'get_projects_table', lambda: table)

        def call(method: str, path: str, claims: dict, *, ws: str | None = None, body: Any = None,
                 query: dict | None = None) -> tuple[int, Any]:
            return workspace_route_call(projects_handler, lambda_context, method, path, claims=claims, ws=ws,
                                        body=body, query=query)

        yield World(call, table)


def _rows(table: Any) -> list[dict]:
    return sorted(table.scan(ConsistentRead=True)['Items'], key=lambda row: (row['pk'], row['sk']))


def _ids(answer: dict) -> list[str]:
    return [project['project_id'] for project in answer['projects']]


# ── The seam itself ───────────────────────────────────────────────────────────────────────────────────────────────

def test_the_seam_is_off_and_ignores_the_header_without_reading_anything():
    from shared import project_request_scope

    assert project_request_scope.RESOLVE is False
    event = rest_event('GET', '/projects', claims=ADA)
    event['headers']['X-Workspace-Id'] = WS_A
    with patch.object(project_request_scope, 'request_workspace', side_effect=AssertionError('resolved')):
        assert project_request_scope.project_scope(event, fresh=True) is project_request_scope.DEPLOYMENT


@pytest.mark.usefixtures('world')
def test_the_seam_on_resolves_a_named_workspace_and_leaves_a_request_naming_none_the_deployments():
    from shared import project_request_scope

    event = rest_event('GET', '/projects', claims=ED)
    assert project_request_scope.project_scope(event, fresh=False) is project_request_scope.DEPLOYMENT
    event['headers']['X-Workspace-Id'] = WS_A
    scope = project_request_scope.project_scope(event, fresh=True)
    assert scope.workspace is not None
    assert scope.membership is not None
    assert (scope.workspace.ws, scope.membership.subject, scope.membership.role) == (WS_A, 'sub-ed', 'editor')


def test_with_the_seam_off_a_header_changes_nothing(world, monkeypatch):
    """Production today: the list is the deployment's, whatever the header names, and A's project is not reachable."""
    from shared import project_request_scope

    monkeypatch.setattr(project_request_scope, 'RESOLVE', False)
    assert _ids(world('GET', '/projects', ED, ws=WS_A)[1]) == [P_DEP]
    assert world('GET', f'/projects/{P_A}', ADA, ws=WS_A)[0] == 404


@pytest.mark.parametrize(('method', 'path', 'query', 'fresh'), [
    ('GET', f'/projects/{P_A}', None, False), ('POST', f'/projects/{P_A}/chat-context', None, False),
    ('GET', f'/projects/{P_A}/members/candidates', {'q': 'fay'}, True), ('PUT', f'/projects/{P_A}', None, True),
])
def test_a_write_and_the_picker_resolve_fresh_and_a_read_from_the_warm_cache(world, method, path, query, fresh):
    """The chat context is a read (a POST for its body); the picker answers addresses, so it reads the table."""
    from shared import project_request_scope

    with patch.object(project_request_scope, 'request_workspace',
                      wraps=project_request_scope.request_workspace) as resolve:
        world(method, path, ED, ws=WS_A, body=None if method == 'GET' else {}, query=query)
    assert resolve.call_args.kwargs['fresh'] is fresh


def test_with_the_seam_on_a_request_naming_no_workspace_is_the_deployments(world):
    assert _ids(world('GET', '/projects', ED)[1]) == [P_DEP]
    assert world('GET', f'/projects/{P_DEP}', ED)[0] == 200


# ── Isolation ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_members_list_holds_their_workspaces_projects_only(world):
    status, answer = world('GET', '/projects', ED, ws=WS_A)
    assert (status, _ids(answer)) == (200, [P_A])
    assert answer['projects'][0]['access']['role'] == 'editor'
    assert (answer['projects'][0]['persona_count'], answer['projects'][0]['document_count']) == (1, 1)
    assert 'bramblewood' not in json.dumps(answer)
    assert 'deployment launch' not in json.dumps(answer)
    assert _ids(world('GET', '/projects', BEA, ws=WS_B)[1]) == [P_B]
    status, details = world('GET', '/projects', ED, ws=WS_A, query={'ids': f'{P_A},{P_B},{P_DEP}'})
    assert (status, [d['project']['project_id'] for d in details['details']]) == (200, [P_A])


def test_another_workspaces_header_is_the_one_404_of_a_workspace_that_does_not_exist(world):
    refused = world('GET', f'/projects/{P_B}', ED, ws=WS_B)
    assert refused == world('GET', f'/projects/{P_B}', ED, ws='ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA')
    assert (refused[0], refused[1]['error']) == (404, 'Workspace not found')


#: A body (and query) valid inside A for each threaded route of one project (projects_handler.THREADED_ROUTES).
PROJECT_ROUTE_REQUESTS: dict[tuple[str, str], tuple[dict | None, dict | None]] = {
    ('GET', '/projects/<project_id>'): (None, None),
    ('PUT', '/projects/<project_id>'): ({'name': 'Renamed'}, None),
    ('POST', '/projects/<project_id>/chat-context'): ({'selected_document_ids': ['d1']}, None),
    ('PUT', '/projects/<project_id>/visibility'): ({'visibility': 'public'}, None),
    ('POST', '/projects/<project_id>/owner'): ({'sub': 'sub-ed'}, None),
    ('GET', '/projects/<project_id>/members'): (None, None),
    ('GET', '/projects/<project_id>/members/candidates'): (None, {'q': 'fay'}),
    ('POST', '/projects/<project_id>/members'): ({'sub': 'sub-fay', 'role': 'viewer'}, None),
    ('PUT', '/projects/<project_id>/members/<member_sub>'): ({'role': 'viewer'}, None),
    ('DELETE', '/projects/<project_id>/members/<member_sub>'): (None, None),
    ('POST', '/projects/<project_id>/documents'): ({'title': 'New', 'content': 'x'}, None),
    ('PUT', '/projects/<project_id>/documents/<document_id>'): ({'content': 'edited'}, None),
    ('GET', '/projects/<project_id>/documents/<document_id>/versions'): (None, None),
    ('POST', '/projects/<project_id>/documents/<document_id>/versions/<version_id>/restore'): ({}, None),
    ('POST', '/projects/<project_id>/documents/<document_id>/duplicate'): ({'target_project_id': P_A}, None),
    ('PUT', '/projects/<project_id>/personas/<persona_id>'): ({'tagline': 'Edited'}, None),
    ('PUT', '/projects/<project_id>/personas/<persona_id>/protection'): ({'protected': True}, None),
    ('POST', '/projects/<project_id>/personas/<persona_id>/notes'): ({'text': 'A note'}, None),
}
#: The ids a route template's placeholders take (the project's own is filled per case).
PLACEHOLDERS = {'<document_id>': 'd1', '<persona_id>': 'pe1', '<member_sub>': 'sub-ed', '<version_id>': 'v1'}


def _path(template: str, project_id: str) -> str:
    path = template.replace('<project_id>', project_id)
    for placeholder, value in PLACEHOLDERS.items():
        path = path.replace(placeholder, value)
    return path


def test_every_threaded_project_route_has_its_isolation_case():
    project_routes = {key for key in projects_handler.THREADED_ROUTES if key[1] != '/projects'}
    assert set(PROJECT_ROUTE_REQUESTS) == project_routes


@pytest.mark.parametrize('route', sorted(PROJECT_ROUTE_REQUESTS), ids=lambda route: f'{route[0]} {route[1]}')
def test_another_workspaces_member_gets_a_missing_projects_404_and_changes_nothing(world, route):
    method, template = route
    body, query = PROJECT_ROUTE_REQUESTS[route]
    before = _rows(world.table)
    refused = world(method, _path(template, P_A), BEA, ws=WS_B, body=body, query=query)
    unknown = world(method, _path(template, UNKNOWN), BEA, ws=WS_B, body=body, query=query)
    assert refused == unknown
    assert refused[0] == 404
    assert _rows(world.table) == before


def test_the_deployments_admins_get_nothing_in_a_workspace(world):
    assert world('GET', '/projects', DEPLOYMENT_ADMIN, ws=WS_A)[0] == 404
    assert world('GET', f'/projects/{P_A}', DEPLOYMENT_ADMIN, ws=WS_A)[0] == 404
    # ...nor lift a member's role there: Vi is in `admins` but A's viewer.
    status, answer = world('GET', f'/projects/{P_A}', VI, ws=WS_A)
    assert (status, answer['project']['access']['role']) == (200, 'viewer')


def test_a_workspace_viewer_reads_and_does_not_write(world):
    before = _rows(world.table)
    assert world('GET', f'/projects/{P_A}', VI, ws=WS_A)[0] == 200
    assert world('POST', f'/projects/{P_A}/chat-context', VI, ws=WS_A, body={})[1]['access']['can_edit'] is False
    assert world('PUT', f'/projects/{P_A}', VI, ws=WS_A, body={'name': 'Renamed'})[0] == 403
    assert world('PUT', f'/projects/{P_A}/personas/pe1', VI, ws=WS_A, body={'tagline': 'x'})[0] == 403
    assert world('POST', '/projects', VI, ws=WS_A, body={'name': 'Mine'})[0] == 403
    assert _rows(world.table) == before


def test_a_members_writes_land_in_their_workspaces_project(world):
    assert world('PUT', f'/projects/{P_A}', ED, ws=WS_A, body={'name': 'Renamed'})[0] == 200
    assert world('PUT', f'/projects/{P_A}/personas/pe1', ED, ws=WS_A, body={'tagline': 'Edited'})[0] == 200
    status, created = world('POST', f'/projects/{P_A}/documents', ED, ws=WS_A, body={'title': 'New', 'content': 'x'})
    assert status == 200
    pk = f'WS#{WS_A}#PROJECT#{P_A}'
    row = world.table.get_item(Key={'pk': pk, 'sk': 'META'})['Item']
    assert row['name'] == 'Renamed'
    assert world.table.get_item(Key={'pk': pk, 'sk': 'PERSONA#pe1'})['Item']['tagline'] == 'Edited'
    assert world.table.get_item(Key={'pk': pk, 'sk': f'DOC#{created["document"]["document_id"]}'}).get('Item')
    assert {r['pk'] for r in _rows(world.table) if r['pk'].startswith('PROJECT#')} == {f'PROJECT#{P_DEP}'}


# ── Members and owner: the workspace's members only ───────────────────────────────────────────────────────────────

def test_the_member_picker_lists_the_workspaces_members_only(world):
    status, answer = world('GET', f'/projects/{P_A}/members/candidates', ADA, ws=WS_A, query={'q': 'fay'})
    assert (status, [user['sub'] for user in answer['users']]) == (200, ['sub-fay'])


def test_adding_someone_outside_the_workspace_is_refused(world):
    before = _rows(world.table)
    status, answer = world('POST', f'/projects/{P_A}/members', ADA, ws=WS_A, body={'sub': OUTSIDER, 'role': 'viewer'})
    assert (status, answer['error']) == (400, 'Only a member of this workspace can be added to its projects')
    # B's admin is someone too, but not A's.
    assert world('POST', f'/projects/{P_A}/members', ADA, ws=WS_A,
                 body={'sub': 'sub-bramblewood-bea', 'role': 'viewer'})[0] == 400
    assert _rows(world.table) == before
    assert world('POST', f'/projects/{P_A}/members', ADA, ws=WS_A, body={'sub': 'sub-fay', 'role': 'viewer'})[0] == 200
    meta = world.table.get_item(Key={'pk': f'WS#{WS_A}#PROJECT#{P_A}', 'sk': 'META'})['Item']
    assert meta['members']['sub-fay']['role'] == 'viewer'


def test_the_owner_transfer_takes_a_workspace_member_only(world):
    assert world('POST', f'/projects/{P_A}/owner', ADA, ws=WS_A, body={'sub': OUTSIDER})[0] == 400
    assert world('POST', f'/projects/{P_A}/owner', ADA, ws=WS_A, body={'sub': 'sub-ed'})[0] == 200
    meta = world.table.get_item(Key={'pk': f'WS#{WS_A}#PROJECT#{P_A}', 'sk': 'META'})['Item']
    assert (meta['owner_sub'], meta['members']['sub-ada']['role']) == ('sub-ed', 'editor')
    # A's admin is the workspace's admin: they still manage the project they no longer own.
    assert world('POST', f'/projects/{P_A}/owner', ADA, ws=WS_A, body={'sub': 'sub-ada'})[0] == 200


def test_the_new_owner_must_write_in_the_workspace(world):
    import projects

    before = _rows(world.table)
    status, answer = world('POST', f'/projects/{P_A}/owner', ADA, ws=WS_A, body={'sub': 'sub-vi'})
    assert (status, answer['error']) == (400, projects.OWNER_NEEDS_AN_EDITOR)
    assert _rows(world.table) == before


def test_a_previous_owner_who_left_the_workspace_is_not_re_added(world):
    """The project's owner is no longer A's member: handing it over does not put them back in its members map."""
    pk = f'WS#{WS_A}#PROJECT#{P_GONE}'
    world.table.put_item(Item=_meta(pk, P_GONE, f'WS#{WS_A}#TYPE#PROJECT', 'left behind', 'sub-gone', {}))
    assert world('POST', f'/projects/{P_GONE}/owner', ADA, ws=WS_A, body={'sub': 'sub-ed'})[0] == 200
    meta = world.table.get_item(Key={'pk': pk, 'sk': 'META'})['Item']
    assert (meta['owner_sub'], meta['members']) == ('sub-ed', {})


# ── The create ────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_workspace_editor_creates_in_the_workspace_and_an_agent_creates_nothing(world):
    import projects

    before = _rows(world.table)
    status, answer = world('POST', '/projects', AGENT, ws=WS_A, body={'name': 'By an agent'})
    assert (status, answer['error']) == (403, projects.AGENT_CREATE_REFUSED)
    assert _rows(world.table) == before
    status, answer = world('POST', '/projects', ED, ws=WS_A, body={'name': 'Mine'})
    assert status == 200
    project_id = answer['project']['project_id']
    assert world.table.get_item(Key={'pk': f'WS#{WS_A}#PROJECT#{project_id}', 'sk': 'META'}).get('Item')
    assert project_id in _ids(world('GET', '/projects', ED, ws=WS_A)[1])
    assert project_id not in _ids(world('GET', '/projects', BEA, ws=WS_B)[1])


# ── The routes the seam does not reach yet: refused by name ───────────────────────────────────────────────────────

def _registered_routes() -> set[tuple[str, str]]:
    """Every (method, template) the projects API's resolver serves, the included routers' too."""
    app = projects_handler.app
    return {(route.method.upper(), route.path) for route in [*app._static_routes, *app._dynamic_routes]}


def _library_routes() -> set[tuple[str, str]]:
    """The Documents Library's routes, which resolve their own scope (shared/library_routes.py)."""
    return {key for key in _registered_routes() if key[1] == '/projects/library'
            or key[1].startswith('/projects/library/')}


def test_every_route_is_threaded_or_waits_for_a_named_slice():
    """Each route of the API is in exactly one of THREADED_ROUTES, NOT_YET (with its 3h slice) or the Documents
    Library's own; no entry names a route that does not exist."""
    threaded, not_yet, library = set(projects_handler.THREADED_ROUTES), set(projects_handler.NOT_YET), _library_routes()
    registered = _registered_routes()
    assert sorted(registered - threaded - not_yet - library) == []
    assert sorted((threaded | not_yet) - registered) == []
    assert threaded.isdisjoint(not_yet)
    assert library.isdisjoint(threaded | not_yet)
    assert set(projects_handler.NOT_YET.values()) == {'3h-S3b', '3h-S3c', '3h-S4', '3h-S5', '3h-S6', '3h-S7', '3h-S8'}


@pytest.mark.xfail(strict=True, reason='3h-S12, the flip, needs every project route threaded: it empties NOT_YET and '
                                       'removes this mark (xfail_strict fails the run the day it passes)')
def test_the_flip_finds_no_route_waiting_for_a_slice():
    assert projects_handler.NOT_YET == {}


def _filled(template: str) -> str:
    return re.sub(r'<[a-z_]+>', 'x1', template.replace('<project_id>', P_A))


#: The reviewer routes never resolve a workspace (a reviewer is outside it): they are tested apart.
REFUSED = sorted(key for key in projects_handler.NOT_YET if not key[1].startswith('/review/'))


@pytest.mark.parametrize('route', REFUSED, ids=lambda route: f'{route[0]} {route[1]}')
def test_a_route_not_threaded_yet_is_refused_in_a_workspace_by_its_slice_and_reads_nothing(world, route):
    method, template = route
    before = _rows(world.table)
    with patch('projects_handler.project_gate.read_gate_meta', side_effect=AssertionError('read')), \
            patch('projects_handler.logger') as log:
        assert world(method, _filled(template), ED, ws=WS_A, body={})[0] == 500
    refusal = str(log.exception.call_args)
    assert f'The projects route {method} {template} ({projects_handler.NOT_YET[route]}) is not per workspace yet' \
        in refusal
    assert _rows(world.table) == before


def test_a_company_persona_called_library_is_no_documents_library_route(world):
    """Only ``/projects/library`` and below resolve their own scope: ``/company-personas/library`` is refused (3h-S3c)."""
    with patch('projects_handler.logger') as log:
        assert world('PUT', '/company-personas/library', ED, ws=WS_A, body={'name': 'x'})[0] == 500
    assert 'PUT /company-personas/<persona_id> (3h-S3c) is not per workspace yet' in str(log.exception.call_args)


@pytest.mark.parametrize(('method', 'path'), [('GET', '/review/library'), ('GET', '/review/share_x1'),
                                              ('POST', '/review/share_x1/comments')])
def test_the_reviewer_routes_never_resolve_a_workspace(world, method, path):
    """A reviewer is outside the workspace (3h-S5): their routes skip the seam, whatever header they send, as the
    Documents Library does; nothing is refused as a workspace's."""
    from shared import project_request_scope

    with patch.object(project_request_scope, 'request_workspace', side_effect=AssertionError('resolved')), \
            patch('projects_handler.logger') as log:
        world(method, path, ED, ws=WS_A, body={})
    assert 'is not per workspace yet' not in str(log.exception.call_args)
    assert 'resolved' not in str(log.exception.call_args)


def test_the_documents_library_resolves_its_own_scope(world):
    from shared import project_request_scope

    with patch.object(project_request_scope, 'request_workspace', side_effect=AssertionError('resolved')), \
            patch('projects_handler.logger') as log:
        world('GET', '/projects/library', ED, ws=WS_A)
    assert 'resolved' not in str(log.exception.call_args)
    assert 'is not per workspace yet' not in str(log.exception.call_args)


def test_a_threaded_route_reaching_another_slices_store_refuses_it_by_name(world):
    """A focus group's transcript (checked against the deployment's feedback), a revise pass and a prototype's
    restore or duplicate are not per workspace yet: refused, nothing written."""
    target = world('POST', '/projects', ED, ws=WS_A, body={'name': 'Target'})[1]['project']['project_id']
    world.table.put_item(Item={'pk': f'WS#{WS_A}#PROJECT#{P_A}', 'sk': 'PROTOTYPE#pr1', 'document_id': 'pr1',
                               'document_type': 'prototype', 'title': 'Proto v1', 'base_title': 'Proto',
                               'version': 1})
    before = _rows(world.table)
    for method, rest, body in (
            ('POST', '/documents', {'document_type': 'focus_group', 'title': 'FG', 'content': 'x'}),
            ('PUT', '/documents/d1', {'content': 'x', 'revise_job_id': 'job_20261127090000_abcd1234'}),
            ('POST', '/documents/pr1/duplicate', {'target_project_id': target}),
            ('POST', '/documents/pr1/versions/v1/restore', {})):
        with patch('projects_handler.logger') as log:
            status, _ = world(method, f'/projects/{P_A}{rest}', ED, ws=WS_A, body=body)
        assert status == 500, (method, rest)
        assert 'is not per workspace yet' in str(log.exception.call_args), (method, rest)
    assert _rows(world.table) == before


def test_a_document_is_duplicated_into_another_project_of_the_same_workspace(world):
    target = world('POST', '/projects', ED, ws=WS_A, body={'name': 'Target'})[1]['project']['project_id']
    status, answer = world('POST', f'/projects/{P_A}/documents/d1/duplicate', ED, ws=WS_A,
                           body={'target_project_id': target})
    assert status == 200
    copy = world.table.get_item(Key={'pk': f'WS#{WS_A}#PROJECT#{target}',
                                     'sk': f'DOC#{answer["document"]["document_id"]}'})['Item']
    assert (copy['content'], copy['gsi1pk']) == ('alderbrook launch', f'WS#{WS_A}#PROJECT#{target}#DOCUMENTS')
    # B's project is no target from A: the one 404, as for an id that exists nowhere.
    assert world('POST', f'/projects/{P_A}/documents/d1/duplicate', ED, ws=WS_A,
                 body={'target_project_id': P_B}) == world('POST', f'/projects/{P_A}/documents/d1/duplicate', ED,
                                                           ws=WS_A, body={'target_project_id': UNKNOWN})
