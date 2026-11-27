"""The access gate on a workspace's project (docs/multi-workspace.md, "3h, the switch"; slice 3h-S2, 7.101.00).

A workspace's project is decided from the caller's membership of THAT workspace, as the request resolved it
(shared/workspace.py ``resolve_workspace``, handed to the gate by ``membership_of`` as a ``WorkspaceMembership``):

* a non-member, and an agent, get nothing: the one 404 a missing project gets, before any read;
* the owner manages; then the workspace's admin role is the admin bypass (the deployment's ``admins`` group grants
  nothing there); then ``public`` means the workspace's members; then the project's members map;
* the workspace's viewer role caps every role at view; a delegated credential acts at most as an editor;
* a removed member loses the project, even while still in its members map;
* a tombstoned or deleting project is a 404, a workspace admin's too;
* a META of another scope, or a membership of another workspace or person, is refused (a programming error).

No route passes a workspace yet; the deployment's path is pinned unchanged in test_project_access.py and
test_project_gate.py.
"""
from __future__ import annotations

import inspect
from unittest.mock import MagicMock

import pytest
from moto import mock_aws

from shared import project_access as pa
from shared import project_gate
from shared.exceptions import AuthorizationError, NotFoundError
from shared.project_access import Caller, WorkspaceMembership, WorkspaceMembershipError
from shared.project_keys import NotPerWorkspaceError, project_pk
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
PROJECT = 'proj_20261127090000_0123abcd'
MISSING_PROJECT = 'proj_20261127090000_ffffffff'
OWNER = 'sub-owner'
EDITOR = 'sub-editor'
VIEWER = 'sub-viewer'
STRANGER = 'sub-stranger'
WS_ROLES = ('admin', 'editor', 'viewer')


def _meta(visibility: str = 'private', scope: WorkspaceScope | None = A, **extra) -> dict:
    return {'pk': project_pk(PROJECT, workspace=scope), 'sk': 'META', 'status': 'active', 'visibility': visibility,
            'owner_sub': OWNER, 'members': {EDITOR: {'role': 'editor'}, VIEWER: {'role': 'viewer'}}, **extra}


def _member(sub: str, role: object, scope: WorkspaceScope = A) -> WorkspaceMembership:
    return WorkspaceMembership(scope=scope, subject=sub, role=role)


def _role(meta: dict | None, caller: Caller, role: object, scope: WorkspaceScope = A) -> str | None:
    return pa.resolve_access(meta, caller, workspace=scope, membership=_member(caller.subject, role, scope)).role


def _gate(read, caller: Caller, role: object, level: str = pa.LEVEL_VIEW, *, scope: WorkspaceScope = A,
          membership_scope: WorkspaceScope | None = None) -> pa.ProjectAccess:
    return project_gate.require_project_level(
        read, caller, level, workspace=scope,
        membership=_member(caller.subject, role, membership_scope or scope))


# ── The admin bypass ─────────────────────────────────────────────────────────

@pytest.mark.parametrize('visibility', ['private', 'public'])
def test_a_deployment_admin_who_is_not_a_member_gets_nothing(visibility):
    admin = Caller(subject=STRANGER, is_admin=True)
    assert _role(_meta(visibility), admin, None) is None
    read = MagicMock(return_value=_meta(visibility))
    with pytest.raises(NotFoundError, match=r'^Project not found$'):
        _gate(read, admin, None)
    read.assert_not_called()


def test_a_deployment_admin_who_is_a_member_has_their_membership_only():
    admin = Caller(subject=STRANGER, is_admin=True)
    assert _role(_meta(), admin, 'editor') is None
    assert _role(_meta('public'), admin, 'editor') == pa.ROLE_EDITOR
    assert _role(_meta('public'), admin, 'viewer') == pa.ROLE_VIEWER
    with pytest.raises(AuthorizationError, match='manage'):
        _gate(lambda: _meta('public'), admin, 'editor', pa.LEVEL_MANAGE)


@pytest.mark.parametrize('visibility', ['private', 'public'])
def test_the_workspace_admin_has_full_access(visibility):
    # A member admin, or a platform admin who entered (resolve_workspace gives both the role `admin`).
    admin = Caller(subject=STRANGER)
    assert _role(_meta(visibility), admin, 'admin') == pa.ROLE_ADMIN
    access = _gate(lambda: _meta(visibility), admin, 'admin', pa.LEVEL_MANAGE)
    assert (access.role, access.can_manage) == (pa.ROLE_ADMIN, True)


