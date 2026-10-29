"""POST /agents/{agent_id}/runs/{run_id}/decision — a human's decision on a needs_human run.

Runs against the moto tables with Step Functions mocked (agents_handler_fixtures).
The conductor side (what a resumed execution does) is test_conductor_resume.py.
"""
import json
from decimal import Decimal

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from agents_handler_fixtures import create as _create
from botocore.exceptions import ClientError

from shared import agents_store as store

LOOP_STOP = {'reason': 'loop_exhausted', 'node_id': 'prfaq_review', 'node_title': 'Persona review',
             'loop_index': 0, 'max_rounds': 3,
             'verdicts': [{'name': 'Example Air traveller', 'score': Decimal('2.5'), 'blocking': True,
                           'objections': ['Too many steps']}]}
END_STOP = {'reason': 'end_node', 'node_id': 'needs_human', 'node_title': 'Needs a human'}
FINISHED_AT = '2026-01-02T03:04:05+00:00'


def _needs_human_run(env, lambda_context, payload: dict | None = LOOP_STOP, **run_sets) -> tuple[str, str]:
    """An agent whose run stopped for a human (what agents/store.finish_run leaves behind)."""
    agent_id = _create(lambda_context)['agent_id']
    run_id = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[1]['run']['run_id']
    sets = {'status': 'needs_human', 'finished_at': FINISHED_AT, 'error': 'Persona review: no agreement',
            'model_calls': 40, 'steps': 30, **run_sets}
    if payload is not None:
        sets['needs_human'] = payload
    names = {f'#a{i}': key for i, key in enumerate(sets)}
    values = {f':v{i}': value for i, value in enumerate(sets.values())}
    env.agents.update_item(Key=store.run_key(agent_id, run_id),
                           UpdateExpression='SET ' + ', '.join(f'#a{i} = :v{i}' for i in range(len(sets)))
                           + ' REMOVE gsi1pk, gsi1sk',
                           ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    env.agents.update_item(Key=store.agent_key(agent_id), UpdateExpression='REMOVE active_run_id SET last_run_status = :s',
                           ExpressionAttributeValues={':s': 'needs_human'})
    env.sfn.start_execution.reset_mock()
    return agent_id, run_id


def _decide(lambda_context, agent_id: str, run_id: str, body: object, **kwargs) -> tuple[int, dict]:
    return _call(lambda_context, 'POST', f'/agents/{agent_id}/runs/{run_id}/decision', body=body, **kwargs)


def _run(env, agent_id: str, run_id: str) -> dict:
    row = store.get_run(env.agents, agent_id, run_id)
    assert row is not None
    return row


def _agent(env, agent_id: str) -> dict:
    row = store.get_agent(env.agents, agent_id)
    assert row is not None
    return row


def _summaries(env, run_id: str) -> list[str]:
    return [event['summary'] for event in store.list_events(env.agents, run_id, after=0, limit=200)]


class TestTheRunView:
    def test_a_needs_human_run_shows_its_stop_and_the_allowed_decisions(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            run = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}')[1]['run']
            assert run['needs_human'] == {**LOOP_STOP, 'verdicts': [{**LOOP_STOP['verdicts'][0], 'score': 2.5}]}
            assert run['decision'] is None
            assert run['actions'] == ['accept', 'another_round', 'stop']

    def test_a_run_from_before_payloads_can_only_be_closed(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context, payload=None)
            run = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}')[1]['run']
            assert (run['needs_human'], run['actions']) == (None, ['stop'])


