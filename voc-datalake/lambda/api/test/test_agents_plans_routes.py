"""/agents/plans* (api/agents_handler.py): approve, read, list, cancel, resolve a paused step."""
from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, USER, api, call
from botocore.exceptions import ClientError

from shared import agents_store
from shared import plans_store as ps
from shared.test.plan_fixture_plans import active_slots, fixture_plan

OTHER = {'sub': 'other-sub', 'cognito:username': 'carol'}
MCP = {'sub': 'mcp:tok_1', 'cognito:username': 'bob', 'voc:acting_subject': 'user-sub'}
SEEN = 'a' * 64




@pytest.fixture
def env():
    with api() as environment:
        yield environment


def _approve(lambda_context, *, claims=USER, plan=None, **body) -> tuple[int, dict]:
    return call(lambda_context, 'POST', '/agents/plans', claims=claims,
                body={'plan': plan or fixture_plan(), **body})


def _approved(lambda_context, **kwargs) -> str:
    status, body = _approve(lambda_context, **kwargs)
    if status != 202:
        raise AssertionError(f'POST /agents/plans answered {status}: {body}')
    return body['plan_id']


def _pause(env, plan_id: str, step_id: str = 's1') -> None:
    ps.update_meta(env.agents, plan_id, ps.Change({'status': ps.PLAN_RUNNING}, (ps.PLAN_APPROVED,)),
                   now=agents_store.utc_now())
    pending = {'tool': 'create_project', 'args': {'name': 'Other'}, 'fingerprint': SEEN, 'reason': 'changed'}
    ps.update_step(env.agents, plan_id, step_id, ps.Change(
        {'status': ps.STEP_NEEDS_APPROVAL, 'pending_json': json.dumps(pending), 'pending_fingerprint': SEEN},
        (ps.STEP_PENDING,)), now=agents_store.utc_now())


def _approve_step(lambda_context, plan_id: str, step_id: str = 's1', *, claims=USER, **body) -> tuple[int, dict]:
    return call(lambda_context, 'POST', f'/agents/plans/{plan_id}/steps/{step_id}/approve', claims=claims,
                body={'fingerprint': SEEN, **body})


# -- POST /agents/plans ------------------------------------------------------------------------------

def test_approve_answers_202_and_starts_the_plan_execution_named_after_it(env, lambda_context):
    status, body = _approve(lambda_context, conversation_id='conv-1')
    kwargs = env.sfn.start_execution.call_args.kwargs
    assert (status, body['status']) == (202, 'approved')
    assert kwargs['name'] == body['plan_id']
    assert json.loads(kwargs['input']) == {'run_kind': 'plan', 'plan_id': body['plan_id']}


def test_approve_stores_the_caller_as_approver(env, lambda_context):
    plan_id = _approved(lambda_context)
    meta = ps.get_meta(env.agents, plan_id) or {}
    assert (meta.get('approver_sub'), meta.get('approver_username')) == ('user-sub', 'bob')


def test_an_invalid_plan_is_400_with_the_step_and_field(env, lambda_context):
    plan = fixture_plan()
    plan['steps'][1]['after'] = ['s9']
    status, body = _approve(lambda_context, plan=plan)
    assert status == 400
    assert body['success'] is False
    assert {'step': 's2', 'field': 'after', 'message': 'unknown step s9'} in body['errors']
    env.sfn.start_execution.assert_not_called()


@pytest.mark.usefixtures('env')
def test_an_admin_pack_is_refused_for_a_user_and_accepted_for_an_admin(lambda_context):
    plan = fixture_plan('valid-example')
    assert _approve(lambda_context, plan=plan)[0] == 400
    assert _approve(lambda_context, plan=plan, claims=ADMIN)[0] == 202


@pytest.mark.usefixtures('env')
def test_a_delegated_credential_cannot_approve_a_plan(lambda_context):
    status, _ = _approve(lambda_context, claims=MCP)
    assert status == 403


AGENT = {'sub': 'agent:ag_000000000001', 'voc:acting_subject': 'user-sub', 'voc:agent_owner_sub': 'user-sub'}


