"""The engagement API's workspace plumbing (docs/multi-workspace.md, the project plan, 3d; 7.31.00): the public
unsubscribe finds its person in the workspace its stored token names (the deployment's when it names none), the
brand name is a workspace's own, and the project gate the participants routes and the ballots reach refuses a
workspace (``NotPerWorkspaceError``) rather than deciding it on the deployment's project."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from engagement_fixtures import PUBLIC_PROJECT, USER, call, engagement_world, event

import ballots_handler
from shared import engagement_config, participants_store
from shared import feature_requests_promote as promote_module
from shared.engagement_identity import can_view_project, require_project_access
from shared.exceptions import NotFoundError
from shared.participants_asks import UNSUBSCRIBE_SK, token_key
from shared.participants_store import create_person, get_person
from shared.project_keys import NotPerWorkspaceError
from shared.workspace_settings import settings_key
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
A = WorkspaceScope(WS_A)
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
PERSON = 'per_0123456789abcdef'
TOKEN = 'a-long-unsubscribe-token-0123456789'


@pytest.fixture
def world():
    with engagement_world() as w, patch.object(participants_store, 'new_id', return_value=PERSON):
        for scope in (None, A, B):
            create_person(w.participants, email='pat@example.com', email_lc='pat@example.com', fields={},
                          origin='manual', created_by='sub-ada', workspace=scope)
        yield w


def _unsubscribe(world, lambda_context, **token_fields) -> dict:
    world.participants.put_item(Item={**token_key(TOKEN, UNSUBSCRIBE_SK), 'person_id': PERSON, **token_fields})
    status, body = call(lambda_context, 'POST', '/unsubscribe', claims=None, query={'t': TOKEN})
    assert (status, body) == (200, {'success': True})
    return {scope: (get_person(world.participants, PERSON, workspace=scope) or {}).get('status')
            for scope in (None, A, B)}


def test_a_token_naming_no_workspace_unsubscribes_the_deployments_person(world, lambda_context):
    assert _unsubscribe(world, lambda_context) == {None: 'unsubscribed', A: 'active', B: 'active'}


def test_a_token_naming_a_workspace_unsubscribes_that_workspaces_person_only(world, lambda_context):
    assert _unsubscribe(world, lambda_context, **{WORKSPACE_FIELD: WS_A}) == {
        None: 'active', A: 'unsubscribed', B: 'active'}


def test_a_token_naming_no_workspace_it_may_be_used_in_unsubscribes_nobody(world, lambda_context):
    assert _unsubscribe(world, lambda_context, **{WORKSPACE_FIELD: 'not-a-workspace'}) == {
        None: 'active', A: 'active', B: 'active'}


def test_the_brand_name_is_the_scopes_own(world):
    world.aggregates.put_item(Item={**settings_key(WS_A, 'brand'), 'brand_name': ' Acme Outfitters '})
    assert [engagement_config.brand_name(workspace=scope) for scope in (None, A, B)] == [
        'Example Air', 'Acme Outfitters', '']


@pytest.mark.usefixtures('world')
def test_the_participants_project_gate_refuses_a_workspace():
    request = event('GET', '/participants/projects/x', claims=USER)
    assert require_project_access(request, PUBLIC_PROJECT, 'view') == PUBLIC_PROJECT
    with pytest.raises(NotPerWorkspaceError, match='Project gate'):
        require_project_access(request, PUBLIC_PROJECT, 'view', workspace=A)
    with pytest.raises(NotPerWorkspaceError, match='Project gate'):
        can_view_project(request, PUBLIC_PROJECT, workspace=A)


def test_a_promote_skips_a_supporter_erased_between_its_upsert_and_its_add():
    """The add checks the person's row; a supporter erased meanwhile is not added, and the promote goes on."""
    emails = [('gone@example.com', 'Gone'), ('kept@example.com', 'Kept')]
    with patch.object(promote_module, '_requests_list', return_value={'list_id': 'lst_0123456789abcdef'}), \
            patch.object(promote_module, 'supports_of', return_value=[]), \
            patch.object(promote_module, 'promoted_emails', return_value=emails), \
            patch.object(promote_module, 'upsert_person', side_effect=[('per_1', False), ('per_2', False)]), \
            patch.object(promote_module, 'add_member', side_effect=[NotFoundError('Person not found'), True]), \
            patch.object(promote_module, 'link'), \
            patch.object(promote_module, 'update_request', return_value={'request_id': 'fr_1'}), \
            patch.object(promote_module, 'get_list', return_value=None):
        answer = promote_module.promote(None, None, {'request_id': 'fr_1'}, {}, 'proj_1', {}, 'sub-ada')
    assert (answer['added'], answer['skipped']) == (1, [])


_SESSION = {'pk': 'VOTING_SESSION', 'sk': 'SESSION#vs_1', 'row_id': 'r1'}


@pytest.mark.parametrize('reach', [
    lambda: ballots_handler._require_project_level('p1', 'edit', 'missing', workspace=A),
    lambda: ballots_handler._require_project_level(None, 'edit', 'missing', workspace=A),
    lambda: ballots_handler._require_row_project_edit({'project_id': 'p1'}, workspace=A),
    lambda: ballots_handler._require_session_project_level(_SESSION, 'view', workspace=A),
    lambda: ballots_handler._project_gone('p1', workspace=A),
    lambda: ballots_handler._existing_row('r1', workspace=A),
])
def test_the_ballots_rows_refuse_a_workspace_before_any_table_is_opened(reach):
    """The ballots' own rows are the deployment's: each helper refuses a workspace itself, whatever the project gate
    decides, so lifting the gate cannot land a workspace's votes in the deployment's partitions."""
    app = SimpleNamespace(current_event=SimpleNamespace(raw_event=event('POST', '/voting-sessions', claims=USER)))
    with patch.object(ballots_handler, 'app', app), \
            patch.object(ballots_handler, 'get_projects_table') as projects, \
            patch.object(ballots_handler, 'get_aggregates_table') as aggregates, \
            pytest.raises(NotPerWorkspaceError, match='Ballot rows'):
        reach()
    assert (projects.mock_calls, aggregates.mock_calls) == ([], [])
