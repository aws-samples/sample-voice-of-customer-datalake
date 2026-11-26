"""shared/agents_gate.py: the agents' write gate, the workspace's admin in one, the deployment's without one."""
from __future__ import annotations

import pytest

from shared.agents_gate import require_agents_admin
from shared.exceptions import AuthorizationError
from shared.workspace import WorkspaceContext

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


def _event(groups: str, sub: str = 'sub-ada', **claims: str) -> dict:
    return {'headers': {}, 'requestContext': {'authorizer': {'claims': {
        'sub': sub, 'cognito:username': sub.removeprefix('sub-'), 'cognito:groups': groups, **claims}}}}


def _context(role: str | None) -> WorkspaceContext | None:
    return None if role is None else WorkspaceContext(ws=WS, role=role, name='', slug='', platform_admin=False)


#: (the caller's deployment groups, their role in the workspace or None for no workspace) the gate lets through.
ADMITTED = {'deployment-admins': ('admins', None), 'workspace-admin': ('users', 'admin'),
            'workspace-admin-in-admins': ('admins', 'admin')}
#: And the ones it refuses: the deployment's `admins` group grants nothing inside a workspace.
REFUSED = {'no-workspace-user': ('users', None), 'deployment-admin-as-editor': ('admins', 'editor'),
           'deployment-admin-as-viewer': ('admins', 'viewer'), 'workspace-editor': ('users', 'editor')}


@pytest.mark.parametrize('case', sorted(ADMITTED))
def test_the_scopes_admin_acting_for_themselves_is_admitted(case):
    groups, role = ADMITTED[case]
    assert require_agents_admin(_event(groups), _context(role)) is None   # (no AuthorizationError)


@pytest.mark.parametrize('case', sorted(REFUSED))
def test_everyone_else_is_refused_on_both_branches(case):
    """Both branches refuse: the route-gate inventory counts require_agents_admin as a gate."""
    groups, role = REFUSED[case]
    with pytest.raises(AuthorizationError):
        require_agents_admin(_event(groups), _context(role))


@pytest.mark.parametrize('role', [None, 'admin'], ids=['no-workspace', 'workspace-admin'])
def test_a_delegated_caller_is_never_an_agents_admin(role):
    """Without a workspace a delegated credential is no admin (require_admin_caller, as before); in one, the
    workspace's admin acting through an MCP token is refused too."""
    event = _event('admins', sub='mcp:tok_1', **{'voc:acting_subject': 'sub-ada'})
    with pytest.raises(AuthorizationError):
        require_agents_admin(event, _context(role))