@pytest.mark.parametrize('delegated', [MCP, AGENT], ids=['mcp-token', 'agent'])
def test_a_delegated_credential_of_the_approver_cannot_read_list_cancel_or_resolve_the_plan(env, lambda_context,
                                                                                          delegated):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    assert call(lambda_context, 'GET', f'/agents/plans/{plan_id}', claims=delegated)[0] == 403
    assert call(lambda_context, 'GET', '/agents/plans', claims=delegated)[0] == 403
    assert call(lambda_context, 'POST', f'/agents/plans/{plan_id}/cancel', claims=delegated)[0] == 403
    assert _approve_step(lambda_context, plan_id, claims=delegated)[0] == 403


@pytest.mark.usefixtures('env')
def test_a_malformed_conversation_id_is_400(lambda_context):
    assert _approve(lambda_context, conversation_id='../x')[0] == 400


@pytest.mark.usefixtures('env')
def test_a_fourth_active_plan_is_409(lambda_context):
    for _ in range(3):
        _approved(lambda_context)
    assert _approve(lambda_context)[0] == 409


@pytest.mark.usefixtures('env')
def test_cancelling_one_of_three_active_plans_frees_a_slot(lambda_context):
    first, *_ = [_approved(lambda_context) for _ in range(3)]
    assert call(lambda_context, 'POST', f'/agents/plans/{first}/cancel', claims=USER)[0] == 200
    assert _approve(lambda_context)[0] == 202


def test_a_failed_start_gives_its_slot_back(env, lambda_context):
    env.sfn.start_execution.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'StartExecution')
    _approve(lambda_context)
    assert active_slots(env.agents, 'user-sub') == 0


def test_a_failed_start_fails_the_plan(env, lambda_context):
    env.sfn.start_execution.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'StartExecution')
    status, _ = _approve(lambda_context)
    plans = ps.list_plans(env.agents, 'user-sub', limit=5)
    assert status == 500
    assert [row['status'] for row in plans] == [ps.PLAN_FAILED]


def test_approve_without_a_runtime_is_a_configuration_error(lambda_context):
    with api(with_state_machine=False):
        assert _approve(lambda_context)[0] == 500


# -- GET ----------------------------------------------------------------------------------------------

@pytest.mark.usefixtures('env')
def test_the_approver_reads_the_plan_view(lambda_context):
    plan_id = _approved(lambda_context)
    status, body = call(lambda_context, 'GET', f'/agents/plans/{plan_id}', claims=USER)
    assert status == 200
    assert [step['id'] for step in body['plan']['steps']] == ['s1', 's2']
    assert 'approver_sub' not in body['plan']


@pytest.mark.usefixtures('env')
def test_an_admin_reads_any_plan_and_another_user_gets_404(lambda_context):
    plan_id = _approved(lambda_context)
    assert call(lambda_context, 'GET', f'/agents/plans/{plan_id}', claims=ADMIN)[0] == 200
    assert call(lambda_context, 'GET', f'/agents/plans/{plan_id}', claims=OTHER)[0] == 404
    assert call(lambda_context, 'GET', '/agents/plans/pl_000000000000', claims=USER)[0] == 404


@pytest.mark.usefixtures('env')
def test_list_returns_only_the_callers_plans_newest_first(lambda_context):
    first = _approved(lambda_context)
    _approved(lambda_context, claims=OTHER)
    status, body = call(lambda_context, 'GET', '/agents/plans', claims=USER, query={'limit': '5'})
    assert status == 200
    assert [row['plan_id'] for row in body['plans']] == [first]


@pytest.mark.usefixtures('env')
def test_reading_a_plan_that_never_started_in_24_hours_shows_it_expired(lambda_context):
    plan_id = _approved(lambda_context)
    later = agents_store.utc_now() + timedelta(hours=25)
    with patch.object(agents_store, 'utc_now', return_value=later):
        _, body = call(lambda_context, 'GET', f'/agents/plans/{plan_id}', claims=USER)
    assert body['plan']['status'] == ps.PLAN_EXPIRED


# -- cancel -------------------------------------------------------------------------------------------

