"""Company context's plumbing per workspace (shared/company_context.py): the keys, reads and writes of a workspace's
vision and objectives and a person's own objectives there. No route passes a workspace yet (docs/multi-workspace.md)."""
from __future__ import annotations

import pytest
from moto import mock_aws

from api.test.moto_helpers import pk_sk_table
from shared import company_context
from shared.ws_repo import WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
STAMP = '2026-11-13T12:00:00+00:00'


@pytest.fixture
def table():
    with mock_aws():
        yield pk_sk_table('aggregates')


def test_the_keys():
    assert company_context.company_context_key() == {'pk': 'SETTINGS#company_context', 'sk': 'config'}
    assert company_context.company_context_key(A) == {'pk': f'WS#{A.ws}#SETTINGS#company_context', 'sk': 'config'}
    assert company_context.my_context_key('sub-ada') == {'pk': 'USERCTX#sub-ada', 'sk': 'config'}
    assert company_context.my_context_key('sub-ada', A) == {'pk': f'WS#{A.ws}#USERCTX#sub-ada', 'sk': 'config'}
    # Onboarding and briefing preferences share the deployment's partition and do not move.
    assert company_context.user_context_pk('sub-ada') == 'USERCTX#sub-ada'


def test_each_workspace_keeps_its_own_and_the_deployments_is_untouched(table):
    for workspace, vision in ((None, 'before workspaces'), (A, 'alderbrook'), (B, 'bramblewood')):
        company_context.put_company_context(table, {'vision': vision, 'objectives': []}, updated_at=STAMP,
                                            updated_by_username='ada', workspace=workspace)
        company_context.put_my_context(table, 'sub-ada', {'objectives': [{'id': 'obj_0123456789ab', 'title': vision}]},
                                       updated_at=STAMP, workspace=workspace)
    for workspace, vision in ((None, 'before workspaces'), (A, 'alderbrook'), (B, 'bramblewood')):
        assert company_context.get_company_context(table, workspace)['vision'] == vision
        mine = company_context.get_my_context(table, 'sub-ada', workspace)
        assert [objective['title'] for objective in mine['objectives']] == [vision]
    assert company_context.get_company_context(table, A)['updated_by_username'] == 'ada'


def test_a_workspace_with_nothing_saved_reads_empty_never_the_deployments(table):
    company_context.put_company_context(table, {'vision': 'before workspaces', 'objectives': []}, updated_at=STAMP,
                                        updated_by_username='ada')
    assert company_context.get_company_context(table, A)['vision'] == ''
    assert company_context.get_my_context(table, 'sub-ada', A)['objectives'] == []
