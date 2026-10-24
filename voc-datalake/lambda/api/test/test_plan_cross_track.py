"""The plan, across tracks: the SPA's approval route, the conductor and the TypeScript plan-step runner.

``lambda/shared/test/fixtures/plan-step-example.json`` holds what ``voc-plan-step`` (lambda/stream,
src/plan-step) ANSWERED for each write/think step of the Example Air plan, over stubbed delegates and Bedrock,
and the event it was given. Regenerate it after changing the runner, the write requests or the plan:

    cd voc-datalake/lambda/stream && npx jiti scripts/write-plan-step-fixtures.mjs \\
        > ../shared/test/fixtures/plan-step-example.json

(``src/plan-step/example-run-fixtures.test.ts`` fails while it is stale.) Here the real route stores the
plan (``POST /agents/plans``), the real conductor decides, prepares and records every step, the waits
poll real status rows, and each plan-step invocation is answered with the recorded answer — after
checking that the conductor's event is one the runner was given. s5 is the deliberate deviation: the
runner pauses it (``needs_approval``), the approver approves it through the route, and it resumes with
exactly the paused write.
"""
from __future__ import annotations

import json
from collections import defaultdict, deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, api, call

from agents.test.plan_fixtures import FakeCognito, PlanEnv, PlanStep, conduct, drive, run_steps
from shared import plans_store as ps
from shared.plan_canonical import canonical_write_fingerprint

FIXTURE: dict = json.loads((Path(__file__).resolve().parents[2] / 'shared' / 'test' / 'fixtures'
                            / 'plan-step-example.json').read_text(encoding='utf-8'))
PLACEHOLDER = 'pl_000000000000'
JOBS_TABLE = 'test-cross-track-jobs'
AGGREGATES_TABLE = 'test-aggregates-agents'  # the aggregates table agents_env creates


def _subset(recorded: dict, actual: dict) -> bool:
    return all(actual.get(key) == value for key, value in recorded.items())


@dataclass
class RecordedPlanStep(PlanStep):
    """voc-plan-step answered from the recording, per step in order; the event must be the recorded one."""

    queue: dict[str, deque] = field(default_factory=lambda: defaultdict(deque))
    mismatches: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        for run in FIXTURE['runs']:
            self.queue[run['event']['step']['id']].append(run)

    def _matches(self, recorded: dict, event: dict) -> bool:
        principal = f"plan:{event['plan_id']}"
        claims = {**recorded['claims'], 'voc:principal': principal}
        return (event['step'] == recorded['step'] and event['claims'] == claims
                and _subset(recorded['resolved'], event['resolved'])
                and _subset(recorded['think_outputs'], event['think_outputs'])
                and event.get('approved_pending') == recorded.get('approved_pending'))

    def __call__(self, event: dict) -> dict:
        self.events.append(event)
        step_id = event['step']['id']
        run = self.queue[step_id].popleft()
        if not self._matches(run['event'], event):
            self.mismatches.append(step_id)
        return run['answer']


