"""The categories, dimensions and source-profile routes inside and outside a workspace (7.08.00,
docs/multi-workspace.md, "Per-workspace configuration").

In the cross-workspace suite's settings world (cross_workspace_worlds.py ``settings_world``: workspaces A and B, each
with its own categories, dimensions and profiles, and the deployment's): with ``X-Workspace-Id`` the six routes read
and write the workspace's own ``WS#{ws}#SETTINGS#{kind}`` row, any member reads, only the workspace's admins write
(the deployment's ``admins`` group grants nothing there), a member of another workspace gets the one 404; without
the header the deployment's rows and its ``admins``, as before; a workspace that saved none of a kind reads none of
it, never the deployment's row.
"""
from __future__ import annotations

from typing import Any

import pytest
from cross_workspace_worlds import A_MARK, ADA, ADA_MEMBER_ONLY, B_MARK, BEA, WORLDS, WS_A, WS_B, table_snapshot

from shared.workspace import NOT_FOUND

#: A's viewer, also in the deployment's `admins` group: the group grants nothing inside A.
VIC_ADMINS = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': '[admins, users]'}
VIC = {**VIC_ADMINS, 'cognito:groups': 'users'}

_BODIES: dict[str, dict[str, Any]] = {
    '/settings/categories': {'categories': [{'name': 'trail_gear'}]},
    '/settings/dimensions': {'dimensions': [{'key': 'terrain', 'values': [{'name': 'gravel'}]}]},
    '/settings/sources': {'sources': [{'id': 'webscraper', 'pii': 'redact'}]},
}
_KINDS = {'/settings/categories': 'categories', '/settings/dimensions': 'dimensions', '/settings/sources': 'sources'}
_PATHS = sorted(_BODIES)


@pytest.fixture
def world(lambda_context):
    with WORLDS['settings_handler.py'](lambda_context) as built:
        yield built


def _row(kind: str, ws: str | None) -> dict:
    """The stored row of ``kind`` (the workspace's, or the deployment's for None), ``{}`` when absent."""
    import boto3

    pk = f'SETTINGS#{kind}' if ws is None else f'WS#{ws}#SETTINGS#{kind}'
    table = boto3.resource('dynamodb', region_name='us-east-1').Table('aggregates')
    return table.get_item(Key={'pk': pk, 'sk': 'config'}, ConsistentRead=True).get('Item') or {}


def _text(value: Any) -> str:
    return repr(value).casefold()


class TestReads:
    @pytest.mark.parametrize('path', _PATHS)
    def test_inside_a_workspace_any_member_reads_its_own_config(self, world, path):
        for caller in (ADA, VIC):
            status, body = world.call('GET', path, ws=WS_A, caller=caller)
            assert status == 200, body
            assert A_MARK in _text(body), (path, caller['sub'])
            assert B_MARK not in _text(body)
            assert 'before_workspaces' not in _text(body)

    @pytest.mark.parametrize('path', _PATHS)
    def test_without_the_header_the_deployments_config_as_before(self, world, path):
        status, body = world.call('GET', path, ws=None, caller=ADA)

        assert status == 200, body
        assert 'before_workspaces' in _text(body)
        assert A_MARK not in _text(body)
        assert B_MARK not in _text(body)

    @pytest.mark.parametrize('path', _PATHS)
    def test_a_member_of_another_workspace_gets_the_one_404(self, world, path):
        before = table_snapshot()
        status, body = world.call('GET', path, ws=WS_A, caller=BEA)

        assert (status, body) == (404, {'success': False, 'error': NOT_FOUND})
        assert table_snapshot() == before

    def test_a_workspace_that_saved_nothing_reads_nothing_never_the_deployments(self, world):
        import boto3

        table = boto3.resource('dynamodb', region_name='us-east-1').Table('aggregates')
        for kind in _KINDS.values():
            table.delete_item(Key={'pk': f'WS#{WS_A}#SETTINGS#{kind}', 'sk': 'config'})

        _, categories = world.call('GET', '/settings/categories', ws=WS_A)
        _, dimensions = world.call('GET', '/settings/dimensions', ws=WS_A)
        _, sources = world.call('GET', '/settings/sources', ws=WS_A)

        assert categories == {'categories': [], 'updated_at': None}
        assert [d['key'] for d in dimensions['dimensions']] == ['feedback_type']  # the built-in only
        assert sources == {'sources': []}

    def test_a_workspace_viewer_gets_the_profiles_reduced_even_from_the_deployments_admins(self, world):
        _, body = world.call('GET', '/settings/sources', ws=WS_A, caller=VIC_ADMINS)

        assert body['sources'] == [{'id': 'webscraper', 'label': f'{A_MARK} reviews', 'restricted': False}]

    def test_the_workspaces_admin_gets_the_profiles_in_full(self, world):
        _, body = world.call('GET', '/settings/sources', ws=WS_A, caller=ADA_MEMBER_ONLY)

        assert body['sources'][0]['pii'] == 'allow'


