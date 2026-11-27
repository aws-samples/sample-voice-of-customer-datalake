"""The job stores per workspace (docs/multi-workspace.md, the project plan, 3c; 7.29.00).

shared/jobs.py, shared/job_notices.py, shared/assist_jobs.py and agents/plan_waits.py take a keyword-only
``workspace``: in one, a job row is ``WS#{ws}#PROJECT#{id}`` / ``JOB#{job_id}`` (``WS#{ws}#ASSIST#{sub}`` for an
assist outside a project), listed at ``WS#{ws}#STATUS#{status}``, every call through shared/ws_repo.py ``ws_table``;
without one every request is the one sent before (pinned here on a recording table, and by the mutation suites). A
job's worker reads its workspace from its event (shared/ws_repo.py ``event_scope``: an invoke's own ``workspace_id``,
or a state machine state's ``run_scope``) and keys every job-row call by it, but the work is not per workspace yet: it
marks its own row failed and runs nothing. No route passes a workspace yet.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from agents import plan_waits, principal
from shared import assist_jobs, job_notices, jobs
from shared.exceptions import ServiceError
from shared.project_keys import (
    AGENT_RUNS_STORE,
    PROJECT_JOB_WORK_STORE,
    NotPerWorkspaceError,
    job_status_pk,
    project_pk,
    require_deployment,
)
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import WorkspaceContext
from shared.workspace_routing import workspace_payload
from shared.ws_repo import RUN_SCOPE_FIELD, WORKSPACE_FIELD, OutOfScopeError, WorkspaceScope, event_scope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
A = WorkspaceScope(WS_A)
B = WorkspaceScope(WS_B)
SCOPES = (None, A, B)
PROJECT = 'proj_shared_id'
CONTEXT_A = WorkspaceContext(ws=WS_A, role='editor', name='Team', slug='team', platform_admin=False)


def _context(remaining_ms: int = 600_000) -> SimpleNamespace:
    return SimpleNamespace(get_remaining_time_in_millis=lambda: remaining_ms, aws_request_id='req-1',
                           invoked_function_arn='arn:aws:lambda:us-east-1:111111111111:function:job')


@pytest.fixture
def table():
    with mock_aws():
        created = create_pk_sk_table('test-jobs')
        with patch.object(jobs, 'get_jobs_table', return_value=created), \
                patch.object(job_notices, 'get_jobs_table', return_value=created), \
                patch.object(assist_jobs, 'get_jobs_table', return_value=created), \
                patch.object(plan_waits, 'get_jobs_table', return_value=created), \
                patch.object(plan_waits, 'get_aggregates_table', return_value=created):
            yield created


def _rows(table, pk: str) -> list[dict]:
    return table.query(KeyConditionExpression=Key('pk').eq(pk), ConsistentRead=True)['Items']


def _row(table, scope, job_id: str) -> dict | None:
    return table.get_item(Key={'pk': project_pk(PROJECT, workspace=scope), 'sk': f'JOB#{job_id}'},
                          ConsistentRead=True).get('Item')


# ── event_scope: the worker's one reader ────────────────────────────────────────────────────────────────────────────

def test_an_event_without_a_workspace_is_the_deployments():
    assert event_scope({'project_id': PROJECT, 'job_id': 'job_1'}) is None
    assert event_scope({RUN_SCOPE_FIELD: {}}) is None


def test_an_invoke_and_a_state_name_the_workspace_each_their_way():
    assert event_scope({WORKSPACE_FIELD: WS_A}) == A
    assert event_scope({RUN_SCOPE_FIELD: {WORKSPACE_FIELD: WS_B}}) == B


@pytest.mark.parametrize('event', [
    {WORKSPACE_FIELD: 'not-a-workspace'},
    {WORKSPACE_FIELD: None},
    {RUN_SCOPE_FIELD: {WORKSPACE_FIELD: 'not-a-workspace'}},
    {RUN_SCOPE_FIELD: None},
    {RUN_SCOPE_FIELD: [WS_A]},
    {RUN_SCOPE_FIELD: {}, WORKSPACE_FIELD: WS_A},
])
def test_an_event_that_names_no_workspace_it_may_run_in_is_refused(event):
    with pytest.raises(ValueError, match='workspace'):
        event_scope(event)


def test_a_payload_without_a_workspace_is_unchanged():
    """``workspace_payload`` leaves the field out deployment-wide: a job event is exactly its fields."""
    fields = {'project_id': PROJECT, 'job_id': 'job_1', 'doc_config': {'doc_type': 'prd'}}
    assert workspace_payload(fields, None) == fields
    assert list(workspace_payload(fields, CONTEXT_A)) == [*fields, WORKSPACE_FIELD]


# ── shared/jobs.py ──────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize('scope', SCOPES)
def test_a_job_is_created_and_updated_in_its_scope_only(table, scope):
    job_id, _ = jobs.create_job(PROJECT, 'research', 'research_config', {'q': 1}, status='pending',
                                workspace=scope)
    row = _row(table, scope, job_id)
    assert row is not None
    assert row['gsi1pk'] == job_status_pk('pending', workspace=scope)
    jobs.update_job_status(PROJECT, job_id, 'running', 40, 'analysing', workspace=scope)
    row = _row(table, scope, job_id)
    assert row is not None
    assert row['gsi1pk'] == job_status_pk('running', workspace=scope)
    assert row['progress'] == 40
    others = [other for other in SCOPES if other != scope]
    assert all(_rows(table, project_pk(PROJECT, workspace=other)) == [] for other in others)


def test_a_workspace_jobs_status_partition_is_its_own():
    assert job_status_pk('running', workspace=None) == 'STATUS#running'
    assert job_status_pk('running', workspace=A) == f'WS#{WS_A}#STATUS#running'


def test_an_update_in_another_scope_never_writes_a_row(table):
    job_id, _ = jobs.create_job(PROJECT, 'research', 'research_config', {}, workspace=A)
    jobs.update_job_status(PROJECT, job_id, 'failed', 0, 'error', error='x', workspace=B)
    jobs.update_job_status(PROJECT, job_id, 'failed', 0, 'error', error='x')
    assert _rows(table, project_pk(PROJECT, workspace=B)) == []
    assert _rows(table, project_pk(PROJECT, workspace=None)) == []
    row = _row(table, A, job_id)
    assert row is not None
    assert row['status'] == 'running'


def test_a_claim_takes_its_workspaces_row(table):
    job_id, _ = jobs.create_job(PROJECT, 'merge_documents', 'merge_config', {}, status='pending', workspace=A)
    assert jobs.claim_job_execution(PROJECT, job_id, _context(), workspace=B) is False
    assert jobs.claim_job_execution(PROJECT, job_id, _context(), workspace=A) is True
    row = _row(table, A, job_id)
    assert row is not None
    assert row['gsi1pk'] == f'WS#{WS_A}#STATUS#running'
    assert row['execution_owner'] == 'req-1'


@pytest.mark.usefixtures('table')
def test_a_lease_waiter_reads_its_workspaces_row():
    job_id, _ = jobs.create_job(PROJECT, 'merge_documents', 'merge_config', {}, status='pending', workspace=A)
    event = {'project_id': PROJECT, 'job_id': job_id, WORKSPACE_FIELD: WS_A}
    assert jobs.recover_job_execution_claim(event, _context(), workspace=A) is True
    with pytest.raises(ServiceError, match='no longer exists'):
        jobs.recover_job_execution_claim(event, _context(), workspace=B)


def test_without_a_workspace_the_requests_are_the_deployments():
    """The deployment's path, request for request: the same keys, index partition, condition and parameters."""
    recording = MagicMock()
    with patch.object(jobs, 'get_jobs_table', return_value=recording), \
            patch.object(jobs.uuid, 'uuid4', return_value=SimpleNamespace(hex='0123456789abcdef0000')), \
            patch.object(jobs, 'now_iso', return_value='2026-11-14T09:00:00+00:00'):
        jobs.create_job(PROJECT, 'research', 'research_config', {'q': 1}, ttl_minutes=0, status='pending')
        jobs.update_job_status(PROJECT, 'job_0123456789abcdef', 'running', 10, 'starting')
    put = recording.put_item.call_args.kwargs['Item']
    assert {key: put[key] for key in ('pk', 'sk', 'gsi1pk', 'gsi1sk', 'status')} == {
        'pk': f'PROJECT#{PROJECT}', 'sk': 'JOB#job_0123456789abcdef', 'gsi1pk': 'STATUS#pending',
        'gsi1sk': '2026-11-14T09:00:00+00:00', 'status': 'pending'}
    assert recording.put_item.call_args.args == ()
    recording.update_item.assert_called_once_with(
        Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'JOB#job_0123456789abcdef'},
        UpdateExpression=('SET #status = :status, progress = :progress, updated_at = :now, gsi1pk = :gsi1pk, '
                          'current_step = :step'),
        ExpressionAttributeValues={':status': 'running', ':progress': 10, ':now': '2026-11-14T09:00:00+00:00',
                                   ':gsi1pk': 'STATUS#running', ':step': 'starting'},
        ExpressionAttributeNames={'#status': 'status'},
        ConditionExpression='attribute_exists(pk) AND attribute_exists(sk)',
    )