def test_the_workspace_admin_reads_the_project_and_a_missing_one_is_404():
    read = MagicMock(return_value=None)
    with pytest.raises(NotFoundError, match=r'^Board not found$'):
        project_gate.require_project_level(read, Caller(subject=STRANGER), pa.LEVEL_MANAGE,
                                           missing_message='Board not found', workspace=A,
                                           membership=_member(STRANGER, 'admin'))
    read.assert_called_once_with()


# ── Public means the workspace's members ─────────────────────────────────────

@pytest.mark.parametrize(('sub', 'ws_role', 'expected'), [
    (STRANGER, 'editor', pa.ROLE_EDITOR),
    (STRANGER, 'viewer', pa.ROLE_VIEWER),
    (STRANGER, None, None),
    # A project viewer on a public project is an editor, as in the deployment, until the workspace role caps it.
    (VIEWER, 'editor', pa.ROLE_EDITOR),
    (VIEWER, 'viewer', pa.ROLE_VIEWER),
])
def test_public_is_for_the_workspaces_members(sub, ws_role, expected):
    assert _role(_meta('public'), Caller(subject=sub), ws_role) == expected


def test_a_non_member_is_answered_like_a_missing_project_before_any_read():
    read = MagicMock(return_value=_meta('public'))
    with pytest.raises(NotFoundError) as non_member:
        _gate(read, Caller(subject=STRANGER), None)
    read.assert_not_called()
    with pytest.raises(NotFoundError) as missing:
        _gate(lambda: None, Caller(subject=STRANGER), 'editor')
    assert (type(non_member.value), str(non_member.value)) == (type(missing.value), str(missing.value))


@pytest.mark.parametrize('ws_role', ['owner', 'member', '', 'ADMIN', 3, ['admin'], {'admin': 1}],
                         ids=['owner', 'member', 'blank', 'upper', 'number', 'list', 'dict'])
def test_a_role_the_workspace_does_not_know_is_no_membership(ws_role):
    for visibility in ('private', 'public'):
        assert _role(_meta(visibility), Caller(subject=OWNER), ws_role) is None
    with pytest.raises(NotFoundError):
        _gate(lambda: _meta('public'), Caller(subject=OWNER), ws_role)


# ── The owner and the project's members, while they are the workspace's ──────

@pytest.mark.parametrize(('sub', 'ws_role', 'expected'), [
    (OWNER, 'editor', pa.ROLE_OWNER),
    (OWNER, 'admin', pa.ROLE_OWNER),
    (OWNER, 'viewer', pa.ROLE_VIEWER),
    (EDITOR, 'editor', pa.ROLE_EDITOR),
    (EDITOR, 'admin', pa.ROLE_ADMIN),
    (EDITOR, 'viewer', pa.ROLE_VIEWER),
    (VIEWER, 'editor', pa.ROLE_VIEWER),
    (VIEWER, 'viewer', pa.ROLE_VIEWER),
    (STRANGER, 'editor', None),
    (STRANGER, 'viewer', None),
])
def test_a_private_projects_roles_inside_the_workspace(sub, ws_role, expected):
    assert _role(_meta(), Caller(subject=sub), ws_role) == expected


@pytest.mark.parametrize('sub', [OWNER, EDITOR, VIEWER])
def test_a_removed_workspace_member_loses_the_project_they_still_are_in(sub):
    assert _role(_meta(), Caller(subject=sub), None) is None
    with pytest.raises(NotFoundError, match=r'^Project not found$'):
        _gate(_meta, Caller(subject=sub), None)


