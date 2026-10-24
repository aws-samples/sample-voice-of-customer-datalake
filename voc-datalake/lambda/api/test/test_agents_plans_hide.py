"""DELETE /agents/plans/{plan_id} (api/agents_handler.py): remove a finished plan from its approver's list.

Never a delete: the plan stays readable by id and its slot accounting is untouched.
"""
from __future__ import annotations

import pytest
from agents_handler_fixtures import ADMIN, USER, api, call

from shared import plans_store as ps
from shared.test.plan_fixture_plans import active_slots, fixture_plan

OTHER = {'sub': 'other-sub', 'cognito:username': 'carol'}
MCP = {'sub': 'mcp:tok_1', 'cognito:username': 'bob', 'voc:acting_subject': 'user-sub'}

# Every case runs against the moto-backed API (the table the plan rows live in).
pytestmark = pytest.mark.usefixtures('env')


@pytest.fixture
def env():
    with api() as environment:
        yield environment


def _approved(lambda_context, *, claims=USER) -> str:
    status, body = call(lambda_context, 'POST', '/agents/plans', claims=claims, body={'plan': fixture_plan()})
    if status != 202:
        raise AssertionError(f'POST /agents/plans answered {status}: {body}')
    return body['plan_id']


def _finished(lambda_context, *, claims=USER) -> str:
    plan_id = _approved(lambda_context, claims=claims)
    assert call(lambda_context, 'POST', f'/agents/plans/{plan_id}/cancel', claims=claims)[0] == 200
    return plan_id


def _listed(lambda_context, claims=USER) -> list[str]:
    return [p['plan_id'] for p in call(lambda_context, 'GET', '/agents/plans', claims=claims)[1]['plans']]


def _remove(lambda_context, plan_id: str, claims=USER) -> tuple[int, dict]:
    return call(lambda_context, 'DELETE', f'/agents/plans/{plan_id}', claims=claims)


def test_removing_a_finished_plan_takes_it_off_the_list_and_keeps_it(env, lambda_context):
    kept, removed = _finished(lambda_context), _finished(lambda_context)
    status, body = _remove(lambda_context, removed)
    assert (status, body['plan']['plan_id'], body['plan']['status']) == (200, removed, 'cancelled')
    assert _listed(lambda_context) == [kept]
    meta = ps.get_meta(env.agents, removed) or {}
    assert (meta.get('hidden_by'), 'gsi1pk' in meta, bool(meta.get('hidden_at'))) == ('user-sub', False, True)
    assert len(ps.get_steps(env.agents, removed)) == len(fixture_plan()['steps'])
    assert call(lambda_context, 'GET', f'/agents/plans/{removed}')[0] == 200


def test_an_active_plan_is_409_and_stays_listed(lambda_context):
    plan_id = _approved(lambda_context)
    status, body = _remove(lambda_context, plan_id)
    assert (status, body['error']) == (409, 'This plan is still running; cancel it first')
    assert _listed(lambda_context) == [plan_id]


def test_removing_twice_is_a_no_op(lambda_context):
    plan_id = _finished(lambda_context)
    assert _remove(lambda_context, plan_id)[0] == 200
    assert _remove(lambda_context, plan_id)[0] == 200
    assert _listed(lambda_context) == []


def test_removing_a_finished_plan_does_not_change_the_active_plan_cap(env, lambda_context):
    _approved(lambda_context)
    plan_id = _finished(lambda_context)
    before = active_slots(env.agents, 'user-sub')
    assert _remove(lambda_context, plan_id)[0] == 200
    assert active_slots(env.agents, 'user-sub') == before == 1


def test_another_user_gets_404_and_an_admin_may_remove_it(lambda_context):
    plan_id = _finished(lambda_context)
    assert _remove(lambda_context, plan_id, claims=OTHER)[0] == 404
    assert _remove(lambda_context, plan_id, claims=ADMIN)[0] == 200
    assert _listed(lambda_context) == []


def test_a_delegated_credential_cannot_remove_a_plan(lambda_context):
    plan_id = _finished(lambda_context)
    assert _remove(lambda_context, plan_id, claims=MCP)[0] == 403
    assert _listed(lambda_context) == [plan_id]


@pytest.mark.parametrize('plan_id', ['pl_000000000000', 'not-a-plan'])
def test_an_unknown_or_malformed_plan_is_404(lambda_context, plan_id):
    assert _remove(lambda_context, plan_id)[0] == 404


def test_deleting_an_agent_still_reaches_the_agent_route(lambda_context):
    """DELETE /agents/<agent_id> (archive) answers beside DELETE /agents/plans/<plan_id>."""
    status, _ = call(lambda_context, 'DELETE', '/agents/ag_000000000000', claims=ADMIN)
    assert status == 404