def _sample_body():
    body = MagicMock(return_value={'document_id': 'd1'})
    body.__name__ = 'sample_job'
    return body


def test_a_job_event_that_names_a_workspace_fails_its_own_row_and_runs_nothing(table):
    job_id, _ = jobs.create_job(PROJECT, 'generate_prd', 'doc_config', {}, status='pending', workspace=A)
    body = _sample_body()
    handler = jobs.job_handler(error_message='Document generation failed')(body)
    with pytest.raises(ServiceError, match='Document generation failed'):
        handler({'project_id': PROJECT, 'job_id': job_id, 'doc_config': {}, WORKSPACE_FIELD: WS_A}, _context())
    body.assert_not_called()
    row = _row(table, A, job_id)
    assert row is not None
    assert row['status'] == 'failed'
    assert row['gsi1pk'] == f'WS#{WS_A}#STATUS#failed'
    assert row['error'] == 'Document generation failed: Project job work is not per workspace yet'
    assert _rows(table, project_pk(PROJECT, workspace=None)) == []


def test_a_job_event_without_a_workspace_runs_as_before(table):
    job_id, _ = jobs.create_job(PROJECT, 'generate_prd', 'doc_config', {}, status='pending')
    body = _sample_body()
    answer = jobs.job_handler()(body)({'project_id': PROJECT, 'job_id': job_id, 'doc_config': {'k': 1}}, _context())
    assert answer == {'success': True, 'document_id': 'd1'}
    assert body.call_args.args[0].workspace is None
    row = _row(table, None, job_id)
    assert row is not None
    assert row['gsi1pk'] == 'STATUS#completed'