def test_a_delegated_caller_never_changes_a_workspaces_admin_settings():
    """require_settings_admin: inside a workspace a delegated caller (an MCP token acting for the workspace's admin)
    is refused, as it gets no full configuration view; the person themselves passes."""
    from unittest.mock import patch

    from shared import request_workspace
    from shared.exceptions import AuthorizationError
    from shared.project_access import Caller
    from shared.workspace import WorkspaceContext

    admin = WorkspaceContext(ws=WS_A, role='admin', name='', slug='', platform_admin=False)
    with patch.object(request_workspace, 'caller_from_event',
                      return_value=Caller(subject='sub-ada', is_admin=False, delegated=True)), \
            pytest.raises(AuthorizationError, match='delegated'):
        request_workspace.require_settings_admin({}, admin)
    with patch.object(request_workspace, 'caller_from_event',
                      return_value=Caller(subject='sub-ada', is_admin=False, delegated=False)):
        request_workspace.require_settings_admin({}, admin)


def test_the_resolved_problems_are_judged_against_the_workspaces_categories(world):
    """A member's view of the workspace's resolved problems is filtered with the workspace's categories."""
    from unittest.mock import patch

    import settings_handler
    from shared.category_access import UNRESTRICTED

    with patch.object(settings_handler, 'scope_for_caller', return_value=UNRESTRICTED) as scope_for_caller:
        status, _ = world.call('GET', '/settings/resolved-problems', ws=WS_A, caller=VIC)

    assert status == 200
    assert scope_for_caller.call_args.args[2].ws == WS_A


class TestWrites:
    @pytest.mark.parametrize('path', _PATHS)
    def test_the_workspaces_admin_writes_its_own_row_only(self, world, path):
        kind = _KINDS[path]
        others = (_row(kind, None), _row(kind, WS_B))

        status, body = world.call('PUT', path, ws=WS_A, body=_BODIES[path], caller=ADA_MEMBER_ONLY)

        assert status == 200, body
        saved = _row(kind, WS_A)
        assert kind in saved
        assert A_MARK not in _text(saved[kind])
        assert (_row(kind, None), _row(kind, WS_B)) == others

    @pytest.mark.parametrize('path', _PATHS)
    @pytest.mark.parametrize('caller', [VIC, VIC_ADMINS], ids=['viewer', 'viewer-in-deployment-admins'])
    def test_anyone_but_the_workspaces_admins_is_refused_and_nothing_changes(self, world, path, caller):
        before = table_snapshot()
        status, _ = world.call('PUT', path, ws=WS_A, body=_BODIES[path], caller=caller)

        assert status == 403
        assert table_snapshot() == before

    @pytest.mark.parametrize('path', _PATHS)
    def test_a_member_of_another_workspace_gets_the_one_404_and_writes_nothing(self, world, path):
        before = table_snapshot()
        status, body = world.call('PUT', path, ws=WS_A, body=_BODIES[path], caller=BEA)

        assert (status, body) == (404, {'success': False, 'error': NOT_FOUND})
        assert table_snapshot() == before

    @pytest.mark.parametrize('path', _PATHS)
    def test_without_the_header_the_deployments_admins_write_the_deployments_row(self, world, path):
        kind = _KINDS[path]
        workspace_rows = (_row(kind, WS_A), _row(kind, WS_B))

        assert world.call('PUT', path, ws=None, body=_BODIES[path], caller=ADA_MEMBER_ONLY)[0] == 403
        status, body = world.call('PUT', path, ws=None, body=_BODIES[path], caller=ADA)

        assert status == 200, body
        assert 'before_workspaces' not in _text(_row(kind, None)[kind])
        assert (_row(kind, WS_A), _row(kind, WS_B)) == workspace_rows

    @pytest.mark.parametrize(('profile', 'says'), [
        ({'id': 'webscraper', 'retention_days': 90, 'retention_legal_basis': 'contract: support terms'},
         "retention windows are the deployment's"),
        ({'id': 'radar_example', 'radar_brand': 'Example Air'}, 'Radar is not kept per workspace'),
        # Sent alone, each would be dropped by normalising: refused as sent.
        ({'id': 'webscraper', 'retention_legal_basis': 'contract: support terms'}, 'cannot set retention_legal_basis'),
        ({'id': 'webscraper', 'radar_domains': ['example.com']}, 'cannot set radar_domains'),
    ], ids=['retention', 'radar', 'a-legal-basis-alone', 'radar-domains-alone'])
    def test_a_workspace_profile_sets_no_retention_window_and_no_radar_brand(self, world, profile, says):
        before = table_snapshot()
        status, body = world.call('PUT', '/settings/sources', ws=WS_A, body={'sources': [profile]})

        assert status == 400
        assert says in body['error']
        assert table_snapshot() == before

    def test_the_deployments_profile_may_still_set_a_retention_window(self, world):
        profile = {'id': 'webscraper', 'retention_days': 90, 'retention_legal_basis': 'contract: support terms'}
        status, body = world.call('PUT', '/settings/sources', ws=None, body={'sources': [profile]})

        assert status == 200, body
        assert _row('sources', None)['sources'][0]['retention_days'] == 90

    def test_a_profiles_dimension_defaults_are_checked_against_the_workspaces_dimensions(self, world):
        deployment_only = {'id': 'webscraper', 'dimension_defaults': {'region': 'before_workspaces_north'}}
        own = {'id': 'webscraper', 'dimension_defaults': {'region': f'{A_MARK}_north'}}

        assert world.call('PUT', '/settings/sources', ws=WS_A, body={'sources': [deployment_only]})[0] == 400
        status, body = world.call('PUT', '/settings/sources', ws=WS_A, body={'sources': [own]})
        assert status == 200, body
