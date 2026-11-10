"""shared/plans_store.py: the plan rows, their conditional transitions and their views (moto)."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from shared import plans_store as ps
from shared.plan_schema import is_plan_id
from shared.test.agents_fixtures import agents_env
from shared.test.plan_fixture_plans import active_slots, fixture_plan

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
APPROVER = ps.Approver(sub='user-sub', username='bob')



@pytest.fixture
def table():
    with agents_env() as env:
        yield env.agents


def _create(table, **kwargs) -> dict:
    return ps.create_plan(table, fixture_plan(), approver=APPROVER, conversation_id=kwargs.get('conversation_id'),
                          now=kwargs.get('now', NOW))


def test_create_plan_stores_meta_with_fingerprint_and_one_row_per_step(table):
    meta = _create(table)
    steps = ps.get_steps(table, meta['plan_id'])
    assert is_plan_id(meta['plan_id'])
    assert meta['fingerprint'] == ps.plan_fingerprint(fixture_plan())
    assert [(s['step_id'], s['status']) for s in steps] == [('s1', 'pending'), ('s2', 'pending')]
    assert ps.stored_plan(ps.get_meta(table, meta['plan_id']) or {}) == fixture_plan()


def test_create_plan_indexes_the_plan_under_its_approver(table):
    first = _create(table)
    second = _create(table, now=NOW + timedelta(minutes=1))
    listed = ps.list_plans(table, APPROVER.sub, limit=10)
    assert [row['plan_id'] for row in listed] == [second['plan_id'], first['plan_id']]
    assert ps.list_plans(table, 'someone-else', limit=10) == []


def test_steps_come_back_in_plan_order_even_past_s9(table):
    plan = fixture_plan('valid-example')
    meta = ps.create_plan(table, plan, approver=APPROVER, conversation_id=None, now=NOW)
    ids = [row['step_id'] for row in ps.get_steps(table, meta['plan_id'])]
    assert ids == [step['id'] for step in plan['steps']]


def test_view_never_carries_the_approver_identity(table):
    meta = _create(table, conversation_id='conv-1')
    view = ps.plan_view(ps.get_meta(table, meta['plan_id']) or {}, ps.get_steps(table, meta['plan_id']))
    text = json.dumps(view)
    assert 'user-sub' not in text
    assert 'bob' not in text
    assert view['conversation_id'] == 'conv-1'


def test_cancel_closes_open_steps_and_refuses_a_second_cancel(table):
    meta = _create(table)
    ps.update_step(table, meta['plan_id'], 's1', ps.Change({'status': ps.STEP_RUNNING}, (ps.STEP_PENDING,)), now=NOW)
    cancelled = ps.cancel_plan(table, meta['plan_id'], now=NOW)
    statuses = [row['status'] for row in ps.get_steps(table, meta['plan_id'])]
    assert (cancelled or {}).get('status') == ps.PLAN_CANCELLED
    assert statuses == [ps.STEP_RUNNING, ps.STEP_CANCELLED]
    assert ps.cancel_plan(table, meta['plan_id'], now=NOW) is None


def test_hide_plan_takes_a_finished_plan_off_the_index_and_keeps_its_rows(table):
    plan_id = _create(table)['plan_id']
    ps.cancel_plan(table, plan_id, now=NOW)
    hidden = ps.hide_plan(table, plan_id, hidden_by='user-sub', now=NOW) or {}
    assert (hidden.get('hidden_by'), hidden.get('hidden_at'), 'gsi1pk' in hidden, 'gsi1sk' in hidden) == (
        'user-sub', ps.iso(NOW), False, False)
    assert ps.list_plans(table, 'user-sub', limit=10) == []
    assert len(ps.get_steps(table, plan_id)) == len(fixture_plan()['steps'])


def test_hide_plan_refuses_an_active_or_missing_plan(table):
    plan_id = _create(table)['plan_id']
    assert ps.hide_plan(table, plan_id, hidden_by='user-sub', now=NOW) is None
    assert [row['plan_id'] for row in ps.list_plans(table, 'user-sub', limit=10)] == [plan_id]
    assert ps.hide_plan(table, 'pl_000000000000', hidden_by='user-sub', now=NOW) is None


def test_hiding_twice_keeps_the_first_who_and_when(table):
    plan_id = _create(table)['plan_id']
    ps.cancel_plan(table, plan_id, now=NOW)
    ps.hide_plan(table, plan_id, hidden_by='user-sub', now=NOW)
    again = ps.hide_plan(table, plan_id, hidden_by='admin-sub', now=NOW + timedelta(hours=1)) or {}
    assert (again.get('hidden_by'), again.get('hidden_at')) == ('user-sub', ps.iso(NOW))


SEEN = 'f' * 64



def _pause(table, plan_id: str) -> None:
    pending = {'tool': 'create_project', 'args': {'name': 'Other'}, 'fingerprint': SEEN, 'reason': 'mismatch'}
    ps.update_step(table, plan_id, 's1', ps.Change(
        {'status': ps.STEP_NEEDS_APPROVAL, 'pending_json': json.dumps(pending), 'pending_fingerprint': SEEN},
        (ps.STEP_PENDING,)), now=NOW)


def test_approve_moves_the_pending_write_to_approved_and_back_to_pending(table):
    meta = _create(table)
    _pause(table, meta['plan_id'])
    approved = ps.approve_step(table, meta['plan_id'], 's1', fingerprint=SEEN, now=NOW)
    assert (approved or {}).get('status') == ps.STEP_PENDING
    assert json.loads((approved or {})['approved_pending_json'])['args'] == {'name': 'Other'}
    assert not {'pending_json', 'pending_fingerprint'} & set(approved or {})


def test_approve_with_another_fingerprint_raises_step_changed_and_writes_nothing(table):
    meta = _create(table)
    _pause(table, meta['plan_id'])
    with pytest.raises(ps.StepChanged):
        ps.approve_step(table, meta['plan_id'], 's1', fingerprint='e' * 64, now=NOW)
    assert (ps.get_step(table, meta['plan_id'], 's1') or {})['status'] == ps.STEP_NEEDS_APPROVAL


def test_approve_is_conditional_on_the_fingerprint_it_read(table):
    """The write is replaced between the read and the update: the conditional update refuses it."""
    meta = _create(table)
    _pause(table, meta['plan_id'])
    stale = ps.get_step(table, meta['plan_id'], 's1')
    ps.update_step(table, meta['plan_id'], 's1', ps.Change({'pending_fingerprint': 'e' * 64},
                                                            (ps.STEP_NEEDS_APPROVAL,)), now=NOW)
    with patch.object(ps, 'get_step', side_effect=[stale, ps.get_step(table, meta['plan_id'], 's1')]), \
            pytest.raises(ps.StepChanged):
        ps.approve_step(table, meta['plan_id'], 's1', fingerprint=SEEN, now=NOW)


def test_approve_refuses_a_step_that_is_not_paused(table):
    meta = _create(table)
    assert ps.approve_step(table, meta['plan_id'], 's1', fingerprint=SEEN, now=NOW) is None
    assert ps.decline_step(table, meta['plan_id'], 's1', now=NOW) is None


def test_decline_fails_the_step_with_the_decline_reason(table):
    meta = _create(table)
    _pause(table, meta['plan_id'])
    declined = ps.decline_step(table, meta['plan_id'], 's1', now=NOW)
    assert (declined or {}).get('status') == ps.STEP_FAILED
    assert (declined or {}).get('error') == ps.DECLINED_ERROR


def test_paused_step_view_shows_the_pending_write_with_its_fingerprint(table):
    meta = _create(table)
    _pause(table, meta['plan_id'])
    view = ps.step_view(ps.get_steps(table, meta['plan_id'])[0])
    assert view['pending'] == {'tool': 'create_project', 'args': {'name': 'Other'}, 'reason': 'mismatch',
                               'fingerprint': SEEN}


def test_an_approved_plan_older_than_24_hours_expires(table):
    meta = _create(table)
    expired = ps.expire_if_stale(table, meta, now=NOW + timedelta(hours=25))
    assert expired['status'] == ps.PLAN_EXPIRED
    assert {row['status'] for row in ps.get_steps(table, meta['plan_id'])} == {ps.STEP_CANCELLED}


def test_a_fresh_or_running_plan_does_not_expire(table):
    meta = _create(table)
    assert ps.expire_if_stale(table, meta, now=NOW + timedelta(hours=23))['status'] == ps.PLAN_APPROVED
    running = ps.update_meta(table, meta['plan_id'], ps.Change({'status': ps.PLAN_RUNNING}, (ps.PLAN_APPROVED,)),
                             now=NOW)
    assert running is not None
    assert ps.expire_if_stale(table, running, now=NOW + timedelta(hours=30))['status'] == ps.PLAN_RUNNING


def test_events_get_increasing_sequence_numbers(table):
    meta = _create(table)
    ps.append_event(table, meta['plan_id'], 'step_started', 'Create the project', now=NOW, step_id='s1')
    ps.append_event(table, meta['plan_id'], 'step_finished', 'done', now=NOW, step_id='s1')
    rows = table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :e)',
                       ExpressionAttributeValues={':pk': f"PLAN#{meta['plan_id']}", ':e': 'EVT#'})['Items']
    assert [int(row['seq']) for row in rows] == [1, 2]


# -- the active-plan cap (atomic counter) -------------------------------------------------------------

def test_each_created_plan_takes_one_slot_and_a_fourth_is_refused(table):
    for _ in range(ps.MAX_ACTIVE_PLANS):
        _create(table)
    with pytest.raises(ps.PlanCapReached):
        _create(table)
    assert active_slots(table, APPROVER.sub) == ps.MAX_ACTIVE_PLANS
    assert len(ps.list_plans(table, APPROVER.sub, limit=10)) == ps.MAX_ACTIVE_PLANS


def test_a_concurrent_create_that_took_the_last_slot_first_refuses_this_one(table):
    """The race, without threads: two other approvals incremented the counter before this create ran."""
    _create(table)
    table.update_item(Key=ps.cap_key(APPROVER.sub), UpdateExpression='ADD active :two',
                      ExpressionAttributeValues={':two': 2})
    with pytest.raises(ps.PlanCapReached):
        _create(table)
    assert len(ps.list_plans(table, APPROVER.sub, limit=10)) == 1


@pytest.mark.parametrize('end', ['cancel', 'finish', 'expire'])
def test_every_terminal_transition_gives_the_slot_back_once(table, end):
    meta = _create(table)
    plan_id = meta['plan_id']
    if end == 'cancel':
        ps.cancel_plan(table, plan_id, now=NOW)
    elif end == 'finish':
        ps.finish_plan(table, plan_id, ps.PLAN_COMPLETED, now=NOW, summary='done')
    else:
        ps.expire_if_stale(table, meta, now=NOW + timedelta(hours=25))
    assert ps.finish_plan(table, plan_id, ps.PLAN_FAILED, now=NOW, summary='again') is None
    assert active_slots(table, APPROVER.sub) == 0
    assert 'holds_slot' not in (ps.get_meta(table, plan_id) or {})


def test_a_plan_without_a_slot_finishes_without_touching_the_counter(table):
    meta = _create(table)
    ps.update_meta(table, meta['plan_id'], ps.Change({}, ps.ACTIVE_PLAN_STATUSES, remove=('holds_slot',)), now=NOW)
    assert (ps.finish_plan(table, meta['plan_id'], ps.PLAN_COMPLETED, now=NOW, summary='done') or {})['status'] \
        == ps.PLAN_COMPLETED
    assert active_slots(table, APPROVER.sub) == 1
