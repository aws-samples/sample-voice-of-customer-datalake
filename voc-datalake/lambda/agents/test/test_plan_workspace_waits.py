"""A plan approved in a workspace waits on its source and scraper runs there (7.29.00, a fix).

The approval keeps the request's workspace on the plan's META once the approver is a member there (api/agents_handler.py
``_approval_workspace``, shared/plans_store.py ``create_plan``), and its steps start a run in that workspace, whose rows
are ``WS#{ws}#SOURCE_RUN#{source}`` / ``WS#{ws}#SCRAPER_RUN#{id}`` (api/integrations_handler.py, shared/run_rows.py).
Before this release the conductor polled the deployment's ``SOURCE_RUN#{source}``, which a workspace's run never writes,
so the wait timed out after its run had succeeded. Before every poll the conductor re-checks the approver (still
enabled, still a member of the plan's workspace: agents/plan_identity.py); a refused approver stops the plan, and
nothing is read. A project job's wait still reads the deployment's job row (the project routes move at the switch, 3h).
Moto: the deployment's rows say ``error``, so a wait that read one would fail.
"""
from __future__ import annotations

import ast
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

from agents import plan_identity, plan_waits
from agents.conductor import plan_decide, plan_state
from shared import plans_store as ps
from shared.project_keys import NotPerWorkspaceError
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
NOW = datetime(2026, 11, 14, 9, 0, tzinfo=UTC)
#: A literal run id (a run started by hand or on a schedule) and a reference to the run an earlier step started.
SOURCE_WAIT = {'for': 'source_run', 'source': 'app_reviews', 'execution_id': 'ex-1'}
SCRAPER_WAIT = {'for': 'scraper_run', 'scraper_id': 'sc_9', 'execution_id': '{{s0.scraper_run}}'}
#: Each run kind's row: (the workspace's pk, the deployment's pk, sk).
ROWS = {
    'source_run': (f'WS#{WS}#SOURCE_RUN#app_reviews', 'SOURCE_RUN#app_reviews', 'ex-1'),
    'scraper_run': (f'WS#{WS}#SCRAPER_RUN#sc_9', 'SCRAPER_RUN#sc_9', 'ex-2'),
}


@pytest.fixture
def aggregates() -> Iterator[Any]:
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        with patch.object(plan_waits, 'get_aggregates_table', return_value=table):
            yield table


@pytest.fixture
def finished() -> Iterator[MagicMock]:
    with patch.object(plan_state, 'table'), patch.object(plan_state, 'journal'), \
            patch.object(ps, 'finish_step', return_value={'status': 'done'}) as finish:
        yield finish


@pytest.fixture
def approver() -> Iterator[MagicMock]:
    """The approver passes the decide's re-check (``_approver_gate``: the tests below)."""
    with patch.object(plan_identity, 'require_approver', return_value=('sub-ada', 'ada')) as check:
        yield check


def _state(wait: dict[str, Any], **meta: Any) -> plan_state.PlanState:
    return plan_state.PlanState(
        meta={'plan_id': 'plan_1', 'status': ps.PLAN_RUNNING, 'approver_sub': 'sub-ada', 'approver_username': 'ada',
              **meta},
        rows={'s0': {'status': ps.STEP_DONE, 'outputs': {'scraper_run': 'ex-2'}},
              's1': {'status': ps.STEP_WAITING, 'started_at': NOW.isoformat()}},
        definitions={'s0': {'kind': 'write'}, 's1': {'kind': 'wait', 'wait': wait}}, order=['s0', 's1'], now=NOW)


def _seed(table: Any, kind: str, *, workspace_status: str, deployment_status: str) -> None:
    workspace_pk, deployment_pk, sk = ROWS[kind]
    table.put_item(Item={'pk': workspace_pk, 'sk': sk, 'status': workspace_status})
    table.put_item(Item={'pk': deployment_pk, 'sk': sk, 'status': deployment_status})


@pytest.mark.usefixtures('approver')
@pytest.mark.parametrize('wait', [SOURCE_WAIT, SCRAPER_WAIT], ids=['literal-id', 'reference'])
def test_a_workspace_plans_run_wait_completes_from_its_workspaces_row(aggregates, finished, wait):
    _seed(aggregates, wait['for'], workspace_status='completed', deployment_status='error')
    assert plan_decide._poll_wait(_state(wait, **{WORKSPACE_FIELD: WS}), 's1') is True
    assert finished.call_args.args[3] == ps.STEP_DONE
    assert finished.call_args.kwargs['outputs'] == {'status': 'completed'}


@pytest.mark.usefixtures('approver')
@pytest.mark.parametrize('wait', [SOURCE_WAIT, SCRAPER_WAIT])
def test_a_workspace_plans_run_wait_never_reads_the_deployments_row(aggregates, finished, wait):
    """Only the deployment's row says done: the workspace's wait goes on waiting."""
    _seed(aggregates, wait['for'], workspace_status='running', deployment_status='completed')
    assert plan_decide._poll_wait(_state(wait, **{WORKSPACE_FIELD: WS}), 's1') is False
    finished.assert_not_called()


@pytest.mark.usefixtures('approver')
@pytest.mark.parametrize('wait', [SOURCE_WAIT, SCRAPER_WAIT])
def test_a_deployment_plans_run_wait_reads_the_deployments_row_as_before(aggregates, finished, wait):
    _seed(aggregates, wait['for'], workspace_status='error', deployment_status='completed')
    assert plan_decide._poll_wait(_state(wait), 's1') is True
    assert finished.call_args.args[3] == ps.STEP_DONE