def test_a_job_event_naming_no_workspace_touches_no_row():
    recording = MagicMock()
    body = _sample_body()
    with patch.object(jobs, 'get_jobs_table', return_value=recording), pytest.raises(ValueError, match='workspace'):
        jobs.job_handler()(body)({'project_id': PROJECT, 'job_id': 'job_1', WORKSPACE_FIELD: 'ws_nope'}, _context())
    assert recording.mock_calls == []
    body.assert_not_called()


def test_progress_lands_in_the_contexts_workspace(table):
    job_id, _ = jobs.create_job(PROJECT, 'research', 'research_config', {}, workspace=B)
    jobs.JobContext(PROJECT, job_id, workspace=B).update_progress(55, 'synthesizing')
    row = _row(table, B, job_id)
    assert row is not None
    assert row['current_step'] == 'synthesizing'


# ── shared/job_notices.py ───────────────────────────────────────────────────────────────────────────────────────────

def test_a_notice_reads_its_workspaces_row(table):
    table.put_item(Item={'pk': project_pk(PROJECT, workspace=A), 'sk': 'JOB#job_1', 'initiated_by': 'sub-a',
                         'job_type': 'research'})
    table.put_item(Item={'pk': project_pk(PROJECT, workspace=None), 'sk': 'JOB#job_1',
                         'initiated_by': 'sub-deployment'})
    with patch.object(job_notices.realtime, 'configured', return_value=True), \
            patch.object(job_notices.realtime, 'publish', return_value=True) as publish:
        assert job_notices.notify_project_job(PROJECT, 'job_1', 'completed', workspace=A) is True
        assert job_notices.notify_project_job(PROJECT, 'job_1', 'completed', workspace=B) is False
    assert publish.call_count == 1
    assert publish.call_args.args[1] == 'sub-a'


# ── shared/assist_jobs.py ───────────────────────────────────────────────────────────────────────────────────────────

def test_an_owned_assist_lives_in_its_workspace(table):
    assert assist_jobs.owner_pk('sub-1') == 'ASSIST#sub-1'
    assert assist_jobs.owner_pk('sub-1', workspace=CONTEXT_A) == f'WS#{WS_A}#ASSIST#sub-1'
    with patch.object(assist_jobs, 'invoke_lambda_async') as invoke, \
            patch.dict('os.environ', {'ASSIST_WORKER_FUNCTION': 'worker'}):
        started = assist_jobs.start_owned('sub-1', 'assist_categories', {}, workspace=CONTEXT_A)
    assert invoke.call_args.args[1]['pk'] == f'WS#{WS_A}#ASSIST#sub-1'
    assert table.get_item(Key={'pk': f'WS#{WS_A}#ASSIST#sub-1', 'sk': f"JOB#{started['job_id']}"}).get('Item')