def test_the_levels_inside_the_workspace():
    assert _gate(_meta, Caller(subject=OWNER), 'editor', pa.LEVEL_MANAGE).role == pa.ROLE_OWNER
    assert _gate(_meta, Caller(subject=EDITOR), 'editor', pa.LEVEL_EDIT).role == pa.ROLE_EDITOR
    with pytest.raises(AuthorizationError, match=r'^You do not have permission to manage this project$'):
        _gate(_meta, Caller(subject=EDITOR), 'editor', pa.LEVEL_MANAGE)
    assert _gate(_meta, Caller(subject=VIEWER), 'editor', pa.LEVEL_VIEW).role == pa.ROLE_VIEWER
    with pytest.raises(AuthorizationError, match=r'^You do not have permission to edit this project$'):
        _gate(_meta, Caller(subject=VIEWER), 'editor', pa.LEVEL_EDIT)
    # The workspace's viewer reads, never writes: an editor of the project included.
    with pytest.raises(AuthorizationError, match='edit'):
        _gate(_meta, Caller(subject=EDITOR), 'viewer', pa.LEVEL_EDIT)
    with pytest.raises(NotFoundError):
        _gate(_meta, Caller(subject=STRANGER), 'editor', pa.LEVEL_VIEW)


# ── Credentials and agents ───────────────────────────────────────────────────

@pytest.mark.parametrize(('sub', 'ws_role', 'expected'), [
    (STRANGER, 'admin', pa.ROLE_EDITOR),
    (OWNER, 'editor', pa.ROLE_EDITOR),
    (OWNER, 'viewer', pa.ROLE_VIEWER),
    (EDITOR, 'editor', pa.ROLE_EDITOR),
    (VIEWER, 'editor', pa.ROLE_VIEWER),
    (STRANGER, 'editor', None),
    (OWNER, None, None),
])
def test_a_delegated_credential_never_acts_above_edit(sub, ws_role, expected):
    assert _role(_meta(), Caller(subject=sub, delegated=True), ws_role) == expected


def test_a_delegated_credential_cannot_manage():
    with pytest.raises(AuthorizationError, match='manage'):
        _gate(_meta, Caller(subject=OWNER, delegated=True), 'admin', pa.LEVEL_MANAGE)


@pytest.mark.parametrize('ws_role', WS_ROLES)
def test_an_agent_reaches_no_workspace_project(ws_role):
    agent = Caller(subject=OWNER, delegated=True, agent_id='ag_1')
    for meta in ({**_meta(), pa.CREATED_BY_AGENT_ATTRIBUTE: 'ag_1'}, _meta('public')):
        assert _role(meta, agent, ws_role) is None
    read = MagicMock(return_value=_meta('public'))
    with pytest.raises(NotFoundError, match=r'^Project not found$'):
        _gate(read, agent, ws_role)
    read.assert_not_called()


# ── Tombstones ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize('meta', [_meta(status='deleting'), _meta(status='deleted'),
                                  _meta(deletion_started_at='2026-11-27T09:00:00+00:00'), {}, None],
                         ids=['deleting', 'deleted', 'deletion-started', 'empty', 'missing'])
@pytest.mark.parametrize(('sub', 'ws_role'), [(STRANGER, 'admin'), (OWNER, 'editor'), (STRANGER, 'editor')],
                         ids=['workspace-admin', 'owner', 'public-member'])
def test_a_tombstoned_or_deleting_project_is_404(meta, sub, ws_role):
    with pytest.raises(NotFoundError, match=r'^Project not found$'):
        _gate(lambda: meta, Caller(subject=sub), ws_role, pa.LEVEL_VIEW)


def test_no_meta_is_no_access_for_a_workspace_admin_either():
    assert _role(None, Caller(subject=STRANGER), 'admin') is None


# ── The membership must be the project's workspace's, and the caller's ───────

@pytest.mark.parametrize(('workspace', 'membership'), [
    (A, None),
    (A, _member(OWNER, 'admin', B)),
    (None, _member(OWNER, 'admin', A)),
    (A, _member(STRANGER, 'admin', A)),
], ids=['none', 'another-workspace', 'deployment-with-one', 'another-person'])
def test_a_membership_that_is_not_the_workspaces_and_the_callers_is_a_programming_error(workspace, membership):
    owner = Caller(subject=OWNER, is_admin=True)
    read = MagicMock(return_value=_meta('public'))
    with pytest.raises(WorkspaceMembershipError, match=r'^Project gate ') as raised:
        pa.resolve_access(_meta('public'), owner, workspace=workspace, membership=membership)
    assert isinstance(raised.value, NotPerWorkspaceError)
    with pytest.raises(WorkspaceMembershipError):
        project_gate.require_project_level(read, owner, pa.LEVEL_VIEW, workspace=workspace, membership=membership)
    read.assert_not_called()