@pytest.mark.usefixtures('env')
def test_the_approver_cancels_and_a_second_cancel_is_409(lambda_context):
    plan_id = _approved(lambda_context)
    status, body = call(lambda_context, 'POST', f'/agents/plans/{plan_id}/cancel', claims=USER)
    assert (status, body['plan']['status']) == (200, ps.PLAN_CANCELLED)
    assert {step['status'] for step in body['plan']['steps']} == {ps.STEP_CANCELLED}
    assert call(lambda_context, 'POST', f'/agents/plans/{plan_id}/cancel', claims=USER)[0] == 409


@pytest.mark.usefixtures('env')
def test_an_admin_may_cancel_another_users_plan_but_a_user_may_not(lambda_context):
    plan_id = _approved(lambda_context)
    assert call(lambda_context, 'POST', f'/agents/plans/{plan_id}/cancel', claims=OTHER)[0] == 404
    assert call(lambda_context, 'POST', f'/agents/plans/{plan_id}/cancel', claims=ADMIN)[0] == 200


# -- approve / decline a paused step --------------------------------------------------------------------

def test_the_approver_approves_a_paused_step(env, lambda_context):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    status, body = _approve_step(lambda_context, plan_id)
    step = (ps.get_step(env.agents, plan_id, 's1') or {})
    assert (status, body['plan']['steps'][0]['status']) == (200, ps.STEP_PENDING)
    assert json.loads(step['approved_pending_json'])['args'] == {'name': 'Other'}


def test_the_approver_declines_a_paused_step(env, lambda_context):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    _, body = call(lambda_context, 'POST', f'/agents/plans/{plan_id}/steps/s1/decline', claims=USER)
    assert body['plan']['steps'][0]['status'] == ps.STEP_FAILED
    assert body['plan']['steps'][0]['error'] == ps.DECLINED_ERROR


def test_resolving_a_step_that_is_not_paused_is_409(env, lambda_context):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    assert _approve_step(lambda_context, plan_id, 's2')[0] == 409


def test_the_paused_step_view_carries_the_fingerprint_the_approve_must_send_back(env, lambda_context):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    _, body = call(lambda_context, 'GET', f'/agents/plans/{plan_id}', claims=USER)
    assert body['plan']['steps'][0]['pending']['fingerprint'] == SEEN


def test_approving_without_the_reviewed_fingerprint_is_400(env, lambda_context):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    status, _ = call(lambda_context, 'POST', f'/agents/plans/{plan_id}/steps/s1/approve', claims=USER)
    assert status == 400
    assert _approve_step(lambda_context, plan_id, fingerprint='A' * 64)[0] == 400
    assert (ps.get_step(env.agents, plan_id, 's1') or {})['status'] == ps.STEP_NEEDS_APPROVAL


def test_a_stale_card_is_409_and_leaves_the_new_paused_write_untouched(env, lambda_context):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    status, body = _approve_step(lambda_context, plan_id, fingerprint='b' * 64)
    step = ps.get_step(env.agents, plan_id, 's1') or {}
    assert (status, body['error']) == (409, ps.STEP_CHANGED_ERROR)
    assert (step['status'], 'approved_pending_json' in step) == (ps.STEP_NEEDS_APPROVAL, False)


def test_an_admin_who_is_not_the_approver_cannot_resolve_a_step(env, lambda_context):
    plan_id = _approved(lambda_context)
    _pause(env, plan_id)
    assert _approve_step(lambda_context, plan_id, claims=ADMIN)[0] == 403
    assert _approve_step(lambda_context, plan_id, claims=OTHER)[0] == 404


def test_resolving_an_unknown_step_is_404_and_a_plan_not_running_is_409(env, lambda_context):
    plan_id = _approved(lambda_context)
    assert _approve_step(lambda_context, plan_id)[0] == 409
    _pause(env, plan_id)
    assert _approve_step(lambda_context, plan_id, 's7')[0] == 404


@pytest.mark.usefixtures('env')
def test_the_agent_routes_still_answer_beside_the_plan_routes(lambda_context):
    assert call(lambda_context, 'GET', '/agents', claims=USER)[0] == 200
    assert call(lambda_context, 'GET', '/agents/ag_000000000000', claims=USER)[0] == 404