def test_an_assist_in_a_workspace_is_written_and_invoked_there_and_runs_nothing(table):
    pk = assist_jobs.owner_pk('sub-1', workspace=CONTEXT_A)
    with patch.object(assist_jobs, 'invoke_lambda_async') as invoke:
        started = assist_jobs.start(pk, 'assist_suggest', {'text': 'x'}, worker_function='worker',
                                    initiated_by='sub-1', workspace=CONTEXT_A)
    event = invoke.call_args.args[1]
    assert event[WORKSPACE_FIELD] == WS_A
    assert list(event)[-1] == WORKSPACE_FIELD
    row = table.get_item(Key={'pk': pk, 'sk': f"JOB#{started['job_id']}"}).get('Item')
    assert row is not None
    assert row['gsi1pk'] == f'WS#{WS_A}#STATUS#pending'
    work = MagicMock(return_value={'ok': True})
    with patch.object(assist_jobs.realtime, 'publish') as publish:
        outcome = assist_jobs.run(event, {'assist_suggest': assist_jobs.Work(work, 'The assistant failed.')})
    assert outcome == {'status': 'failed'}
    work.assert_not_called()
    answer = assist_jobs.get(pk, started['job_id'], workspace=CONTEXT_A)
    assert answer['status'] == 'failed'
    assert answer['error'] == 'The assistant failed.'
    assert publish.call_args.args[1] == 'sub-1'
    # Another workspace's view refuses the key before DynamoDB.
    other = WorkspaceContext(ws=WS_B, role='editor', name='Other', slug='other', platform_admin=False)
    with pytest.raises(OutOfScopeError, match='outside'):
        assist_jobs.get(pk, started['job_id'], workspace=other)


@pytest.mark.usefixtures('table')
def test_a_per_workspace_assist_runs_in_its_workspace_and_counts_its_model_calls_there():
    """7.55.00: a kind that reads only its job's config (a feedback form's AI draft) opts in (``per_workspace``): it
    runs for a workspace's job, its Bedrock calls counted to that workspace (shared/usage_meter.py)."""
    from shared import usage_meter
    pk = assist_jobs.owner_pk('sub-1', workspace=CONTEXT_A)
    with patch.object(assist_jobs, 'invoke_lambda_async') as invoke:
        started = assist_jobs.start(pk, 'assist_form_draft', {'text': 'x'}, worker_function='worker',
                                    initiated_by='sub-1', workspace=CONTEXT_A)
    seen: list[str] = []

    def work(config: dict) -> dict:
        seen.append(usage_meter.current_attribution())
        return {'success': True, 'echo': config['text']}
    with patch.object(assist_jobs.realtime, 'publish'):
        outcome = assist_jobs.run(invoke.call_args.args[1], {
            'assist_form_draft': assist_jobs.Work(work, 'The draft failed.', per_workspace=True)})
    assert outcome == {'status': 'completed'}
    assert seen == [WS_A]
    assert assist_jobs.get(pk, started['job_id'], workspace=CONTEXT_A)['result'] == {'success': True, 'echo': 'x'}


def test_an_assist_event_naming_no_workspace_is_ignored(table):
    assert assist_jobs.run({'pk': 'ASSIST#sub-1', 'job_id': 'job_1', WORKSPACE_FIELD: 'nope'}, {}) == {
        'status': 'ignored'}
    assert _rows(table, 'ASSIST#sub-1') == []


@pytest.mark.parametrize('event', [
    # The deployment's event naming a workspace's partition, a workspace's naming the deployment's or another's.
    {'pk': f'WS#{WS_A}#ASSIST#sub-1', 'job_id': 'job_1'},
    {'pk': 'ASSIST#sub-1', 'job_id': 'job_1', WORKSPACE_FIELD: WS_A},
    {'pk': f'WS#{WS_B}#ASSIST#sub-1', 'job_id': 'job_1', WORKSPACE_FIELD: WS_A},
    {'pk': 'WS#broken', 'job_id': 'job_1'},
])
def test_an_assist_event_outside_its_own_scope_touches_no_row(event):
    recording = MagicMock()
    with patch.object(assist_jobs, 'get_jobs_table', return_value=recording), \
            patch.object(assist_jobs, 'logger') as log:
        assert assist_jobs.run(event, {}) == {'status': 'ignored'}
    assert recording.mock_calls == []
    log.error.assert_called_once_with('Assist event refused', extra={'error': 'OutOfScopeError'})