def _jobs_table(resource: Any) -> Any:
    return resource.create_table(
        TableName=JOBS_TABLE, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'}, {'AttributeName': 'sk', 'AttributeType': 'S'}])


@dataclass
class CrossTrack:
    plan_id: str
    plan_step: RecordedPlanStep
    finish: dict
    statuses: dict[str, str]
    meta: dict
    approve_status: int
    source_polls: list[str]


class Background:
    """The background jobs: the import is still running at the first poll, done at the next."""

    def __init__(self, env: Any, jobs: Any, lambda_context: Any) -> None:
        self.env, self.jobs, self.lambda_context = env, jobs, lambda_context
        self.source_polls: list[str] = []
        self.approve_status = 0
        self.plan_id = ''

    def __call__(self, _wait_number: int) -> None:
        status = 'running' if not self.source_polls else 'completed'
        self.source_polls.append(status)
        self.env.aggregates.put_item(Item={'pk': 'SOURCE_RUN#app_reviews_ios', 'sk': 'ex_ios_1', 'status': status,
                                           'items_found': 42})
        for job_id in ('job_personas', 'job_prfaq', 'job_proto'):
            self.jobs.put_item(Item={'pk': 'PROJECT#proj_example1', 'sk': f'JOB#{job_id}', 'status': 'completed'})
        steps = {row['step_id']: row for row in ps.get_steps(self.env.agents, self.plan_id)}
        if steps['s5']['status'] == ps.STEP_NEEDS_APPROVAL:
            _, shown = call(self.lambda_context, 'GET', f'/agents/plans/{self.plan_id}', claims=ADMIN)
            reviewed = next(step['pending'] for step in shown['plan']['steps'] if step['id'] == 's5')
            self.approve_status, _ = call(self.lambda_context, 'POST',
                                          f'/agents/plans/{self.plan_id}/steps/s5/approve', claims=ADMIN,
                                          body={'fingerprint': reviewed['fingerprint']})


@pytest.fixture
def cross_track(lambda_context) -> Iterator[CrossTrack]:
    with api() as env, patch.dict('os.environ', {'AGGREGATES_TABLE': AGGREGATES_TABLE, 'JOBS_TABLE': JOBS_TABLE,
                                                 'USER_POOL_ID': 'pool-1'}):
        jobs = _jobs_table(env.resource)
        cognito = FakeCognito(sub=ADMIN['sub'], groups=['admins', 'users'])
        background = Background(env, jobs, lambda_context)
        with patch('agents.plan_identity._cognito', return_value=cognito), \
                patch('agents.plan_waits.get_aggregates_table', return_value=env.aggregates), \
                patch('agents.plan_waits.get_jobs_table', return_value=jobs):
            status, body = call(lambda_context, 'POST', '/agents/plans', claims=ADMIN,
                                body={'plan': FIXTURE['plan'], 'conversation_id': 'conv-example'})
            assert status == 202, body
            plan_id = background.plan_id = body['plan_id']
            plan_step = RecordedPlanStep()
            finish = drive(PlanEnv(env.agents, env.aggregates, jobs, cognito, plan_step), plan_id, on_wait=background)
            yield CrossTrack(plan_id, plan_step, finish,
                             {row['step_id']: row['status'] for row in ps.get_steps(env.agents, plan_id)},
                             ps.get_meta(env.agents, plan_id) or {}, background.approve_status,
                             background.source_polls)


def test_the_example_plan_runs_to_completed_on_the_recorded_runner_answers(cross_track: CrossTrack):
    assert cross_track.finish['kind'] == 'finish'
    assert cross_track.meta['status'] == ps.PLAN_COMPLETED
    assert set(cross_track.statuses.values()) == {ps.STEP_DONE}


def test_every_conductor_event_is_one_the_runner_was_given_and_every_recorded_answer_is_used(cross_track: CrossTrack):
    assert cross_track.plan_step.mismatches == []
    assert [run for runs in cross_track.plan_step.queue.values() for run in runs] == []


def test_the_first_write_is_the_app_connector_with_exactly_the_planned_arguments(cross_track: CrossTrack):
    first = cross_track.plan_step.events[0]
    assert first['step']['write'] == {'tool': 'create_app_connector',
                                      'args': {'source': 'app_reviews_ios', 'app_id': '1234567890',
                                               'app_name': 'ExampleAir iOS'}}
    assert first['claims']['cognito:groups'] == 'admins,users'


def test_the_import_wait_polls_the_source_run_row_until_it_completes(cross_track: CrossTrack):
    assert cross_track.source_polls[:2] == ['running', 'completed']
    assert cross_track.statuses['s3'] == ps.STEP_DONE


def test_the_deviating_step_pauses_is_approved_through_the_route_and_resumes_with_the_paused_write(
        cross_track: CrossTrack):
    s5_events = [event for event in cross_track.plan_step.events if event['step']['id'] == 's5']
    paused = FIXTURE['runs'][3]['answer']['pending']
    assert cross_track.approve_status == 200
    assert [('approved_pending' in event) for event in s5_events] == [False, True]
    assert s5_events[1]['approved_pending'] == {key: paused[key] for key in ('tool', 'args', 'fingerprint')}


def test_the_plan_counts_the_runner_reported_model_calls(cross_track: CrossTrack):
    reported = sum(run['answer']['model_calls'] for run in FIXTURE['runs'])
    assert int(cross_track.meta.get('model_calls') or 0) == reported


# -- the needs_approval answer alone, through the recorder (fingerprints agree across languages) ------

def test_the_runner_fingerprint_of_a_paused_write_is_the_python_canonical_one():
    pending = FIXTURE['runs'][3]['answer']['pending']
    assert canonical_write_fingerprint(pending['tool'], pending['args']) == pending['fingerprint']


def test_the_recorder_stores_the_runner_paused_write_as_needs_approval():
    from agents.test.plan_fixtures import plan_env, plan_of
    with plan_env() as env:
        s5 = next(step for step in FIXTURE['plan']['steps'] if step['id'] == 's5')
        plan_id = env.create(plan_of(s5))
        env.plan_step.results['s5'] = FIXTURE['runs'][3]['answer']
        conduct({'action': 'plan_decide', 'plan_id': plan_id})
        run_steps(env, plan_id, ['s5'])
        row = env.steps(plan_id)['s5']
        assert row['status'] == ps.STEP_NEEDS_APPROVAL
        assert json.loads(row['pending_json'])['fingerprint'] == FIXTURE['runs'][3]['answer']['pending']['fingerprint']
