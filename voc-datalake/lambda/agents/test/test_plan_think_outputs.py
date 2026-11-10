"""A think step's result is stored, shown and summarised; an empty one is not a success.

Regression for plan ``pl_459311708a4e`` (5.09.00): two read-only think steps without ``produces`` ran,
voc-plan-step answered ``done`` with ``{"summary": <text>}``, and the conductor kept only the outputs the
step declared, so both rows were stored ``done`` with ``outputs: {}`` and the plan read "2 of 2 steps done."
"""
from __future__ import annotations

from collections.abc import Iterator

import pytest

from agents.conductor.plan_decide import SUMMARY_EXCERPT_CHARS
from agents.conductor.plan_execution import EMPTY_THINK_ERROR
from agents.test.plan_fixtures import PlanEnv, drive, plan_env, plan_of, think_step
from shared import plans_store as ps
from shared.plan_schema import THINK_DEFAULT_OUTPUT

RESULT = '## Top problems\n\n1. Late refunds (12 reviews)\n2. App crashes on login (7 reviews)'


@pytest.fixture
def env() -> Iterator[PlanEnv]:
    with plan_env() as environment:
        yield environment


def _answer(text: str) -> dict:
    return {'status': 'done', 'outputs': {THINK_DEFAULT_OUTPUT: text}, 'model_calls': 2}


def _run(env: PlanEnv, *answers: str) -> str:
    steps = [think_step(f's{index}') for index in range(1, len(answers) + 1)]
    env.plan_step.results.update({step['id']: _answer(text) for step, text in zip(steps, answers, strict=True)})
    plan_id = env.create(plan_of(*steps))
    drive(env, plan_id)
    return plan_id


def test_a_think_step_without_produces_stores_its_result(env: PlanEnv):
    plan_id = _run(env, RESULT, 'Second result.')
    assert {sid: row['outputs'] for sid, row in env.steps(plan_id).items()} == {
        's1': {THINK_DEFAULT_OUTPUT: RESULT}, 's2': {THINK_DEFAULT_OUTPUT: 'Second result.'}}
    assert env.meta(plan_id)['status'] == ps.PLAN_COMPLETED


def test_the_stored_result_is_redacted_and_bounded(env: PlanEnv):
    plan_id = _run(env, 'Contact someone@example.com or +1 415 555 0100. ' + 'x' * ps.MAX_STORED_OUTPUT_CHARS)
    stored = env.steps(plan_id)['s1']['outputs'][THINK_DEFAULT_OUTPUT]
    assert stored.startswith('Contact [redacted] or [redacted]. x')
    assert len(stored) == ps.MAX_STORED_OUTPUT_CHARS


@pytest.mark.parametrize('blank', ['', '   \n '])
def test_a_think_step_that_produced_nothing_fails_with_a_reason(env: PlanEnv, blank: str):
    plan_id = _run(env, RESULT, blank)
    row = env.steps(plan_id)['s2']
    assert (row['status'], row['error'], row['outputs']) == (ps.STEP_FAILED, EMPTY_THINK_ERROR, {})
    meta = env.meta(plan_id)
    assert (meta['status'], meta['summary'].splitlines()[0]) == (ps.PLAN_COMPLETED_WITH_ERRORS, '1 of 2 steps done.')


def test_the_plan_summary_opens_each_result(env: PlanEnv):
    plan_id = _run(env, RESULT, 'y' * 300)
    assert env.meta(plan_id)['summary'].splitlines() == [
        '2 of 2 steps done.',
        's1 (Analyse s1): ## Top problems 1. Late refunds (12 reviews) 2. App crashes on login (7 reviews)',
        f"s2 (Analyse s2): {'y' * SUMMARY_EXCERPT_CHARS}...",
    ]


def test_the_plan_view_carries_the_full_result_but_ids_stay_short(env: PlanEnv):
    long_result = 'r' * 3000
    plan_id = _run(env, long_result)
    view = ps.plan_view(env.meta(plan_id), ps.get_steps(env.agents, plan_id))
    assert view['steps'][0]['outputs'] == {THINK_DEFAULT_OUTPUT: long_result}
    write_row = {'step_id': 's9', 'kind': 'write', 'outputs': {'project_id': 'p' * 600}}
    assert ps.step_view(write_row)['outputs'] == {'project_id': 'p' * ps.MAX_VIEW_OUTPUT_CHARS}
