"""Mutation hardening for `memory/retention/handler.py`.

`test_scanner_retention.py` drives one sweep through moto and pins that a
decayed and an expired memory are archived while a long-term one is kept, and
that the sweep yields to a tiny time budget. A mutation run found what it could
not see:

* THE BOUNDARY. The sweep stops only when FEWER than 15 000 ms remain: exactly
  15 000 ms still checks the next item. Neither side of that edge was asserted,
  nor the warning the stop logs, nor that a partial result keeps what it had
  already counted.
* THE COUNTS. `checked` was never read on a sweep that checked anything, and
  only one memory per reason was ever archived, so a counter that is SET
  instead of incremented survived.
* THE WRITES. The audit row's partition (`MEMEVT#<memory_id>`), action and
  `detail`, and the `archived_at` stamp were never compared; a memory that
  vanished between the query and the archive was never exercised, so counting
  it as archived — and writing it an audit row — went unnoticed.
* THE READ. The sweep's projection is the docstring's promise that no
  embedding is read; nothing pinned which attributes it names, nor that each
  of the three "touched" stamps alone keeps a fresh memory alive.
* THE WIRING. The `MemoriesArchived` metric (name and value), the three handler
  decorators and the `RuntimeError` wording were unobserved.
"""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from aws_lambda_powertools.metrics import MetricUnit
from botocore.exceptions import ClientError

from memory.retention import handler as retention
from shared import memory_policy as policy
from shared import memory_store as store
from shared.logging import logger, metrics
from shared.test.emf_fixtures import cold_start_metric_names
from shared.test.memory_fixtures import candidate

NOW = datetime(2026, 3, 1, 12, 0, 0, tzinfo=UTC)
NOW_ISO = '2026-03-01T12:00:00+00:00'
OLD = NOW - timedelta(days=200)
PLENTY = 600_000
TIME_BUDGET_WARNING = 'Memory retention stopped on its time budget'
PERSONAL_PK = store.scope_pk(policy.SCOPE_PERSONAL, 'sub-a')


def _write_decay(world, *statements: str, now: datetime = OLD) -> None:
    store.write_automated(world.memory, [candidate(s) for s in statements], now=now)


def _row(world, memory_id: str, *, status: str = 'active', pk: str = store.COMPANY_PK,
         scope: str = 'company', **stamps: str) -> dict[str, Any]:
    """A minimal memory row written straight to the table (so each stamp can be given alone)."""
    row = {**store.memory_key(pk, memory_id), 'memory_id': memory_id, 'scope': scope, 'status': status,
           'retention': 'decay', 'gsi1pk': store.status_partition(scope, status), 'gsi1sk': NOW_ISO, **stamps}
    world.memory.put_item(Item=row)
    return row


def _events(world, memory_id: str) -> list[dict]:
    return store.query_partition(world.memory, f'{store.EVENT_PK_PREFIX}{memory_id}')


def _sweep(world, time_left_ms=lambda: PLENTY) -> dict[str, int]:
    return retention.sweep(world.memory, NOW, time_left_ms)


def _by_statement(world, pk: str = store.COMPANY_PK) -> dict[str, dict]:
    return {r['statement']: r for r in world.memories(pk)}


def _seed_two_decayed_one_expired(world) -> None:
    _write_decay(world, 'Customers want faster refunds', 'Checkout is slow on Fridays')
    _write_decay(world, 'Mobile checkout crashes on Android', now=NOW)
    store.set_fields(world.memory, _by_statement(world)['Mobile checkout crashes on Android'],
                     {'retention': 'dated', 'expires_at': '2026-02-28'}, now=NOW)


# ============================================
# The time budget
# ============================================

class TestTheTimeBudgetIsAStrictBound:
    def test_the_margin_is_fifteen_seconds(self):
        assert retention.SAFETY_MARGIN_MS == 15_000

    def test_exactly_the_margin_left_still_checks_the_item(self, world):
        _write_decay(world, 'Customers want faster refunds')
        with patch.object(logger, 'warning') as warning:
            assert _sweep(world, lambda: 15_000) == {'checked': 1, 'expired': 0, 'decayed': 1}
        warning.assert_not_called()

    def test_one_millisecond_under_the_margin_stops_before_the_item(self, world):
        _write_decay(world, 'Customers want faster refunds')
        with patch.object(logger, 'warning') as warning:
            assert _sweep(world, lambda: 14_999) == {'checked': 0, 'expired': 0, 'decayed': 0}
        warning.assert_called_once_with(TIME_BUDGET_WARNING)
        assert _by_statement(world)['Customers want faster refunds']['status'] == 'active'

    def test_a_stop_keeps_what_was_already_counted(self, world):
        _write_decay(world, 'Customers want faster refunds', 'Checkout is slow on Fridays')
        clock = MagicMock(side_effect=[PLENTY, 14_999])
        with patch.object(logger, 'warning') as warning:
            assert _sweep(world, clock) == {'checked': 1, 'expired': 0, 'decayed': 1}
        warning.assert_called_once_with(TIME_BUDGET_WARNING)
        assert sorted(r['status'] for r in world.memories()) == ['active', 'archived']