@pytest.mark.parametrize('subject', ['', None, 7], ids=['blank', 'none', 'number'])
def test_a_membership_naming_nobody_is_refused(subject):
    # A credential acting for nobody has a blank subject; a membership "of" it would match it.
    caller = Caller(subject='')
    membership = WorkspaceMembership(scope=A, subject=subject, role='admin')  # type: ignore[arg-type]
    with pytest.raises(WorkspaceMembershipError):
        pa.resolve_access(_meta('public'), caller, workspace=A, membership=membership)
    with pytest.raises(WorkspaceMembershipError):
        project_gate.require_project_level(MagicMock(), caller, pa.LEVEL_VIEW, workspace=A, membership=membership)


# ── The META must be the scope's own ─────────────────────────────────────────

@pytest.mark.parametrize(('meta_scope', 'workspace'), [(A, None), (B, None), (None, A), (B, A)],
                         ids=['workspace-meta-as-deployment', 'other-workspace-meta-as-deployment',
                              'deployment-meta-in-a-workspace', 'other-workspace-meta'])
def test_a_meta_of_another_scope_is_refused(meta_scope, workspace):
    meta = _meta('public', meta_scope)
    membership = None if workspace is None else _member(STRANGER, 'admin', workspace)
    caller = Caller(subject=STRANGER)
    with pytest.raises(WorkspaceMembershipError, match='META'):
        pa.resolve_access(meta, caller, workspace=workspace, membership=membership)
    with pytest.raises(WorkspaceMembershipError, match='META'):
        project_gate.require_project_level(lambda: meta, caller, pa.LEVEL_VIEW, workspace=workspace,
                                           membership=membership)


def test_a_workspace_meta_without_its_key_is_refused_and_a_deployment_one_reads_as_before():
    keyless = {key: value for key, value in _meta('public').items() if key != 'pk'}
    with pytest.raises(WorkspaceMembershipError, match='META'):
        _role(keyless, Caller(subject=STRANGER), 'editor')
    assert pa.resolve_access(keyless, Caller(subject=STRANGER), workspace=None,
                             membership=None).role == pa.ROLE_EDITOR


def test_the_deployments_path_takes_no_membership_and_is_unchanged():
    meta = _meta('public', None)
    assert pa.resolve_access(meta, Caller(subject=STRANGER), workspace=None, membership=None).role == pa.ROLE_EDITOR
    assert pa.resolve_access(meta, Caller(subject=STRANGER, is_admin=True), workspace=None,
                             membership=None).role == pa.ROLE_ADMIN
    read = MagicMock()
    access = project_gate.require_project_level(read, Caller(subject=STRANGER, is_admin=True), pa.LEVEL_MANAGE,
                                                workspace=None, membership=None)
    assert access.role == pa.ROLE_ADMIN
    read.assert_not_called()


@pytest.mark.parametrize('function', [pa.resolve_access, pa.sharing_summary, project_gate.require_project_level,
                                      project_gate.require_viewable_pin], ids=lambda function: function.__name__)
def test_the_scope_and_the_membership_are_required_keywords(function):
    parameters = inspect.signature(function).parameters
    for name in ('workspace', 'membership'):
        assert parameters[name].kind is inspect.Parameter.KEYWORD_ONLY
        assert parameters[name].default is inspect.Parameter.empty


# ── The sharing summary ──────────────────────────────────────────────────────

def test_the_sharing_summary_is_decided_in_the_projects_own_scope():
    summary = pa.sharing_summary(_meta(), Caller(subject=EDITOR), workspace=A,
                                 membership=_member(EDITOR, 'viewer'))
    assert summary['access'] == {'role': pa.ROLE_VIEWER, 'can_view': True, 'can_edit': False, 'can_manage': False}
    removed = pa.sharing_summary(_meta(), Caller(subject=EDITOR), workspace=A, membership=_member(EDITOR, None))
    assert removed['access']['role'] is None
    with pytest.raises(WorkspaceMembershipError):
        pa.sharing_summary(_meta(), Caller(subject=EDITOR), workspace=None, membership=None)
    deployment = pa.sharing_summary(_meta(scope=None), Caller(subject=EDITOR), workspace=None, membership=None)
    assert deployment['access']['role'] == pa.ROLE_EDITOR