def test_a_layer_refusal_of_the_claim_never_raises():
    with patch.object(assist_jobs, '_claim', side_effect=OutOfScopeError('a key outside the workspace')), \
            patch.object(assist_jobs, 'logger') as log:
        assert assist_jobs.run({'pk': 'ASSIST#sub-1', 'job_id': 'job_1'}, {}) == {'status': 'ignored'}
    log.error.assert_called_once_with('Assist event refused', extra={'error': 'OutOfScopeError'})


def test_an_assist_without_a_workspace_sends_the_event_it_always_sent(table):
    with patch.object(assist_jobs, 'invoke_lambda_async') as invoke, \
            patch.object(assist_jobs, 'payload_fields', return_value={}):
        started = assist_jobs.start('ASSIST#sub-1', 'assist_suggest', {}, worker_function='worker',
                                    initiated_by='sub-1')
    invoke.assert_called_once_with('worker', {'action': 'assist_job', 'pk': 'ASSIST#sub-1',
                                              'job_id': started['job_id']})
    row = table.get_item(Key={'pk': 'ASSIST#sub-1', 'sk': f"JOB#{started['job_id']}"}).get('Item')
    assert row is not None
    assert row['gsi1pk'] == 'STATUS#pending'


# ── agents/plan_waits.py ────────────────────────────────────────────────────────────────────────────────────────────

#: A run an earlier step started, by its recorded output (a workspace's wait names no literal run id).
STARTED = {'s1.execution_id': 'e1'}


@pytest.mark.parametrize(('wait', 'pk', 'sk'), [
    ({'for': 'source_run', 'source': 'web', 'execution_id': '{{s1.execution_id}}'}, f'WS#{WS_A}#SOURCE_RUN#web', 'e1'),
    ({'for': 'scraper_run', 'scraper_id': 's1', 'execution_id': '{{s1.execution_id}}'},
     f'WS#{WS_A}#SCRAPER_RUN#s1', 'e1'),
])
def test_a_wait_in_a_workspace_reads_its_rows_only(table, wait, pk, sk):
    table.put_item(Item={'pk': pk, 'sk': sk, 'status': 'completed'})
    assert plan_waits.poll(wait, STARTED, workspace=A).status == plan_waits.WAIT_DONE
    assert plan_waits.poll(wait, STARTED, workspace=B).status == plan_waits.WAIT_PENDING
    assert plan_waits.poll(wait, STARTED).status == plan_waits.WAIT_PENDING


def test_a_wait_without_a_workspace_reads_the_deployments_keys():
    recording = MagicMock()
    recording.get_item.return_value = {}
    with patch.object(plan_waits, 'get_aggregates_table', return_value=recording):
        plan_waits.poll({'for': 'source_run', 'source': 'web', 'execution_id': 'e1'}, {})
    recording.get_item.assert_called_once_with(Key={'pk': 'SOURCE_RUN#web', 'sk': 'e1'}, ConsistentRead=True)


@pytest.mark.usefixtures('table')
def test_a_wait_in_a_workspace_that_names_no_id_fails():
    result = plan_waits.poll({'for': 'source_run', 'source': '', 'execution_id': '{{s1.execution_id}}'}, STARTED,
                             workspace=A)
    assert result.status == plan_waits.WAIT_FAILED
    assert result.error == 'The step waits for a job it does not name.'


# ── agents/principal.py ─────────────────────────────────────────────────────────────────────────────────────────────

def test_an_agent_run_in_a_workspace_carries_its_claim():
    agent = {'agent_id': 'agt_1', 'owner_sub': 'sub-owner'}
    assert principal.agent_claims(agent, workspace=A)['voc:workspace'] == WS_A
    assert 'voc:workspace' not in principal.agent_claims(agent)


def test_the_work_refusals_name_their_stores():
    with pytest.raises(NotPerWorkspaceError, match='Project job work is not per workspace yet'):
        require_deployment(A, PROJECT_JOB_WORK_STORE)
    with pytest.raises(NotPerWorkspaceError, match='Agent runs is not per workspace yet'):
        require_deployment(A, AGENT_RUNS_STORE)
