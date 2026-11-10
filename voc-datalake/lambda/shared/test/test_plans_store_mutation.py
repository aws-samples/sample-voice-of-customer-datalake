"""Mutation hardening for ``shared/plans_store.py``.

``test_plans_store.py`` walks the happy paths of the plan rows in moto, but a mutation run found
what it cannot see:

* the EXACT rows: every META / step / event / cap attribute (``model_calls``, ``event_seq``,
  ``holds_slot``, ``updated_at`` on the cap row, the cleared pending fields) — a
  flipped default or a renamed attribute kept every status assertion green;
* the reads' ``ConsistentRead=True`` and the steps query's pagination and ordering (moto is always
  consistent and never pages), checked on a mocked table;
* every failure branch: the cap refusal vs another cancelled create, a ``BotoCoreError``, the
  ``TransactionCanceledException`` of a concurrent finisher, ``ExecutionAlreadyExists``, a lost event
  — and the client-safe wording of each ``ServiceError`` / refusal;
* the boundaries: the 24-hour start TTL at exactly 24 h, the 500/2000-character clips, the
  UpdateExpression / ConditionExpression text a ``Change`` renders;
* the views' exact shape, including the pending write's fingerprint fallback.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, get_type_hints
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from shared import plans_store as ps
from shared.exceptions import ServiceError
from shared.plan_canonical import canonical_json
from shared.test.agents_fixtures import STATE_MACHINE_ARN, AgentsEnv, agents_env
from shared.test.plan_fixture_plans import active_slots, fixture_plan

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
STAMP = '2026-10-14T12:00:00+00:00'
LATER = NOW + timedelta(minutes=5)
LATER_STAMP = '2026-10-14T12:05:00+00:00'
APPROVER = ps.Approver(sub='user-sub', username='bob')
PLAN_ID = 'pl_0123456789ab'


@pytest.fixture
def env() -> Iterator[AgentsEnv]:
    with agents_env() as agents:
        yield agents


@pytest.fixture
def table(env: AgentsEnv) -> Any:
    return env.agents


def _create(table: Any, conversation_id: str | None = None) -> dict:
    with patch.object(ps, 'new_plan_id', return_value=PLAN_ID):
        return ps.create_plan(table, fixture_plan(), approver=APPROVER, conversation_id=conversation_id, now=NOW)


def _client_error(code: str, reasons: list | None = None) -> ClientError:
    response: Any = {'Error': {'Code': code, 'Message': 'boom'}}
    if reasons is not None:
        response['CancellationReasons'] = reasons
    return ClientError(response, 'Operation')


def _mock_table() -> MagicMock:
    mocked = MagicMock()
    mocked.name = 'mocked-agents'
    return mocked


def _raw(table: Any, sk: str) -> dict:
    return table.get_item(Key={'pk': f'PLAN#{PLAN_ID}', 'sk': sk})['Item']


class TestConstantsAndContract:
    @pytest.mark.parametrize(('value', 'expected'), [
        (ps.MAX_ACTIVE_PLANS, 3), (ps.MAX_STORED_OUTPUT_CHARS, 8000), (ps.MAX_VIEW_OUTPUT_CHARS, 500),
        (ps.MAX_ERROR_CHARS, 500), (ps.MAX_SUMMARY_CHARS, 2000), (ps.MAX_EVENT_SUMMARY_CHARS, 500),
        (ps.DEFAULT_LIST_LIMIT, 20), (ps.MAX_LIST_LIMIT, 50), (ps.START_TTL, timedelta(hours=24)),
        (ps.DECLINED_ERROR, 'Declined by the approver.'),
        (ps.STEP_CHANGED_ERROR, 'This step changed; review it again'),
        (ps.CANCELLED_ERROR, 'The plan was cancelled.'),
        (ps.PENDING_FIELDS, ('pending_json', 'pending_fingerprint', 'pending_since')),
        (ps.TERMINAL_PLAN_STATUSES, ('completed', 'completed_with_errors', 'failed', 'cancelled', 'expired')),
        (ps.ACTIVE_PLAN_STATUSES, ('approved', 'running')),
        (ps.OPEN_STEP_STATUSES, ('pending', 'waiting', 'needs_approval')),
        (ps.FINISHED_STEP_STATUSES, ('done', 'failed', 'skipped', 'cancelled')),
        (ps.STEP_RUNNING, 'running'),
    ])
    def test_the_published_limits_and_texts(self, value: object, expected: object) -> None:
        assert value == expected

    def test_statuses_that_are_exactly_the_contract_pass(self) -> None:
        plan = (*ps.ACTIVE_PLAN_STATUSES, *ps.TERMINAL_PLAN_STATUSES)
        with patch.object(ps, 'PLAN_STATUSES', plan):
            assert ps._check_statuses() is None

    @pytest.mark.parametrize(('plan_statuses', 'step_statuses'), [
        (('approved',), ps.PLAN_STEP_STATUSES),
        (ps.PLAN_STATUSES, (*ps.PLAN_STEP_STATUSES, 'extra')),
    ])
    def test_statuses_that_disagree_with_the_contract_refuse_to_load(
            self, plan_statuses: tuple, step_statuses: tuple) -> None:
        with patch.object(ps, 'PLAN_STATUSES', plan_statuses), \
                patch.object(ps, 'PLAN_STEP_STATUSES', step_statuses), \
                pytest.raises(RuntimeError, match=r'^plans_store statuses disagree with plan_contract\.json$'):
            ps._check_statuses()


class TestIdsKeysAndClip:
    def test_a_plan_id_is_pl_and_twelve_hex(self) -> None:
        with patch.object(ps.secrets, 'token_hex', return_value='abcdef012345') as token_hex:
            assert ps.new_plan_id() == 'pl_abcdef012345'
        token_hex.assert_called_once_with(6)

    def test_the_keys(self) -> None:
        assert ps.plan_key('p') == {'pk': 'PLAN#p', 'sk': 'META'}
        assert ps.step_key('p', 's1') == {'pk': 'PLAN#p', 'sk': 'STEP#s1'}
        assert ps.cap_key('u') == {'pk': 'PLANCAP#u', 'sk': 'META'}

    def test_the_fingerprint_is_the_sha256_of_the_canonical_json(self) -> None:
        plan = fixture_plan()
        assert ps.plan_fingerprint(plan) == hashlib.sha256(canonical_json(plan).encode('utf-8')).hexdigest()

    @pytest.mark.parametrize(('value', 'limit', 'expected'), [('abcdef', 3, 'abc'), (12345, 2, '12'), ('ab', 5, 'ab')])
    def test_clip(self, value: object, limit: int, expected: str) -> None:
        assert ps.clip(value, limit) == expected


class TestCreate:
    def test_the_meta_row_and_the_step_rows_exactly(self, table: Any) -> None:
        plan = fixture_plan()
        meta = _create(table, conversation_id='conv-1')
        expected_meta = {
            'pk': f'PLAN#{PLAN_ID}', 'sk': 'META', 'plan_id': PLAN_ID, 'status': 'approved', 'goal': plan['goal'],
            'plan_json': canonical_json(plan), 'fingerprint': ps.plan_fingerprint(plan),
            'approver_sub': 'user-sub', 'approver_username': 'bob', 'created_at': STAMP, 'updated_at': STAMP,
            'model_calls': 0, 'event_seq': 0, 'step_count': 2, 'holds_slot': True, 'conversation_id': 'conv-1',
            'gsi1pk': 'PLANS#user-sub', 'gsi1sk': f'{STAMP}#{PLAN_ID}',
        }
        assert meta == expected_meta
        assert ps.get_meta(table, PLAN_ID) == expected_meta
        assert ps.get_steps(table, PLAN_ID) == [
            {'pk': f'PLAN#{PLAN_ID}', 'sk': 'STEP#s1', 'plan_id': PLAN_ID, 'step_id': 's1', 'index': 0,
             'kind': 'write', 'pack': 'core', 'title': 'Create the project', 'after': [], 'status': 'pending',
             'outputs': {}},
            {'pk': f'PLAN#{PLAN_ID}', 'sk': 'STEP#s2', 'plan_id': PLAN_ID, 'step_id': 's2', 'index': 1,
             'kind': 'write', 'pack': 'project', 'title': 'Generate personas', 'after': ['s1'], 'status': 'pending',
             'outputs': {}},
        ]

    def test_no_conversation_id_stores_none(self, table: Any) -> None:
        assert 'conversation_id' not in _create(table)
        assert 'conversation_id' not in _raw(table, 'META')

    def test_the_cap_row_counts_one_and_stamps_the_time(self, table: Any) -> None:
        _create(table)
        assert table.get_item(Key=ps.cap_key('user-sub'))['Item'] == {
            'pk': 'PLANCAP#user-sub', 'sk': 'META', 'active': 1, 'updated_at': STAMP}

    def test_the_cap_refusal_names_the_limit(self, table: Any) -> None:
        for _ in range(3):
            ps.create_plan(table, fixture_plan(), approver=APPROVER, conversation_id=None, now=NOW)
        with pytest.raises(ps.PlanCapReached) as caught:
            ps.create_plan(table, fixture_plan(), approver=APPROVER, conversation_id=None, now=NOW)
        assert str(caught.value) == 'You already have 3 plans running; wait for one to finish or cancel it'

    def test_an_id_collision_is_a_service_error_not_the_cap(self, table: Any) -> None:
        _create(table)
        with pytest.raises(ServiceError) as caught:
            _create(table)
        assert caught.value.message == 'Could not store the plan. Please retry.'
        assert active_slots(table, 'user-sub') == 1

    @pytest.mark.parametrize(('error', 'error_type'), [
        *((_client_error('TransactionCanceledException', reasons), 'ClientError') for reasons in (
            None, [], [None, {'Code': 'ConditionalCheckFailed'}], [{'Code': 'None'}, {'Code': 'ConditionalCheckFailed'}])),
        (BotoCoreError(), 'BotoCoreError'),
    ])
    def test_a_failure_not_caused_by_the_slot_is_a_service_error(self, error: Exception, error_type: str) -> None:
        mocked = _mock_table()
        mocked.meta.client.transact_write_items.side_effect = error
        with patch.object(ps, 'logger') as logger, pytest.raises(ServiceError) as caught:
            ps.create_plan(mocked, fixture_plan(), approver=APPROVER, conversation_id=None, now=NOW)
        assert caught.value.message == 'Could not store the plan. Please retry.'
        logger.exception.assert_called_once_with('Plans store: store the plan failed',
                                                 extra={'error_type': error_type})

    def test_a_slot_refusal_first_in_the_reasons_is_the_cap(self) -> None:
        mocked = _mock_table()
        mocked.meta.client.transact_write_items.side_effect = _client_error(
            'TransactionCanceledException', [{'Code': 'ConditionalCheckFailed'}, None])
        with pytest.raises(ps.PlanCapReached):
            ps.create_plan(mocked, fixture_plan(), approver=APPROVER, conversation_id=None, now=NOW)

    def test_the_transaction_items(self) -> None:
        mocked = _mock_table()
        with patch.object(ps, 'new_plan_id', return_value=PLAN_ID):
            meta = ps.create_plan(mocked, fixture_plan(), approver=APPROVER, conversation_id=None, now=NOW)
        items = mocked.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        assert items[0] == {'Update': {
            'TableName': 'mocked-agents', 'Key': {'pk': 'PLANCAP#user-sub', 'sk': 'META'},
            'UpdateExpression': 'ADD #active :one SET #updated = :now',
            'ConditionExpression': 'attribute_not_exists(#active) OR #active < :max',
            'ExpressionAttributeNames': {'#active': 'active', '#updated': 'updated_at'},
            'ExpressionAttributeValues': {':one': 1, ':max': 3, ':now': STAMP},
        }}
        assert items[1] == {'Put': {'TableName': 'mocked-agents', 'Item': meta,
                                    'ConditionExpression': 'attribute_not_exists(pk)'}}
        assert [item['Put']['Item']['sk'] for item in items[1:]] == ['META', 'STEP#s1', 'STEP#s2']


class TestReads:
    @pytest.mark.parametrize(('call', 'key'), [
        (lambda t: ps.get_meta(t, 'p'), {'pk': 'PLAN#p', 'sk': 'META'}),
        (lambda t: ps.get_step(t, 'p', 's1'), {'pk': 'PLAN#p', 'sk': 'STEP#s1'}),
    ])
    def test_a_get_is_consistent_and_turns_decimals_plain(self, call: Any, key: dict) -> None:
        mocked = _mock_table()
        mocked.get_item.return_value = {'Item': {'n': Decimal(2)}}
        assert call(mocked) == {'n': 2}
        mocked.get_item.assert_called_once_with(Key=key, ConsistentRead=True)

    def test_a_missing_or_odd_item_is_none(self) -> None:
        mocked = _mock_table()
        mocked.get_item.side_effect = [{}, {'Item': 'odd'}]
        assert ps.get_meta(mocked, 'p') is None
        assert ps.get_step(mocked, 'p', 's1') is None

    @pytest.mark.parametrize(('call', 'message'), [
        (lambda t: ps.get_meta(t, 'p'), 'Could not read the plan. Please retry.'),
        (lambda t: ps.get_step(t, 'p', 's'), 'Could not read the plan step. Please retry.'),
        (lambda t: ps.get_steps(t, 'p'), 'Could not read the plan steps. Please retry.'),
        (lambda t: ps.list_plans(t, 'u', limit=5), 'Could not list your plans. Please retry.'),
    ])
    @pytest.mark.parametrize('error', [_client_error('InternalServerError'), BotoCoreError()])
    def test_a_failed_read_is_a_service_error(self, call: Any, message: str, error: Exception) -> None:
        mocked = _mock_table()
        mocked.get_item.side_effect = error
        mocked.query.side_effect = error
        with pytest.raises(ServiceError) as caught:
            call(mocked)
        assert caught.value.message == message

    def test_get_steps_pages_and_sorts_by_index(self) -> None:
        mocked = _mock_table()
        mocked.query.side_effect = [
            {'Items': [{'step_id': 'c', 'index': 2}, {'step_id': 'a', 'index': 1}], 'LastEvaluatedKey': {'k': 1}},
            {'Items': [{'step_id': 'b'}]},
        ]
        assert [row['step_id'] for row in ps.get_steps(mocked, 'p')] == ['b', 'a', 'c']
        first, second = mocked.query.call_args_list
        assert first.kwargs['ConsistentRead'] is True
        assert 'ExclusiveStartKey' not in first.kwargs
        assert second.kwargs['ExclusiveStartKey'] == {'k': 1}

    def test_get_steps_reads_only_the_step_rows(self, table: Any) -> None:
        _create(table)
        ps.append_event(table, PLAN_ID, 'k', 's', now=NOW)
        assert [row['sk'] for row in ps.get_steps(table, PLAN_ID)] == ['STEP#s1', 'STEP#s2']

    @pytest.mark.parametrize(('meta', 'expected'), [({}, {}), ({'plan_json': '[1]'}, {}),
                                                    ({'plan_json': '{"a": 1}'}, {'a': 1})])
    def test_stored_plan(self, meta: dict, expected: dict) -> None:
        assert ps.stored_plan(meta) == expected

    def test_plan_steps_by_id_skips_what_is_not_a_step(self) -> None:
        meta = {'plan_json': json.dumps({'steps': [{'id': 's1', 'k': 1}, 'odd']})}
        assert ps.plan_steps_by_id(meta) == {'s1': {'id': 's1', 'k': 1}}
        assert ps.plan_steps_by_id({'plan_json': '{}'}) == {}

    def test_list_plans_honours_the_limit_newest_first(self, table: Any) -> None:
        first = ps.create_plan(table, fixture_plan(), approver=APPROVER, conversation_id=None, now=NOW)
        second = ps.create_plan(table, fixture_plan(), approver=APPROVER, conversation_id=None, now=LATER)
        assert [row['plan_id'] for row in ps.list_plans(table, 'user-sub', limit=1)] == [second['plan_id']]
        assert first['plan_id'] != second['plan_id']


class TestValueObjects:
    @pytest.mark.parametrize(('instance', 'field'), [(APPROVER, 'sub'), (ps.Change({}, ()), 'sets')])
    def test_they_are_immutable(self, instance: object, field: str) -> None:
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(instance, field, 'other')

    def test_a_change_defaults_to_no_remove_add_or_match(self) -> None:
        change = ps.Change({}, ())
        assert (change.remove, change.add, change.match) == ((), None, None)

    def test_the_change_type_hints_resolve(self) -> None:
        hints = get_type_hints(ps.Change)
        assert (hints['add'], hints['match']) == (Mapping[str, int] | None, Mapping[str, Any] | None)


class TestChangeExpressions:
    def test_sets_removes_and_adds(self) -> None:
        change = ps.Change({'a': 1, 'b': 2}, ('x', 'y'), remove=('r', 'q'), add={'n': 3, 'm': 4},
                           match={'f': 'v', 'g': 'w'})
        assert ps._conditional(change) == (
            'SET #s0 = :s0, #s1 = :s1 REMOVE #r0, #r1 ADD #a0 :a0, #a1 :a1',
            'attribute_exists(pk) AND #st IN (:w0, :w1) AND #m0 = :m0 AND #m1 = :m1',
            {'#st': 'status', '#s0': 'a', '#s1': 'b', '#r0': 'r', '#r1': 'q', '#a0': 'n', '#a1': 'm',
             '#m0': 'f', '#m1': 'g'},
            {':s0': 1, ':s1': 2, ':a0': 3, ':a1': 4, ':w0': 'x', ':w1': 'y', ':m0': 'v', ':m1': 'w'},
        )

    def test_without_sets_the_expression_has_no_leading_space(self) -> None:
        assert ps._expression(ps.Change({}, (), remove=('r',))) == ('REMOVE #r0', {'#st': 'status', '#r0': 'r'}, {})
        assert ps._expression(ps.Change({}, (), add={'n': 1})) == ('ADD #a0 :a0', {'#st': 'status', '#a0': 'n'},
                                                                   {':a0': 1})
        assert ps._expression(ps.Change({'a': 1}, ())) == ('SET #s0 = :s0', {'#st': 'status', '#s0': 'a'},
                                                           {':s0': 1})

    def test_update_item_is_called_with_the_rendered_change(self) -> None:
        mocked = _mock_table()
        mocked.update_item.return_value = {'Attributes': {'status': 'running'}}
        assert ps.update_meta(mocked, 'p', ps.Change({'status': 'running'}, ('approved',)), now=NOW) == {
            'status': 'running'}
        mocked.update_item.assert_called_once_with(
            Key={'pk': 'PLAN#p', 'sk': 'META'}, UpdateExpression='SET #s0 = :s0, #s1 = :s1',
            ConditionExpression='attribute_exists(pk) AND #st IN (:w0)',
            ExpressionAttributeNames={'#st': 'status', '#s0': 'status', '#s1': 'updated_at'},
            ExpressionAttributeValues={':s0': 'running', ':s1': STAMP, ':w0': 'approved'}, ReturnValues='ALL_NEW')

    @pytest.mark.parametrize('error', [_client_error('InternalServerError'), BotoCoreError()])
    def test_a_failed_update_is_a_service_error(self, error: Exception) -> None:
        mocked = _mock_table()
        mocked.update_item.side_effect = error
        with pytest.raises(ServiceError) as caught:
            ps.update_step(mocked, 'p', 's', ps.Change({}, ('pending',)), now=NOW)
        assert caught.value.message == 'Could not update the plan. Please retry.'

    def test_a_refused_condition_is_none(self) -> None:
        mocked = _mock_table()
        mocked.update_item.side_effect = _client_error('ConditionalCheckFailedException')
        assert ps.update_step(mocked, 'p', 's', ps.Change({}, ('pending',)), now=NOW) is None

    def test_update_step_and_meta_stamp_and_carry_remove_add_and_match(self, table: Any) -> None:
        _create(table, conversation_id='conv-1')
        assert ps.update_step(table, PLAN_ID, 's1', ps.Change({'title': 't'}, ('pending',), match={'kind': 'read'}),
                              now=LATER) is None
        step = ps.update_step(table, PLAN_ID, 's1', ps.Change({'title': 't'}, ('pending',), remove=('outputs',),
                                                               add={'tries': 2}, match={'kind': 'write'}), now=LATER)
        assert step is not None
        assert (step['title'], step['updated_at'], step['tries'], 'outputs' in step) == ('t', LATER_STAMP, 2, False)
        assert ps.update_meta(table, PLAN_ID, ps.Change({}, ('approved',), match={'goal': 'other'}), now=LATER) is None
        meta = ps.update_meta(table, PLAN_ID, ps.Change({}, ('approved',), remove=('conversation_id',),
                                                        add={'model_calls': 2}, match={'step_count': 2}), now=LATER)
        assert meta is not None
        assert (meta['updated_at'], meta['model_calls'], 'conversation_id' in meta) == (LATER_STAMP, 2, False)


def _pause(table: Any, fingerprint: str | None = 'f' * 64, *, pending: bool = True) -> None:
    sets: dict[str, Any] = {'status': ps.STEP_NEEDS_APPROVAL, 'pending_since': STAMP}
    if pending:
        sets['pending_json'] = json.dumps({'tool': 'create_project', 'args': {'name': 'X'}, 'reason': 'r',
                                           'fingerprint': 'd' * 64})
    if fingerprint:
        sets['pending_fingerprint'] = fingerprint
    ps.update_step(table, PLAN_ID, 's1', ps.Change(sets, (ps.STEP_PENDING,)), now=NOW)


class TestFinishStep:
    def test_a_finished_step_clears_the_pending_write_and_clips_the_error(self, table: Any) -> None:
        _create(table)
        _pause(table)
        step = ps.finish_step(table, PLAN_ID, 's1', ps.STEP_FAILED, now=LATER, when=(ps.STEP_NEEDS_APPROVAL,),
                              error='e' * 600)
        assert step is not None
        assert step['error'] == 'e' * 500
        assert (step['status'], step['finished_at'], step['updated_at']) == ('failed', LATER_STAMP, LATER_STAMP)
        assert not {'pending_json', 'pending_fingerprint', 'pending_since'} & set(step)
        assert step['outputs'] == {}

    def test_outputs_replace_and_no_error_writes_none(self, table: Any) -> None:
        _create(table)
        ps.update_step(table, PLAN_ID, 's1', ps.Change({'outputs': {'a': 'b'}}, ('pending',)), now=NOW)
        step = ps.finish_step(table, PLAN_ID, 's1', ps.STEP_DONE, now=NOW, when=('pending',), outputs={})
        assert step is not None
        assert step['outputs'] == {}
        assert 'error' not in step
        kept = ps.finish_step(table, PLAN_ID, 's2', ps.STEP_DONE, now=NOW, when=('pending',), error='')
        assert kept is not None
        assert ('error' in kept, kept['outputs']) == (False, {})


class TestEndPlan:
    def test_finish_writes_the_terminal_meta_and_gives_the_slot_back(self, table: Any) -> None:
        _create(table)
        meta = ps.finish_plan(table, PLAN_ID, ps.PLAN_COMPLETED, now=LATER, summary='s' * 2500)
        assert meta is not None
        assert (meta['status'], meta['finished_at'], meta['updated_at']) == ('completed', LATER_STAMP, LATER_STAMP)
        assert meta['summary'] == 's' * 2000
        assert 'holds_slot' not in meta
        assert table.get_item(Key=ps.cap_key('user-sub'))['Item'] == {
            'pk': 'PLANCAP#user-sub', 'sk': 'META', 'active': 0, 'updated_at': LATER_STAMP}

    def test_a_missing_plan_or_a_terminal_one_is_none(self, table: Any) -> None:
        assert ps.finish_plan(table, 'pl_missing', ps.PLAN_FAILED, now=NOW, summary='x') is None

    def test_a_slot_without_an_approver_is_not_released(self, table: Any) -> None:
        _create(table)
        ps.update_meta(table, PLAN_ID, ps.Change({}, ('approved',), remove=('approver_sub',)), now=NOW)
        meta = ps.finish_plan(table, PLAN_ID, ps.PLAN_FAILED, now=NOW, summary='x')
        assert (meta or {}).get('status') == 'failed'
        assert active_slots(table, 'user-sub') == 1
        assert 'Item' not in table.get_item(Key=ps.cap_key('None'))

    def test_a_concurrent_finisher_wins_and_this_one_is_none(self, table: Any) -> None:
        _create(table)
        stale = ps.get_meta(table, PLAN_ID)
        ps.finish_plan(table, PLAN_ID, ps.PLAN_COMPLETED, now=NOW, summary='first')
        with patch.object(ps, 'get_meta', return_value=stale):
            assert ps.finish_plan(table, PLAN_ID, ps.PLAN_FAILED, now=NOW, summary='second') is None
        assert active_slots(table, 'user-sub') == 0
        assert (ps.get_meta(table, PLAN_ID) or {})['summary'] == 'first'

    @pytest.mark.parametrize(('error', 'error_type'), [(_client_error('InternalServerError'), 'ClientError'),
                                                      (BotoCoreError(), 'BotoCoreError')])
    def test_a_failed_transaction_is_a_service_error(self, error: Exception, error_type: str) -> None:
        mocked = _mock_table()
        mocked.get_item.return_value = {'Item': {'status': 'running', 'holds_slot': True, 'approver_sub': 'u'}}
        mocked.meta.client.transact_write_items.side_effect = error
        with patch.object(ps, 'logger') as logger, pytest.raises(ServiceError) as caught:
            ps.finish_plan(mocked, 'p', ps.PLAN_FAILED, now=NOW, summary='x')
        assert caught.value.message == 'Could not finish the plan. Please retry.'
        logger.exception.assert_called_once_with('Plans store: finish the plan failed',
                                                 extra={'error_type': error_type})

    def test_the_end_transaction_items(self) -> None:
        mocked = _mock_table()
        mocked.get_item.return_value = {'Item': {'status': 'running', 'holds_slot': True, 'approver_sub': 'u'}}
        ps.finish_plan(mocked, 'p', ps.PLAN_FAILED, now=NOW, summary='x')
        items = mocked.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        assert items == [
            {'Update': {'TableName': 'mocked-agents', 'Key': {'pk': 'PLAN#p', 'sk': 'META'},
                        'UpdateExpression': 'SET #s0 = :s0, #s1 = :s1, #s2 = :s2, #s3 = :s3 REMOVE #r0',
                        'ConditionExpression': 'attribute_exists(pk) AND #st IN (:w0, :w1)',
                        'ExpressionAttributeNames': {'#st': 'status', '#s0': 'status', '#s1': 'finished_at',
                                                     '#s2': 'summary', '#s3': 'updated_at', '#r0': 'holds_slot'},
                        'ExpressionAttributeValues': {':s0': 'failed', ':s1': STAMP, ':s2': 'x', ':s3': STAMP,
                                                      ':w0': 'approved', ':w1': 'running'}}},
            {'Update': {'TableName': 'mocked-agents', 'Key': {'pk': 'PLANCAP#u', 'sk': 'META'},
                        'UpdateExpression': 'ADD #active :minus SET #updated = :now',
                        'ExpressionAttributeNames': {'#active': 'active', '#updated': 'updated_at'},
                        'ExpressionAttributeValues': {':minus': -1, ':now': STAMP}}},
        ]


class TestCancelAndExpire:
    def test_cancel_writes_the_cancel_summary_and_error(self, table: Any) -> None:
        _create(table)
        meta = ps.cancel_plan(table, PLAN_ID, now=NOW)
        assert (meta or {})['summary'] == 'The plan was cancelled.'
        assert [(row['status'], row['error']) for row in ps.get_steps(table, PLAN_ID)] == [
            ('cancelled', 'The plan was cancelled.')] * 2

    def test_cancel_of_a_terminal_plan_touches_no_step(self, table: Any) -> None:
        _create(table)
        ps.finish_plan(table, PLAN_ID, ps.PLAN_COMPLETED, now=NOW, summary='done')
        assert ps.cancel_plan(table, PLAN_ID, now=NOW) is None
        assert [row['status'] for row in ps.get_steps(table, PLAN_ID)] == ['pending', 'pending']

    def test_close_open_steps_leaves_running_and_finished_steps(self, table: Any) -> None:
        _create(table)
        ps.update_step(table, PLAN_ID, 's1', ps.Change({'status': 'running'}, ('pending',)), now=NOW)
        ps.close_open_steps(table, PLAN_ID, now=NOW, status=ps.STEP_SKIPPED, error='why')
        assert [(row['status'], row.get('error')) for row in ps.get_steps(table, PLAN_ID)] == [
            ('running', None), ('skipped', 'why')]

    def test_expiry_at_exactly_24_hours_and_its_texts(self, table: Any) -> None:
        meta = _create(table)
        assert ps.expire_if_stale(table, meta, now=NOW + timedelta(hours=24, seconds=-1)) is meta
        expired = ps.expire_if_stale(table, meta, now=NOW + timedelta(hours=24))
        assert (expired['status'], expired['summary'], expired['finished_at']) == (
            'expired', 'The plan did not start within 24 hours of its approval.', '2026-10-15T12:00:00+00:00')
        assert {row['error'] for row in ps.get_steps(table, PLAN_ID)} == {'The plan expired before this step ran.'}

    def test_a_plan_without_a_creation_time_does_not_expire(self, table: Any) -> None:
        meta = {'plan_id': 'p', 'status': 'approved'}
        assert ps.expire_if_stale(table, meta, now=NOW) is meta

    def test_a_plan_that_ended_meanwhile_returns_its_current_row(self, table: Any) -> None:
        meta = _create(table)
        ps.cancel_plan(table, PLAN_ID, now=NOW)
        with patch.object(ps, '_end_plan', return_value=None):
            current = ps.expire_if_stale(table, meta, now=NOW + timedelta(hours=30))
        assert current['status'] == 'cancelled'
        assert {row['error'] for row in ps.get_steps(table, PLAN_ID)} == {'The plan was cancelled.'}

    def test_a_vanished_plan_returns_the_given_row(self, table: Any) -> None:
        meta = {'plan_id': 'pl_gone', 'status': 'approved', 'created_at': STAMP}
        assert ps.expire_if_stale(table, meta, now=NOW + timedelta(hours=30)) is meta


class TestApproveAndDecline:
    def test_approve_writes_the_accepted_write_and_the_time(self, table: Any) -> None:
        _create(table)
        _pause(table)
        pending_json = _raw(table, 'STEP#s1')['pending_json']
        step = ps.approve_step(table, PLAN_ID, 's1', fingerprint='f' * 64, now=LATER)
        assert step is not None
        assert (step['status'], step['approved_pending_json'], step['updated_at']) == (
            'pending', pending_json, LATER_STAMP)
        assert 'approved_at' not in step
        assert not {'pending_json', 'pending_fingerprint', 'pending_since'} & set(step)

    def test_a_paused_step_without_a_write_is_none(self, table: Any) -> None:
        _create(table)
        _pause(table, pending=False)
        assert ps.approve_step(table, PLAN_ID, 's1', fingerprint='f' * 64, now=NOW) is None

    def test_a_missing_step_is_none(self, table: Any) -> None:
        _create(table)
        assert ps.approve_step(table, PLAN_ID, 's9', fingerprint='f' * 64, now=NOW) is None

    def test_another_fingerprint_names_the_change(self, table: Any) -> None:
        _create(table)
        _pause(table)
        with pytest.raises(ps.StepChanged, match=r'^This step changed; review it again$'):
            ps.approve_step(table, PLAN_ID, 's1', fingerprint='e' * 64, now=NOW)

    def test_a_step_resolved_meanwhile_is_none_not_changed(self, table: Any) -> None:
        _create(table)
        _pause(table)
        stale = ps.get_step(table, PLAN_ID, 's1')
        ps.decline_step(table, PLAN_ID, 's1', now=NOW)
        with patch.object(ps, 'get_step', side_effect=[stale, ps.get_step(table, PLAN_ID, 's1')]):
            assert ps.approve_step(table, PLAN_ID, 's1', fingerprint='f' * 64, now=NOW) is None
        with patch.object(ps, 'get_step', side_effect=[stale, None]):
            assert ps.approve_step(table, PLAN_ID, 's1', fingerprint='f' * 64, now=NOW) is None

    def test_the_approve_is_conditional_on_the_write_it_read(self, table: Any) -> None:
        _create(table)
        _pause(table)
        stale = dict(ps.get_step(table, PLAN_ID, 's1') or {})
        stale['pending_json'] = '{"tool": "other"}'
        with patch.object(ps, 'get_step', side_effect=[stale, ps.get_step(table, PLAN_ID, 's1')]), \
                pytest.raises(ps.StepChanged):
            ps.approve_step(table, PLAN_ID, 's1', fingerprint='f' * 64, now=NOW)

    def test_decline_only_a_paused_step(self, table: Any) -> None:
        _create(table)
        ps.update_step(table, PLAN_ID, 's1', ps.Change({'status': 'waiting'}, ('pending',)), now=NOW)
        assert ps.decline_step(table, PLAN_ID, 's1', now=NOW) is None


class TestLaunch:
    def test_the_execution_is_named_after_the_plan_and_journalled(self, env: AgentsEnv) -> None:
        _create(env.agents)
        ps.launch_plan(env.agents, {'plan_id': PLAN_ID}, now=LATER)
        env.sfn.start_execution.assert_called_once_with(
            stateMachineArn=STATE_MACHINE_ARN, name=PLAN_ID, input='{"run_kind": "plan", "plan_id": "' + PLAN_ID + '"}')
        assert _raw(env.agents, 'EVT#00000001') == {
            'pk': f'PLAN#{PLAN_ID}', 'sk': 'EVT#00000001', 'plan_id': PLAN_ID, 'seq': 1, 'at': LATER_STAMP,
            'kind': 'plan_started', 'summary': 'Plan approved and queued'}

    def test_a_duplicate_start_is_quietly_accepted(self, env: AgentsEnv) -> None:
        _create(env.agents)
        env.sfn.start_execution.side_effect = _client_error('ExecutionAlreadyExists')
        ps.launch_plan(env.agents, {'plan_id': PLAN_ID}, now=NOW)
        meta = ps.get_meta(env.agents, PLAN_ID) or {}
        assert (meta['status'], meta['event_seq']) == ('approved', 0)

    @pytest.mark.parametrize('error', [_client_error('ExecutionLimitExceeded'), BotoCoreError()])
    def test_a_failed_start_fails_the_plan(self, env: AgentsEnv, error: Exception) -> None:
        _create(env.agents)
        env.sfn.start_execution.side_effect = error
        with pytest.raises(ServiceError) as caught:
            ps.launch_plan(env.agents, {'plan_id': PLAN_ID}, now=NOW)
        assert caught.value.message == 'Could not start the plan. Please retry.'
        meta = ps.get_meta(env.agents, PLAN_ID) or {}
        assert (meta['status'], meta['summary'], meta['event_seq']) == ('failed', 'The plan could not be started.', 0)


class TestEvents:
    def test_an_event_row_with_a_step_and_a_clipped_summary(self, table: Any) -> None:
        _create(table)
        ps.append_event(table, PLAN_ID, 'step_started', 'x' * 700, now=NOW, step_id='s1')
        assert _raw(table, 'EVT#00000001') == {
            'pk': f'PLAN#{PLAN_ID}', 'sk': 'EVT#00000001', 'plan_id': PLAN_ID, 'seq': 1, 'at': STAMP,
            'kind': 'step_started', 'summary': 'x' * 500, 'step_id': 's1'}
        assert _raw(table, 'META')['event_seq'] == 1

    def test_an_event_of_a_missing_plan_is_logged_not_raised(self, table: Any) -> None:
        with patch.object(ps, 'logger') as logger:
            ps.append_event(table, 'pl_gone', 'k', 's', now=NOW)
        logger.warning.assert_called_once_with('Plan event not recorded', extra={'plan_id': 'pl_gone', 'kind': 'k'})
        assert table.scan()['Items'] == []


class TestViews:
    @pytest.mark.parametrize(('value', 'expected'), [(5, None), ('', None), ('{bad', None), ('[1]', [1])])
    def test_decode_json(self, value: object, expected: object) -> None:
        assert ps.decode_json(value) == expected

    def test_the_full_step_view(self) -> None:
        step = {'step_id': 's1', 'title': 't', 'pack': 'core', 'kind': 'write', 'after': ['s0'],
                'status': 'needs_approval', 'outputs': {'o': 'y' * 600, 7: 'z'}, 'started_at': 'a',
                'finished_at': 'b', 'error': 'e',
                'pending_json': json.dumps({'tool': 'x', 'args': {'n': 1}, 'reason': 'r', 'fingerprint': 'fp'})}
        assert ps.step_view(step) == {
            'id': 's1', 'title': 't', 'pack': 'core', 'kind': 'write', 'after': ['s0'], 'status': 'needs_approval',
            'outputs': {'o': 'y' * 500, '7': 'z'}, 'started_at': 'a', 'finished_at': 'b', 'error': 'e',
            'pending': {'tool': 'x', 'args': {'n': 1}, 'reason': 'r', 'fingerprint': 'fp'}}

    def test_a_bare_step_view(self) -> None:
        assert ps.step_view({'outputs': 'odd', 'started_at': '', 'status': 'pending',
                             'pending_json': '{"tool": "x"}', 'pending_fingerprint': 'p'}) == {
            'id': None, 'title': None, 'pack': None, 'kind': None, 'after': [], 'status': 'pending', 'outputs': {}}

    def test_the_stored_pending_fingerprint_wins(self) -> None:
        step = {'status': 'needs_approval', 'pending_json': '{"fingerprint": "inner"}', 'pending_fingerprint': 'outer'}
        assert ps.step_view(step)['pending'] == {'tool': None, 'args': None, 'reason': None, 'fingerprint': 'outer'}

    def test_a_paused_step_whose_write_is_not_an_object_has_no_pending(self) -> None:
        assert 'pending' not in ps.step_view({'status': 'needs_approval', 'pending_json': '[1]'})

    def test_the_plan_views(self) -> None:
        meta = {'plan_id': 'p', 'status': 's', 'goal': 'g', 'created_at': 'c', 'updated_at': 'u',
                'started_at': 'a', 'finished_at': 'f', 'conversation_id': 'cv', 'summary': '', 'approver_sub': 'x'}
        assert ps.plan_summary_view(meta) == {'plan_id': 'p', 'status': 's', 'goal': 'g', 'created_at': 'c',
                                              'updated_at': 'u'}
        assert ps.plan_view({**meta, 'summary': 'sm'}, [])['summary'] == 'sm'
        assert ps.plan_view(meta, [{'step_id': 's1'}]) == {
            'plan_id': 'p', 'status': 's', 'goal': 'g', 'created_at': 'c', 'updated_at': 'u', 'started_at': 'a',
            'finished_at': 'f', 'conversation_id': 'cv',
            'steps': [{'id': 's1', 'title': None, 'pack': None, 'kind': None, 'after': [], 'status': None,
                       'outputs': {}}]}
