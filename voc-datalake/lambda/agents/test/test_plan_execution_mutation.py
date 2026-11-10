"""Mutation hardening for `agents/conductor/plan_execution.py` (``plan_prepare`` / ``plan_record``).

`test_plan_conductor.py` drives whole plans through the scripted plan-step runner and asserts how they
END. A mutation run found what those runs cannot see, pinned here one call at a time on a frozen clock:

* WHAT A STEP ROW HOLDS after each answer: ``started_at`` / ``finished_at`` stamps, the bounded and
  JSON-encoded ``outputs`` (only the declared names), a fingerprint kept only when it is 64 lowercase hex,
  the paused write exactly as encoded (``pending_json`` / ``pending_fingerprint`` / ``pending_since``,
  the previous approval removed) and the status each write is conditional on;
* THE BOUNDS: ``model_calls`` 0..100 (a bool, a string or 101 falls back to the step's own count), a
  paused write of exactly 32,000 encoded characters (and one more), a tool name of 64 characters (and 65),
  an internal error name cut at 100 characters, a paused-write reason at 500;
* EVERY REFUSAL'S WORDS and the journal rows (``step_started`` / ``step_failed`` / ``step_finished`` /
  ``step_needs_approval``, with the step id and the title — or the step id when the title is empty);
* the ``approved_pending`` the runner receives (tool, args, fingerprint — never the reason).
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import ANY, MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key

from agents import plan_identity
from agents.conductor import plan_execution, plan_state
from agents.conductor.plan_state import PlanState
from agents.test.plan_fixtures import APPROVER, PlanEnv, conduct, plan_env, plan_of, write_step
from shared import agents_store
from shared import plans_store as ps
from shared.plan_canonical import canonical_write_fingerprint

T0 = datetime(2026, 4, 1, 10, 0, tzinfo=UTC)
STAMP = agents_store.iso(T0)
EVERY_STATUS = (ps.STEP_PENDING, ps.STEP_RUNNING, ps.STEP_WAITING, ps.STEP_NEEDS_APPROVAL, ps.STEP_DONE,
                ps.STEP_FAILED, ps.STEP_SKIPPED, ps.STEP_CANCELLED)
HEX = 'ab' * 32
UNVERIFIED = 'The paused write could not be verified.'


@pytest.fixture
def env() -> Iterator[PlanEnv]:
    with plan_env() as environment, patch.object(agents_store, 'utc_now', return_value=T0):
        yield environment


def _journal(env: PlanEnv, plan_id: str) -> list[tuple[str, str, str | None]]:
    """The plan's journal rows after the decide's own ``plan_running`` row."""
    page = env.agents.query(KeyConditionExpression=Key('pk').eq(f'PLAN#{plan_id}') & Key('sk').begins_with('EVT#'))
    rows = [(str(item['kind']), str(item['summary']), item.get('step_id')) for item in page['Items']]
    return [row for row in rows if row[0] != 'plan_running']


def _running(env: PlanEnv, *steps: dict) -> str:
    """A plan whose first decide has run (the plan is ``running``, its ready steps still pending)."""
    plan_id = env.create(plan_of(*steps), now=T0)
    conduct({'action': 'plan_decide', 'plan_id': plan_id})
    return plan_id


def _set(env: PlanEnv, plan_id: str, step_id: str, sets: dict[str, Any]) -> None:
    assert ps.update_step(env.agents, plan_id, step_id, ps.Change(sets, EVERY_STATUS), now=T0) is not None


def _claimed(env: PlanEnv, *steps: dict) -> str:
    """A running plan whose step s1 has been prepared (claimed, ``running``)."""
    plan_id = _running(env, *steps)
    assert plan_execution.prepare(plan_id, 's1')['run'] is True
    return plan_id


def _create(step_id: str = 's1', name: str = 'A', **extra: Any) -> dict:
    return write_step(step_id, 'create_project', {'name': name}, **extra)


def _free(step_id: str = 's1') -> dict:
    return write_step(step_id, 'update_project', {'project_id': 'p1', 'description': '{{free}}'}, pack='project')


def _state(*, plan_status: str = ps.PLAN_RUNNING, kind: str | None = 'write', status: str = ps.STEP_PENDING,
           dependency: str | None = None) -> PlanState:
    rows: dict[str, dict] = {'s1': {'status': status}}
    definitions: dict[str, dict] = {}
    if kind is not None:
        definitions['s1'] = {'id': 's1', 'kind': kind, **({'after': ['s0']} if dependency else {})}
    if dependency:
        rows['s0'] = {'status': dependency}
    return PlanState(meta={'plan_id': 'pl_000000000001', 'status': plan_status}, rows=rows,
                     definitions=definitions, order=list(rows), now=T0)


# --------------------------------------------------------------------------
# prepare
# --------------------------------------------------------------------------

class TestOnlyAPendingWriteOrThinkStepOfARunningPlanIsRunnable:
    @pytest.mark.parametrize(('state', 'runnable'), [
        (_state(), True),
        (_state(kind='think'), True),
        (_state(dependency=ps.STEP_DONE), True),
        (_state(kind='wait'), False),
        (_state(kind=None), False),
        (_state(status=ps.STEP_RUNNING), False),
        (_state(dependency=ps.STEP_RUNNING), False),
        (_state(plan_status=ps.PLAN_APPROVED), False),
        (None, False),
    ])
    def test_runnable(self, state: PlanState | None, runnable: bool):
        assert plan_execution._runnable(state, 's1') is runnable

    def test_a_plan_not_yet_running_runs_nothing_and_writes_nothing(self, env: PlanEnv):
        plan_id = env.create(plan_of(_create()), now=T0)
        assert plan_execution.prepare(plan_id, 's1') == {'run': False}
        assert env.statuses(plan_id) == {'s1': ps.STEP_PENDING}
        assert _journal(env, plan_id) == []

    def test_an_unknown_plan_runs_nothing(self, env: PlanEnv):
        assert plan_execution.prepare('pl_000000000000', 's1') == {'run': False}
        assert env.cognito.calls == []


class TestPrepareClaimsTheStep:
    def test_the_event_the_runner_receives_and_the_claimed_row(self, env: PlanEnv):
        plan_id = _running(env, _create(produces=['project_id']))
        prepared = plan_execution.prepare(plan_id, 's1')
        assert prepared == {'run': True, 'event': {
            'plan_id': plan_id, 'step': _create(produces=['project_id']), 'resolved': {}, 'think_outputs': {},
            'claims': {'sub': APPROVER.sub, 'cognito:username': APPROVER.username, 'cognito:groups': 'users',
                       'voc:acting_subject': APPROVER.sub, 'voc:principal': f'plan:{plan_id}'}}}
        row = env.steps(plan_id)['s1']
        assert (row['status'], row['started_at'], row['updated_at']) == (ps.STEP_RUNNING, STAMP, STAMP)
        assert _journal(env, plan_id) == [('step_started', 'Run create_project', 's1')]

    def test_a_step_without_a_title_is_journalled_by_its_id(self, env: PlanEnv):
        plan_id = _running(env, _create() | {'title': ''})
        plan_execution.prepare(plan_id, 's1')
        assert _journal(env, plan_id) == [('step_started', 's1', 's1')]

    def test_the_claim_is_conditional_on_pending_and_a_lost_claim_runs_nothing(self, env: PlanEnv):
        plan_id = _running(env, _create())
        with patch.object(ps, 'update_step', return_value=None) as update:
            assert plan_execution.prepare(plan_id, 's1') == {'run': False}
        update.assert_called_once_with(ANY, plan_id, 's1', ps.Change(
            {'status': ps.STEP_RUNNING, 'started_at': STAMP}, (ps.STEP_PENDING,)), now=T0)
        assert _journal(env, plan_id) == []

    def test_an_approved_write_reaches_the_runner_without_its_reason(self, env: PlanEnv):
        plan_id = _running(env, _create())
        _set(env, plan_id, 's1', {'approved_pending_json': json.dumps(
            {'tool': 'create_project', 'args': {'name': 'B'}, 'fingerprint': HEX, 'reason': 'Renamed'})})
        event = plan_execution.prepare(plan_id, 's1')['event']
        assert event['approved_pending'] == {'tool': 'create_project', 'args': {'name': 'B'}, 'fingerprint': HEX}

    @pytest.mark.parametrize(('stored', 'expected'), [
        ('{"tool": "create_project"}', {'tool': 'create_project', 'args': None, 'fingerprint': None}),
        ('["create_project"]', None),
        ('', None),
    ])
    def test_the_approved_write_as_stored(self, stored: str, expected: dict | None):
        assert plan_execution._approved_pending({'approved_pending_json': stored}) == expected


class TestPrepareFailsTheStepItMayNotRun:
    def test_a_cap_fails_the_step_and_journals_why(self, env: PlanEnv):
        plan_id = _running(env, _free())
        ps.update_meta(env.agents, plan_id, ps.Change({'model_calls': 60}, (ps.PLAN_RUNNING,)), now=T0)
        assert plan_execution.prepare(plan_id, 's1') == {'run': False}
        message = 'The plan has spent its 60 model calls.'
        row = env.steps(plan_id)['s1']
        assert (row['status'], row['error'], row['finished_at']) == (ps.STEP_FAILED, message, STAMP)
        assert _journal(env, plan_id) == [('step_failed', message, 's1')]
        assert env.cognito.calls == []

    def test_a_refused_approver_fails_the_step_and_stops_the_plan(self, env: PlanEnv):
        env.cognito.enabled = False
        plan_id = _running(env, _create(), _create('s2', 'B'))
        assert plan_execution.prepare(plan_id, 's1') == {'run': False}
        reason = "The approver's account is disabled."
        assert env.steps(plan_id)['s1']['error'] == reason
        assert env.meta(plan_id)['summary'] == f'The plan stopped: {reason}'
        assert env.statuses(plan_id) == {'s1': ps.STEP_FAILED, 's2': ps.STEP_SKIPPED}
        assert _journal(env, plan_id) == [('step_failed', reason, 's1'),
                                          ('plan_failed', f'The plan stopped: {reason}', None)]

    def test_a_directory_fault_fails_only_the_step(self, env: PlanEnv):
        env.cognito.broken = True
        plan_id = _running(env, _create())
        assert plan_execution.prepare(plan_id, 's1') == {'run': False}
        message = 'The user directory could not confirm the approver.'
        assert (env.statuses(plan_id), env.steps(plan_id)['s1']['error']) == ({'s1': ps.STEP_FAILED}, message)
        assert env.meta(plan_id)['status'] == ps.PLAN_RUNNING
        assert _journal(env, plan_id) == [('step_failed', message, 's1')]

    def test_the_identity_check_is_asked_for_admin_exactly_as_the_step_needs(self, env: PlanEnv):
        plan_id = _running(env, _create())
        with patch.object(plan_identity, 'approver_claims', side_effect=plan_identity.DirectoryUnavailable) as check:
            plan_execution.prepare(plan_id, 's1')
        check.assert_called_once_with(ANY, needs_admin=False, admin_if_current=False)
        assert check.call_args.args[0]['plan_id'] == plan_id

    def test_a_failed_prepare_may_also_close_a_step_already_running(self, env: PlanEnv):
        plan_id = _claimed(env, _create())
        state = plan_state.load(plan_id)
        assert state is not None
        assert plan_execution._fail_step(state, 's1', 'Stop.') == {'run': False}
        assert (env.statuses(plan_id), env.steps(plan_id)['s1']['error']) == ({'s1': ps.STEP_FAILED}, 'Stop.')


# --------------------------------------------------------------------------
# record
# --------------------------------------------------------------------------

def _record(plan_id: str, result: object, error: object = None, step_id: str = 's1') -> dict:
    return plan_execution.record(plan_id, step_id, result, error)


class TestRecordIgnoresWhatItCannotPlace:
    def test_an_unknown_plan_or_step_records_nothing(self, env: PlanEnv):
        plan_id = _claimed(env, _create())
        assert _record('pl_000000000000', {'status': 'done'}) == {}
        assert _record(plan_id, {'status': 'done'}, step_id='s9') == {}
        assert env.statuses(plan_id) == {'s1': ps.STEP_RUNNING}
        assert _journal(env, plan_id) == [('step_started', 'Run create_project', 's1')]


class TestAnInternalErrorIsRecordedByName:
    @pytest.mark.parametrize(('error', 'name'), [
        ({'Error': 'E' * 101}, 'E' * 100),
        ({'Error': ''}, 'Error'),
        ({}, 'Error'),
    ])
    def test_the_name_journal_and_no_model_calls(self, env: PlanEnv, error: dict, name: str):
        plan_id = _claimed(env, _free())
        assert _record(plan_id, {'status': 'done', 'model_calls': 4}, error) == {}
        row = env.steps(plan_id)['s1']
        assert (row['status'], row['error']) == (ps.STEP_FAILED, f'The step stopped on an internal error ({name}).')
        assert _journal(env, plan_id)[1:] == [('step_failed', name, 's1')]
        assert env.meta(plan_id)['model_calls'] == 0


class TestADoneStep:
    def test_only_declared_outputs_are_kept_encoded_and_bounded(self, env: PlanEnv):
        plan_id = _claimed(env, _create(produces=['text', 'nested', 'none', 'number', 'long', 'stamp']))
        _record(plan_id, {'status': 'done', 'outputs': {
            'text': 'x', 'nested': {'z': 1, 'y': [2]}, 'none': None, 'number': 5, 'long': 'L' * 8001,
            'stamp': T0, 'undeclared': 'no'}})
        assert env.steps(plan_id)['s1']['outputs'] == {
            'text': 'x', 'nested': '{"y": [2], "z": 1}', 'number': '5', 'long': 'L' * 8000,
            'stamp': '"2026-04-01 10:00:00+00:00"'}

    @pytest.mark.parametrize('step', [_create(produces=['project_id']), _create()])
    @pytest.mark.parametrize('outputs', [['project_id'], 'project_id', None])
    def test_no_outputs_without_a_mapping_or_a_declaration(self, env: PlanEnv, step: dict, outputs: object):
        plan_id = _claimed(env, step)
        _record(plan_id, {'status': 'done', 'outputs': outputs})
        assert env.steps(plan_id)['s1']['outputs'] == {}

    def test_the_row_and_the_journal(self, env: PlanEnv):
        plan_id = _claimed(env, _create())
        assert _record(plan_id, {'status': 'done'}) == {}
        row = env.steps(plan_id)['s1']
        assert (row['status'], row['finished_at'], 'fingerprint' in row) == (ps.STEP_DONE, STAMP, False)
        assert _journal(env, plan_id)[1:] == [('step_finished', 'Run create_project', 's1')]

    def test_a_step_without_a_title_is_journalled_by_its_id(self, env: PlanEnv):
        plan_id = _claimed(env, _create() | {'title': ''})
        _record(plan_id, {'status': 'done'})
        assert _journal(env, plan_id)[1:] == [('step_finished', 's1', 's1')]

    @pytest.mark.parametrize(('reported', 'kept'), [
        (HEX, HEX), ('AB' * 32, None), (HEX[:63], None), (HEX + 'a', None), (7, None)])
    def test_the_fingerprint_is_kept_only_when_it_is_64_lowercase_hex(self, env: PlanEnv, reported: object,
                                                                     kept: str | None):
        plan_id = _claimed(env, _create())
        _record(plan_id, {'status': 'done', 'fingerprint': reported})
        assert env.steps(plan_id)['s1'].get('fingerprint') == kept

    def test_done_is_conditional_on_running(self, env: PlanEnv):
        plan_id = _running(env, _create())
        _record(plan_id, {'status': 'done'})
        assert env.statuses(plan_id) == {'s1': ps.STEP_PENDING}


class TestTheModelCallsOfAStep:
    @pytest.mark.parametrize(('reported', 'step', 'added'), [
        (0, _free(), 0), (7, _create(), 7), (100, _create(), 100),
        (101, _free(), 1), (-1, _free(), 1), (True, _free(), 1), ('5', _free(), 1), (None, _create(), 0),
    ])
    def test_reported_within_0_to_100_else_the_steps_own_count(self, env: PlanEnv, reported: object, step: dict,
                                                               added: int):
        plan_id = _claimed(env, step)
        _record(plan_id, {'status': 'failed', 'error': 'x', 'model_calls': reported})
        assert env.meta(plan_id)['model_calls'] == added

    def test_the_count_is_added_even_once_the_plan_has_ended(self, env: PlanEnv):
        plan_id = _claimed(env, _create())
        ps.cancel_plan(env.agents, plan_id, now=T0)
        _record(plan_id, {'status': 'done', 'model_calls': 3})
        meta = env.meta(plan_id)
        assert (meta['status'], meta['model_calls'], meta['updated_at']) == (ps.PLAN_CANCELLED, 3, STAMP)

    def test_a_result_that_is_not_a_mapping_fails_the_step_and_counts_the_step(self, env: PlanEnv):
        plan_id = _claimed(env, _free())
        _record(plan_id, ['done'])
        assert env.steps(plan_id)['s1']['error'] == 'The step returned an unexpected result.'
        assert env.meta(plan_id)['model_calls'] == 1


class TestTheTripwires:
    def _state(self, tool: str, approved: str | None) -> PlanState:
        row = {'approved_pending_json': approved} if approved is not None else {}
        return PlanState(meta={'plan_id': 'pl_000000000001'}, rows={'s1': row},
                         definitions={'s1': {'id': 's1', 'kind': 'write', 'write': {'tool': tool, 'args': {}}}},
                         order=['s1'], now=T0)

    @pytest.mark.parametrize(('tool', 'approved', 'tripped'), [
        ('delete_document', None, True), ('delete_document', '', True), ('delete_document', '{}', False),
        ('create_user', '{}', True), ('create_project', None, False),
    ])
    def test_ran_unapproved(self, tool: str, approved: str | None, tripped: bool):
        assert plan_execution._ran_unapproved(self._state(tool, approved), 's1') is tripped

    @pytest.mark.parametrize(('approved', 'fingerprint', 'other'), [
        (None, 7, False), (json.dumps({'fingerprint': HEX}), HEX, False),
        (json.dumps({'fingerprint': HEX}), 'cd' * 32, True), (json.dumps({'fingerprint': HEX}), None, True),
    ])
    def test_not_the_approved_write(self, approved: str | None, fingerprint: object, other: bool):
        state = self._state('create_project', approved)
        assert plan_execution._not_the_approved_write(state, 's1', fingerprint) is other

    def test_an_unapproved_write_is_logged_and_failed(self, env: PlanEnv):
        plan_id = _claimed(env, write_step('s1', 'delete_document', {'project_id': 'p1', 'document_id': 'd1'},
                                           pack='project'))
        with patch.object(plan_execution, 'logger', MagicMock()) as logger:
            _record(plan_id, {'status': 'done'})
        logger.error.assert_called_once_with(
            'Plan step reported a never-pre-approvable write as done without approval',
            extra={'plan_id': plan_id, 'step_id': 's1'})
        assert _journal(env, plan_id)[1:] == [('step_failed', 'Run delete_document', 's1')]

    def test_another_write_than_the_approved_one_is_logged_and_failed(self, env: PlanEnv):
        plan_id = _running(env, _create())
        _set(env, plan_id, 's1', {'approved_pending_json': json.dumps({'fingerprint': HEX})})
        plan_execution.prepare(plan_id, 's1')
        with patch.object(plan_execution, 'logger', MagicMock()) as logger:
            _record(plan_id, {'status': 'done', 'fingerprint': 'cd' * 32})
        logger.error.assert_called_once_with('Plan step reported a write other than the approved one as done',
                                             extra={'plan_id': plan_id, 'step_id': 's1'})
        assert env.steps(plan_id)['s1']['error'] == 'The write that ran is not the one you approved.'


def _pending(tool: str = 'create_project', args: Any = None, **extra: Any) -> dict:
    arguments = {'name': 'B'} if args is None else args
    return {'tool': tool, 'args': arguments, 'fingerprint': canonical_write_fingerprint(tool, arguments), **extra}


class TestAPausedWrite:
    def test_the_row_holds_exactly_the_verified_write_and_drops_the_old_approval(self, env: PlanEnv):
        plan_id = _running(env, _create())
        _set(env, plan_id, 's1', {'approved_pending_json': json.dumps(_pending(args={'name': 'C'}))})
        plan_execution.prepare(plan_id, 's1')
        pending = _pending(reason='Renamed', extra='dropped')
        _record(plan_id, {'status': 'needs_approval', 'pending': pending})
        row = env.steps(plan_id)['s1']
        expected = {'tool': 'create_project', 'args': {'name': 'B'}, 'fingerprint': pending['fingerprint'],
                    'reason': 'Renamed'}
        assert (row['status'], row['pending_json'], row['pending_fingerprint'], row['pending_since']) == (
            ps.STEP_NEEDS_APPROVAL, json.dumps(expected), pending['fingerprint'], STAMP)
        assert 'approved_pending_json' not in row
        assert _journal(env, plan_id)[1:] == [('step_needs_approval', 'Run create_project', 's1')]

    @pytest.mark.parametrize(('reason', 'stored'), [
        (None, 'The write differs from the approved plan.'), ('', 'The write differs from the approved plan.'),
        ('R' * 501, 'R' * 500)])
    def test_the_reason_defaults_and_is_bounded(self, reason: str | None, stored: str):
        verified = plan_execution._verified_pending(_pending(reason=reason))
        assert verified is not None
        assert verified['reason'] == stored

    def test_a_tool_name_of_64_characters_is_verified(self):
        assert plan_execution._verified_pending(_pending('a' * 64)) is not None

    @pytest.mark.parametrize('raw', [
        None, ['create_project'], _pending() | {'args': ['B']}, _pending() | {'tool': 7},
        _pending('Create_project'), _pending('a' * 65), _pending() | {'fingerprint': None},
        _pending() | {'fingerprint': HEX}, _pending() | {'args': {'n': float('nan')}},
    ])
    def test_anything_else_is_not_verified(self, raw: object):
        assert plan_execution._verified_pending(raw) is None

    @pytest.mark.parametrize(('extra', 'paused'), [(0, True), (1, False)])
    def test_the_encoded_write_may_hold_32000_characters(self, env: PlanEnv, extra: int, paused: bool):
        base = _pending(args={'name': ''})
        size = len(json.dumps(plan_execution._verified_pending(base)))
        pending = _pending(args={'name': 'n' * (32_000 - size + extra)})
        plan_id = _claimed(env, _create())
        _record(plan_id, {'status': 'needs_approval', 'pending': pending})
        row = env.steps(plan_id)['s1']
        assert row['status'] == (ps.STEP_NEEDS_APPROVAL if paused else ps.STEP_FAILED)
        assert row.get('error') == (None if paused else UNVERIFIED)

    def test_an_unverified_write_fails_the_step(self, env: PlanEnv):
        plan_id = _claimed(env, _create())
        _record(plan_id, {'status': 'needs_approval', 'pending': None})
        assert (env.statuses(plan_id), env.steps(plan_id)['s1']['error']) == ({'s1': ps.STEP_FAILED}, UNVERIFIED)
        assert _journal(env, plan_id)[1:] == [('step_failed', 'Run create_project', 's1')]

    def test_a_pause_is_conditional_on_running(self, env: PlanEnv):
        plan_id = _running(env, _create())
        _record(plan_id, {'status': 'needs_approval', 'pending': _pending()})
        assert env.statuses(plan_id) == {'s1': ps.STEP_PENDING}


class TestAFailedStepNamesItsCause:
    @pytest.mark.parametrize(('error', 'stored'), [
        ('Project name taken', 'Project name taken'), ('', 'The step failed.'), ('   ', 'The step failed.'),
        (None, 'The step failed.'), (5, 'The step failed.')])
    def test_the_error(self, env: PlanEnv, error: object, stored: str):
        plan_id = _claimed(env, _create())
        _record(plan_id, {'status': 'failed', 'error': error})
        row = env.steps(plan_id)['s1']
        assert (row['status'], row['error'], row['finished_at']) == (ps.STEP_FAILED, stored, STAMP)
        assert _journal(env, plan_id)[1:] == [('step_failed', 'Run create_project', 's1')]