@pytest.mark.parametrize(('member', 'reason'), [
    (False, "The approver is no longer a member of the plan's workspace."),
    (None, "The approver's account is disabled."),
])
def test_a_refused_approvers_waiting_plan_stops_without_reading(member, reason):
    """Checked once per decide, before its settle: no group listing, and no run row read."""
    table = MagicMock()
    refused = plan_identity.ApproverRefused(reason)
    current = patch.object(plan_identity, '_require_current', side_effect=refused if member is None else None)
    with current, patch.object(plan_identity, 'is_current_member', return_value=bool(member)) as membership, \
            patch.object(plan_identity, '_groups') as groups, \
            patch.object(plan_waits, 'get_aggregates_table', return_value=table), \
            patch.object(plan_decide, 'stop', return_value={'kind': 'finish', 'status': 'failed'}) as stop:
        assert plan_decide._approver_gate(_state(SOURCE_WAIT, **{WORKSPACE_FIELD: WS})) == (
            {'kind': 'finish', 'status': 'failed'}, False)
    assert table.mock_calls == []
    groups.assert_not_called()
    stop.assert_called_once_with('plan_1', f'The plan stopped: {reason}')
    assert membership.call_count == (1 if member is not None else 0)


def test_the_membership_is_read_for_the_plans_own_workspace():
    with patch.object(plan_identity, '_require_current'), \
            patch.object(plan_identity, 'is_current_member', return_value=True) as membership:
        assert plan_decide._approver_gate(_state(SOURCE_WAIT, **{WORKSPACE_FIELD: WS})) == (None, True)
        assert plan_decide._approver_gate(_state(SOURCE_WAIT)) == (None, True)
    membership.assert_called_once_with(WS, 'sub-ada')


def test_a_plan_with_no_wait_left_is_not_checked():
    state = _state(SOURCE_WAIT, **{WORKSPACE_FIELD: WS})
    state.rows['s1']['status'] = ps.STEP_DONE
    with patch.object(plan_identity, 'require_approver') as check:
        assert plan_decide._approver_gate(state) == (None, True)
    check.assert_not_called()


def test_a_wait_past_its_timeout_still_fails_while_the_directory_is_down(finished):
    table = MagicMock()
    state = _state(SOURCE_WAIT, **{WORKSPACE_FIELD: WS})
    state.rows['s1']['started_at'] = '2026-11-14T07:00:00+00:00'
    with patch.object(plan_waits, 'get_aggregates_table', return_value=table):
        assert plan_decide._settle_step(state, 's1', polls=False) is True
    assert table.mock_calls == []
    assert finished.call_args.kwargs['error'] == 'The wait timed out.'


@pytest.mark.usefixtures('finished')
def test_a_directory_fault_leaves_the_waits_unpolled_this_time():
    table = MagicMock()
    state = _state(SOURCE_WAIT, **{WORKSPACE_FIELD: WS})
    with patch.object(plan_identity, 'require_approver', side_effect=plan_identity.DirectoryUnavailable('x')), \
            patch.object(plan_waits, 'get_aggregates_table', return_value=table):
        assert plan_decide._approver_gate(state) == (None, False)
        assert plan_decide._settle_step(state, 's1', polls=False) is False
    assert table.mock_calls == []


@pytest.mark.usefixtures('aggregates')
def test_a_plan_whose_workspace_field_names_none_fails_its_wait_without_a_read(finished):
    with patch.object(plan_waits, 'poll') as poll:
        assert plan_decide._poll_wait(_state(SOURCE_WAIT, **{WORKSPACE_FIELD: 'nope'}), 's1') is True
    poll.assert_not_called()
    assert finished.call_args.args[3] == ps.STEP_FAILED
    assert finished.call_args.kwargs['error'] == 'The plan names no workspace it may wait in.'


PROJECTS_HANDLER: Final = Path(__file__).resolve().parents[2] / 'api' / 'projects_handler.py'


def _job_event_names_a_workspace() -> bool:
    """Whether api/projects_handler.py ``_job_event`` passes ``workspace_payload`` anything but the literal None."""
    tree = ast.parse(PROJECTS_HANDLER.read_text(encoding='utf-8'))
    [function] = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == '_job_event']
    [call] = [node for node in ast.walk(function) if isinstance(node, ast.Call)
              and isinstance(node.func, ast.Name) and node.func.id == 'workspace_payload']
    source = call.args[1] if len(call.args) > 1 else None
    return not (isinstance(source, ast.Constant) and source.value is None)


def test_project_jobs_and_their_plan_waits_move_into_a_workspace_together():
    """The 3h seam. While project jobs are the deployment's (``_job_event`` names no workspace), a workspace plan's
    project-job wait reads the deployment's job; once a job's event names its workspace, its row is the workspace's,
    and a wait still on the deployment's row would time out as the run waits did before 7.29.00. So the switch must
    move both: this fails until ``plan_waits``' project-job target and ``plan_decide`` read the plan's workspace."""
    waits_in_workspace = 'project_job' in plan_waits.WORKSPACE_KINDS
    assert _job_event_names_a_workspace() == waits_in_workspace


def test_a_workspace_plans_project_job_wait_reads_the_deployments_job():
    """The project routes do not resolve a workspace yet, so the job a step started is the deployment's."""
    job_wait = {'for': 'project_job', 'project_id': 'proj_1', 'job_id': 'job_7'}
    assert plan_decide._wait_workspace(_state(job_wait, **{WORKSPACE_FIELD: WS}), job_wait) is None
    with pytest.raises(NotPerWorkspaceError, match=r'^A project job wait is not per workspace yet$'), \
            patch.object(plan_waits, 'get_jobs_table', return_value=MagicMock()):
        plan_waits.poll(job_wait, {}, workspace=WorkspaceScope(WS))