# ============================================
# The counts
# ============================================

class TestEveryMemoryIsCountedOnce:
    def test_three_checked_two_decayed_one_expired(self, world):
        _seed_two_decayed_one_expired(world)
        assert _sweep(world) == {'checked': 3, 'expired': 1, 'decayed': 2}

    def test_a_kept_memory_is_checked_but_not_archived(self, world):
        _write_decay(world, 'Customers want faster refunds', now=NOW)
        assert _sweep(world) == {'checked': 1, 'expired': 0, 'decayed': 0}

    def test_every_scope_and_live_status_is_swept_but_archived_is_not(self, world):
        live = [('company', store.COMPANY_PK, s) for s in ('active', 'proposed', 'conflict')]
        live += [('personal', PERSONAL_PK, s) for s in ('active', 'proposed', 'conflict')]
        for scope, pk, status in live:
            _row(world, f'{scope}-{status}', status=status, pk=pk, scope=scope, created_at=OLD.isoformat())
        _row(world, 'already-archived', status='archived', created_at=OLD.isoformat())
        assert _sweep(world) == {'checked': 6, 'expired': 0, 'decayed': 6}
        archived = {r['memory_id']: r.get('archived_reason') for r in world.memories() + world.memories(PERSONAL_PK)}
        assert archived == {f'{scope}-{status}': 'decayed' for scope, _pk, status in live} | {'already-archived': None}


# ============================================
# The writes
# ============================================

class TestArchivingWritesTheRowAndItsAuditEvent:
    def test_the_archived_row_carries_reason_and_stamp(self, world):
        _write_decay(world, 'Customers want faster refunds')
        _sweep(world)
        row = _by_statement(world)['Customers want faster refunds']
        assert (row['status'], row['archived_reason'], row['archived_at'], row['updated_at']) == (
            'archived', 'decayed', NOW_ISO, NOW_ISO)

    @pytest.mark.parametrize(('retention_fields', 'reason'), [
        ({}, 'decayed'),
        ({'retention': 'dated', 'expires_at': '2026-02-28'}, 'expired'),
    ])
    def test_the_audit_event_names_the_memory_the_action_and_the_reason(self, world, retention_fields, reason):
        _write_decay(world, 'Customers want faster refunds')
        row = _by_statement(world)['Customers want faster refunds']
        if retention_fields:
            store.set_fields(world.memory, row, retention_fields, now=OLD)
        _sweep(world)
        [created, archived] = sorted(_events(world, row['memory_id']), key=lambda e: e['sk'])
        assert created['action'] == 'created'
        assert archived['pk'] == f"MEMEVT#{row['memory_id']}"
        assert archived['sk'].startswith(f'{NOW_ISO}#')
        assert (archived['action'], archived['at'], archived['detail']) == ('archived', NOW_ISO, {'reason': reason})
        assert 'actor' not in archived

    def test_a_memory_that_vanished_is_not_archived_and_gets_no_event(self, world):
        ghost = {**store.memory_key(store.COMPANY_PK, 'mem_gone'), 'memory_id': 'mem_gone', 'scope': 'company'}
        assert retention.archive(world.memory, ghost, 'decayed', NOW) is False
        assert _events(world, 'mem_gone') == []

    def test_a_memory_that_vanished_mid_sweep_is_checked_but_not_counted(self, world, monkeypatch):
        _write_decay(world, 'Customers want faster refunds')
        ghost = {**store.memory_key(store.COMPANY_PK, 'mem_gone'), 'memory_id': 'mem_gone', 'scope': 'company',
                 'status': 'active', 'created_at': OLD.isoformat()}
        real = store.query_status

        def query_with_a_ghost(table, scope, status, **kwargs):
            items = real(table, scope, status, **kwargs)
            return [*items, ghost] if (scope, status) == ('company', 'active') else items

        monkeypatch.setattr(store, 'query_status', query_with_a_ghost)
        assert _sweep(world) == {'checked': 2, 'expired': 0, 'decayed': 1}
        assert _events(world, 'mem_gone') == []

    def test_any_other_write_failure_propagates(self, world):
        error = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}},
                            'UpdateItem')
        _write_decay(world, 'Customers want faster refunds')
        with patch.object(store, 'set_fields', side_effect=error), pytest.raises(ClientError) as info:
            _sweep(world)
        assert info.value is error
        memory_id = _by_statement(world)['Customers want faster refunds']['memory_id']
        assert [e['action'] for e in _events(world, memory_id)] == ['created']


# ============================================
# The read
# ============================================