class TestRefusals:
    def test_a_plain_user_is_refused(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            assert _decide(lambda_context, agent_id, run_id, {'decision': 'stop'}, claims=USER)[0] == 403

    def test_a_delegated_admin_credential_is_refused(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            claims = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
            assert _decide(lambda_context, agent_id, run_id, {'decision': 'stop'}, claims=claims)[0] == 403

    def test_an_unknown_run_is_404(self, lambda_context):
        with _api() as env:
            agent_id, _ = _needs_human_run(env, lambda_context)
            assert _decide(lambda_context, agent_id, 'ar_ffffffffffff', {'decision': 'stop'})[0] == 404
            assert _decide(lambda_context, agent_id, 'not-a-run', {'decision': 'stop'})[0] == 404

    @pytest.mark.parametrize('body', [
        {}, {'decision': 'retry'}, {'decision': 'stop', 'note': 7}, {'decision': 'stop', 'note': 'x' * 6001},
    ])
    def test_a_malformed_body_is_400(self, lambda_context, body):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            assert _decide(lambda_context, agent_id, run_id, body)[0] == 400

    @pytest.mark.parametrize('decision', ['accept', 'another_round'])
    def test_a_decision_the_stop_does_not_allow_is_400(self, lambda_context, decision):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context, END_STOP)
            status, body = _decide(lambda_context, agent_id, run_id, {'decision': decision})
            assert status == 400
            assert body['error'] == 'decision must be one of stop for this run'
            env.sfn.start_execution.assert_not_called()

    def test_a_run_that_is_not_waiting_is_409(self, lambda_context):
        with _api():
            agent_id = _create(lambda_context)['agent_id']
            run_id = _call(lambda_context, 'POST', f'/agents/{agent_id}/run')[1]['run']['run_id']
            status, body = _decide(lambda_context, agent_id, run_id, {'decision': 'stop'})
            assert (status, body['error']) == (409, 'This run is not waiting for a decision')

    def test_another_active_run_of_the_agent_is_409(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            env.agents.update_item(Key=store.agent_key(agent_id), UpdateExpression='SET active_run_id = :r',
                                   ExpressionAttributeValues={':r': 'ar_eeeeeeeeeeee'})
            status, body = _decide(lambda_context, agent_id, run_id, {'decision': 'accept'})
            assert (status, body['error']) == (409, 'This agent already has a run in progress')
            assert _run(env, agent_id, run_id)['status'] == 'needs_human'
            env.sfn.start_execution.assert_not_called()


class TestStop:
    def test_closes_the_run_without_an_execution(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            status, body = _decide(lambda_context, agent_id, run_id, {'decision': 'stop', 'note': '   '})
            assert status == 200
            run = body['run']
            assert (run['status'], run['finished_at'], run['actions'], run['needs_human']) == (
                'completed', FINISHED_AT, [], None)
            assert {k: v for k, v in run['decision'].items() if k != 'at'} == {
                'decision': 'stop', 'note': None, 'by_username': 'alice'}
            assert run['decision']['at']
            env.sfn.start_execution.assert_not_called()
            assert _summaries(env, run_id)[-1] == 'Closed by alice: no further action.'
            assert _agent(env, agent_id)['last_run_status'] == 'completed'

    def test_a_closed_run_carries_no_error_and_the_journal_keeps_the_pause(self, lambda_context):
        # 5.35.02 live: the completed run still showed "Needs a human: the workflow asks for a human."
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context, END_STOP,
                                                error='Needs a human: the workflow asks for a human.')
            store.append_event(env.agents, agent_id, run_id, 'decision',
                               'Needs a human: the workflow asks for a human.', now=store.utc_now())
            run = _decide(lambda_context, agent_id, run_id, {'decision': 'stop'})[1]['run']

            assert (run['status'], run['error']) == ('completed', None)
            assert 'error' not in _run(env, agent_id, run_id)
            assert 'Needs a human: the workflow asks for a human.' in _summaries(env, run_id)

    def test_a_completed_run_stored_with_an_error_reads_without_one(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context, None, status='completed')
            run = _call(lambda_context, 'GET', f'/agents/{agent_id}/runs/{run_id}')[1]['run']

            assert (run['status'], run['error']) == ('completed', None)

    def test_a_note_is_trimmed_and_journalled(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            body = _decide(lambda_context, agent_id, run_id, {'decision': 'stop', 'note': '  Shipped by hand. '})[1]
            assert body['run']['decision']['note'] == 'Shipped by hand.'
            assert _summaries(env, run_id)[-1] == 'Closed by alice: Shipped by hand.'

    def test_a_second_decision_is_409(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            assert _decide(lambda_context, agent_id, run_id, {'decision': 'stop'})[0] == 200
            assert _decide(lambda_context, agent_id, run_id, {'decision': 'stop'})[0] == 409


class TestResume:
    def test_accept_takes_the_lock_queues_the_run_and_starts_execution_r1(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            status, body = _decide(lambda_context, agent_id, run_id, {'decision': 'accept'})
            assert status == 200
            assert body['run']['status'] == 'queued'
            assert body['run']['decision']['decision'] == 'accept'
            assert body['run']['finished_at'] is None
            assert body['run']['error'] is None
            kwargs = env.sfn.start_execution.call_args.kwargs
            assert kwargs['name'] == f'{run_id}-r1'
            assert json.loads(kwargs['input']) == {'run_id': run_id, 'agent_id': agent_id}
            row = _run(env, agent_id, run_id)
            assert row['resume'] == {'decision': 'accept', 'note': None}
            assert (int(row['resume_count']), int(row['call_ceiling']), int(row['step_ceiling'])) == (1, 190, 150)
            assert row['gsi1pk'] == 'RUNS_ACTIVE'
            assert row['execution_arn'].endswith(f':{run_id}-r1')
            agent = _agent(env, agent_id)
            assert (agent['active_run_id'], agent['last_run_status']) == (run_id, 'queued')
            assert _summaries(env, run_id)[-1] == 'alice decided: accept and continue'
            assert _decide(lambda_context, agent_id, run_id, {'decision': 'accept'})[0] == 409
            assert env.sfn.start_execution.call_count == 1

    def test_another_round_carries_the_note(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context, resume_count=1)
            note = 'Drop the loyalty step.'
            assert _decide(lambda_context, agent_id, run_id, {'decision': 'another_round', 'note': note})[0] == 200
            assert env.sfn.start_execution.call_args.kwargs['name'] == f'{run_id}-r2'
            assert _run(env, agent_id, run_id)['resume'] == {'decision': 'another_round', 'note': note}
            assert _summaries(env, run_id)[-1] == f'alice decided: one more round — {note}'

    def test_a_failed_start_fails_the_run_and_frees_the_lock(self, lambda_context):
        with _api() as env:
            agent_id, run_id = _needs_human_run(env, lambda_context)
            env.sfn.start_execution.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'StartExecution')
            assert _decide(lambda_context, agent_id, run_id, {'decision': 'accept'})[0] == 500
            assert _run(env, agent_id, run_id)['status'] == 'failed'
            assert 'active_run_id' not in _agent(env, agent_id)