# ── Across workspaces, on the table ──────────────────────────────────────────

@pytest.fixture
def table():
    with mock_aws():
        projects = create_pk_sk_table('voc-projects-gate-test')
        projects.put_item(Item=_meta('public'))
        yield MagicMock(wraps=projects)


def _read(table, project_id: str, scope: WorkspaceScope):
    return lambda: project_gate.read_gate_meta(table, project_id, workspace=scope)


def test_the_gate_reads_its_workspaces_meta_only(table):
    assert (project_gate.read_gate_meta(table, PROJECT, workspace=A) or {}).get('owner_sub') == OWNER
    assert project_gate.read_gate_meta(table, PROJECT, workspace=B) is None
    assert project_gate.read_gate_meta(table, PROJECT, workspace=None) is None


@pytest.mark.parametrize(('project_id', 'scope', 'ws_role', 'reads'), [
    (PROJECT, B, 'editor', 1),
    (MISSING_PROJECT, B, 'editor', 1),
    (PROJECT, A, None, 0),
    (MISSING_PROJECT, A, None, 0),
], ids=['in-B-the-id-names-nothing', 'in-B-a-missing-id', 'in-A-as-a-non-member', 'in-A-a-missing-id'])
def test_a_member_of_another_workspace_gets_the_answer_a_missing_project_gets(table, project_id, scope, ws_role,
                                                                              reads):
    with pytest.raises(NotFoundError) as raised:
        _gate(_read(table, project_id, scope), Caller(subject=STRANGER), ws_role, scope=scope)
    assert (type(raised.value), str(raised.value)) == (NotFoundError, 'Project not found')
    assert table.get_item.call_count == reads


def test_a_member_of_the_workspace_reads_its_public_project(table):
    assert _gate(_read(table, PROJECT, A), Caller(subject=STRANGER), 'editor').role == pa.ROLE_EDITOR
    assert table.get_item.call_count == 1


def test_a_member_of_another_workspace_cannot_carry_that_membership_in(table):
    with pytest.raises(WorkspaceMembershipError):
        _gate(_read(table, PROJECT, A), Caller(subject=STRANGER), 'admin', scope=A, membership_scope=B)
    table.get_item.assert_not_called()


def _pin(table, caller: Caller, ws_role: object, project_id: str = PROJECT, scope: WorkspaceScope = A):
    return project_gate.require_viewable_pin(table, project_id, caller, workspace=scope,
                                             membership=_member(caller.subject, ws_role, scope))


def test_a_workspace_pin_is_checked_on_the_workspaces_membership(table):
    assert _pin(table, Caller(subject=STRANGER), 'viewer') == PROJECT
    assert _pin(table, Caller(subject=STRANGER), None, '') is None
    for caller, ws_role, project_id, scope in ((Caller(subject=STRANGER), None, PROJECT, A),
                                               (Caller(subject=STRANGER, is_admin=True), None, PROJECT, A),
                                               (Caller(subject=STRANGER), 'admin', MISSING_PROJECT, A),
                                               (Caller(subject=STRANGER), 'admin', PROJECT, B)):
        with pytest.raises(NotFoundError, match=r'^Project not found$'):
            _pin(table, caller, ws_role, project_id, scope)
    with pytest.raises(WorkspaceMembershipError):
        project_gate.require_viewable_pin(table, PROJECT, Caller(subject=STRANGER), workspace=A, membership=None)


@pytest.mark.parametrize(('project_id', 'expected'), [(PROJECT, PROJECT), (MISSING_PROJECT, None)])
def test_a_workspace_admins_pin_costs_one_read(table, project_id, expected):
    # A deployment admin who is the workspace's admin too: the workspace's read proves the pin, never a second one.
    admin = Caller(subject=STRANGER, is_admin=True)
    if expected is None:
        with pytest.raises(NotFoundError):
            _pin(table, admin, 'admin', project_id)
    else:
        assert _pin(table, admin, 'admin', project_id) == expected
    assert table.get_item.call_count == 1