class TestTheSweepReadsOnlyWhatTheDecisionNeeds:
    def test_the_projection_names_exactly_the_decision_attributes(self, world, monkeypatch):
        seen: list[dict[str, Any]] = []
        real_query = world.memory.query

        def spy(**kwargs: Any) -> dict:
            seen.append(kwargs)
            return real_query(**kwargs)

        monkeypatch.setattr(world.memory, 'query', spy)
        _sweep(world)
        assert len(seen) == 6
        for kwargs in seen:
            assert kwargs['ProjectionExpression'] == '#p0, #p1, #p2, #p3, #p4, #p5, #p6, #p7, #p8, #p9'
            assert list(kwargs['ExpressionAttributeNames'].values()) == [
                'pk', 'sk', 'memory_id', 'scope', 'status', 'retention', 'expires_at',
                'created_at', 'last_reinforced_at', 'last_used_at',
            ]

    @pytest.mark.parametrize('stamp', ['created_at', 'last_reinforced_at', 'last_used_at'])
    def test_each_touched_stamp_alone_keeps_a_fresh_memory(self, world, stamp):
        _row(world, 'fresh', **{stamp: NOW_ISO})
        assert _sweep(world) == {'checked': 1, 'expired': 0, 'decayed': 0}

    def test_a_memory_with_no_stamp_at_all_decays(self, world):
        _row(world, 'blank')
        assert _sweep(world) == {'checked': 1, 'expired': 0, 'decayed': 1}


# ============================================
# The handler
# ============================================

class TestTheHandlerWiring:
    def test_a_missing_table_is_a_configuration_error(self, worker_context, monkeypatch):
        monkeypatch.setattr(retention, 'get_memory_table', lambda: None)
        with pytest.raises(RuntimeError) as info:
            retention.lambda_handler({}, worker_context)
        assert str(info.value) == 'MEMORY_TABLE is not configured'

    @pytest.mark.usefixtures('world')
    def test_the_handler_passes_now_and_the_contexts_clock_to_the_sweep(self, worker_context, monkeypatch):
        seen: list[tuple] = []
        monkeypatch.setattr(retention, 'sweep', lambda table, now, clock: seen.append((table, now, clock)) or {
            'checked': 0, 'expired': 0, 'decayed': 0})
        before = datetime.now(UTC)
        assert retention.lambda_handler({}, worker_context) == {'checked': 0, 'expired': 0, 'decayed': 0}
        [(table, now, clock)] = seen
        assert table is store.get_memory_table()
        assert before <= now <= datetime.now(UTC)
        assert now.tzinfo is UTC
        assert clock is worker_context.get_remaining_time_in_millis

    def test_the_metric_is_the_sum_of_both_reasons(self, world, worker_context):
        _seed_two_decayed_one_expired(world)
        with patch.object(metrics, 'add_metric') as add_metric:
            result = retention.lambda_handler({}, worker_context)
        assert result == {'checked': 3, 'expired': 1, 'decayed': 2}
        add_metric.assert_called_once_with(name='MemoriesArchived', unit=MetricUnit.Count, value=3)

    def test_nothing_archived_emits_no_metric(self, world, worker_context):
        _write_decay(world, 'Customers want faster refunds', now=datetime.now(UTC))
        with patch.object(metrics, 'add_metric') as add_metric:
            assert retention.lambda_handler({}, worker_context) == {'checked': 1, 'expired': 0, 'decayed': 0}
        add_metric.assert_not_called()

    def test_the_archived_metric_is_flushed_as_emf_beside_cold_start(self, world, worker_context, capsys):
        _write_decay(world, 'Customers want faster refunds')
        names = cold_start_metric_names(metrics, lambda: retention.lambda_handler({}, worker_context), capsys)
        assert names == {'ColdStart', 'MemoriesArchived'}

    @pytest.mark.usefixtures('world')
    def test_the_lambda_context_reaches_the_logger(self, worker_context):
        # A plain namespace: Powertools reads a MagicMock's auto-created ``lambda_context`` instead.
        context = SimpleNamespace(**{k: getattr(worker_context, k) for k in (
            'function_name', 'memory_limit_in_mb', 'invoked_function_arn', 'aws_request_id',
            'get_remaining_time_in_millis')})
        logger.remove_keys(['function_name'])
        retention.lambda_handler({}, context)
        assert logger.get_current_keys()['function_name'] == 'voc-memory-worker'

    def test_the_handler_is_wrapped_by_logger_tracer_and_metrics_in_that_order(self):
        chain: list[str] = []
        func: Any = retention.lambda_handler
        while func is not None:
            chain.append(os.path.join(*func.__code__.co_filename.split(os.sep)[-2:]))
            func = vars(func).get('__wrapped__')
        assert chain == [os.path.join('logging', 'logger.py'), os.path.join('tracing', 'tracer.py'),
                         os.path.join('provider', 'base.py'), os.path.join('shared', 'invocation_cost.py'),
                         os.path.join('retention', 'handler.py')]
