"""Mutation hardening for `memory/scanner/handler.py`.

`test_scanner_retention.py` drives one schedule tick and one direct enqueue
through moto, which pins the happy paths. A mutation run found what it could
not see:

* THE BOUNDARIES. A session is "ended" strictly after 30 idle minutes and is
  forgotten strictly after 7 days; an in-flight enqueue is presumed lost strictly
  after 120 minutes; a ref or id may be exactly 128 characters; the direct text
  keeps exactly its last 60 000 characters; the scan stops only when fewer than
  20 000 ms remain. Every one is pinned on both sides of the edge, as literals.
* PAGINATION AND PARTIAL SENDS. The scan's second page (`ExclusiveStartKey`),
  the time-budget warning, and SQS's `Failed` entries (only the accepted indexes
  get a cursor, and the warning counts the rest) were never exercised.
* THE WIRE SHAPES. Every queue message, every saved cursor, every handler
  response, every log line and the one metric are compared whole.
* THE WIRING. The two environment variables, the logger/tracer/metrics
  decorators and the configuration guards (`RuntimeError` wording) were unobserved.
"""
from __future__ import annotations

import importlib
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from aws_lambda_powertools.metrics import MetricUnit

from memory.scanner import handler as scanner
from shared import memory_store as store
from shared.logging import logger, metrics, tracer
from shared.test.emf_fixtures import cold_start_metric_names

NOW = datetime(2026, 3, 1, 12, 0, 0, tzinfo=UTC)
NOW_ISO = '2026-03-01T12:00:00+00:00'
PLENTY = 600_000


def _iso(**delta: int) -> str:
    return (NOW - timedelta(**delta)).isoformat()


def _conv(world, session_id: str, *, updated_at: str, count: int = 4, owner: str = 'sub-a') -> None:
    world.conversations.put_item(Item={
        'pk': f'USER#{owner}', 'sk': f'CONV#{session_id}', 'kind': 'assistant',
        'message_count': count, 'updated_at': updated_at,
    })


def _idle(world) -> list[str]:
    return sorted(s['session_id'] for s in scanner.idle_sessions(world.conversations, NOW, lambda: PLENTY))


# ============================================
# Constants are the contract
# ============================================

class TestTheConstantsAreTheContract:
    def test_every_bound_is_pinned(self):
        assert scanner.ASSISTANT_KIND == 'assistant'
        assert scanner.IDLE_MINUTES == 30
        assert scanner.LOOKBACK_DAYS == 7
        assert scanner.REENQUEUE_AFTER_MINUTES == 120
        assert scanner.SAFETY_MARGIN_MS == 20_000
        assert scanner.SQS_BATCH == 10
        assert scanner.USER_PK_PREFIX == 'USER#'
        assert scanner.CONV_SK_PREFIX == 'CONV#'
        assert scanner.DIRECT_KINDS == ('agent_run', 'project_chat')
        assert scanner.MAX_DIRECT_TEXT_CHARS == 60_000
        assert scanner.MAX_REF_CHARS == 128

    def test_the_tables_and_queue_come_from_the_environment(self, monkeypatch):
        try:
            with monkeypatch.context() as env:
                env.setenv('CONVERSATIONS_TABLE', 'conv-from-env')
                env.setenv('MEMORY_EXTRACT_QUEUE_URL', 'https://sqs.test/queue-from-env')
                importlib.reload(scanner)
                assert scanner.CONVERSATIONS_TABLE == 'conv-from-env'
                assert scanner.MEMORY_QUEUE_URL == 'https://sqs.test/queue-from-env'
            with monkeypatch.context() as env:
                env.delenv('CONVERSATIONS_TABLE', raising=False)
                env.delenv('MEMORY_EXTRACT_QUEUE_URL', raising=False)
                importlib.reload(scanner)
                assert scanner.CONVERSATIONS_TABLE == ''
                assert scanner.MEMORY_QUEUE_URL == ''
        finally:
            importlib.reload(scanner)

    def test_the_conversations_table_is_bound_by_name_and_absent_without_one(self, monkeypatch):
        resource = MagicMock()
        monkeypatch.setattr(scanner, 'get_dynamodb_resource', lambda: resource)
        monkeypatch.setattr(scanner, 'CONVERSATIONS_TABLE', 'conv-table')
        assert scanner.get_conversations_table() is resource.Table.return_value
        resource.Table.assert_called_once_with('conv-table')
        monkeypatch.setattr(scanner, 'CONVERSATIONS_TABLE', '')
        assert scanner.get_conversations_table() is None
        resource.Table.assert_called_once()


# ============================================
# idle_sessions: the scan window and its pages
# ============================================

class TestTheScanWindowHasExactEdges:
    def test_a_session_is_ended_strictly_after_thirty_idle_minutes(self, world):
        _conv(world, 'at-thirty', updated_at=_iso(minutes=30))
        _conv(world, 'past-thirty', updated_at=_iso(minutes=30, seconds=1))
        assert _idle(world) == ['past-thirty']

    def test_a_session_is_forgotten_strictly_after_seven_days(self, world):
        _conv(world, 'at-seven-days', updated_at=_iso(days=7))
        _conv(world, 'past-seven-days', updated_at=_iso(days=7, seconds=1))
        assert _idle(world) == ['at-seven-days']

    def test_only_assistant_sessions_count(self, world):
        _conv(world, 'assistant', updated_at=_iso(hours=1))
        world.conversations.put_item(Item={'pk': 'USER#sub-a', 'sk': 'CONV#chat', 'kind': 'chat',
                                           'message_count': 4, 'updated_at': _iso(hours=1)})
        assert _idle(world) == ['assistant']

    def test_a_session_row_is_returned_whole(self, world):
        _conv(world, 's1', updated_at=_iso(hours=1), count=7, owner='owner-1')
        assert scanner.idle_sessions(world.conversations, NOW, lambda: PLENTY) == [
            {'owner_sub': 'owner-1', 'session_id': 's1', 'message_count': 7,
             'updated_at': '2026-03-01T11:00:00+00:00'},
        ]


class TestTheScanFollowsItsPagesWithinTheBudget:
    @staticmethod
    def _two_pages() -> MagicMock:
        table = MagicMock()
        table.scan.side_effect = [
            {'Items': [{'pk': 'USER#a', 'sk': 'CONV#one', 'message_count': 1, 'updated_at': 't1'}],
             'LastEvaluatedKey': {'pk': 'USER#a', 'sk': 'CONV#one'}},
            {'Items': [{'pk': 'USER#b', 'sk': 'CONV#two', 'message_count': 2, 'updated_at': 't2'}]},
        ]
        return table

    def test_the_second_page_starts_where_the_first_ended(self):
        table = self._two_pages()
        sessions = scanner.idle_sessions(table, NOW, lambda: PLENTY)
        assert [s['session_id'] for s in sessions] == ['one', 'two']
        assert table.scan.call_count == 2
        second = table.scan.call_args_list[1].kwargs
        assert second['ExclusiveStartKey'] == {'pk': 'USER#a', 'sk': 'CONV#one'}
        assert second['ProjectionExpression'] == 'pk, sk, message_count, updated_at'
        assert 'ExclusiveStartKey' not in table.scan.call_args_list[0].kwargs

    @pytest.mark.parametrize(('time_left', 'pages'), [(20_000, 2), (19_999, 1)])
    def test_the_next_page_needs_at_least_twenty_seconds(self, time_left, pages):
        table = self._two_pages()
        sessions = scanner.idle_sessions(table, NOW, lambda: time_left)
        assert table.scan.call_count == pages
        assert len(sessions) == pages

    def test_stopping_early_is_logged_once_with_its_reason(self):
        table = self._two_pages()
        with patch.object(logger, 'warning') as warning:
            scanner.idle_sessions(table, NOW, lambda: 0)
        warning.assert_called_once_with(
            'Memory scan stopped on its time budget; the rest is picked up next run')

    def test_a_finished_scan_logs_nothing(self):
        table = self._two_pages()
        with patch.object(logger, 'warning') as warning:
            scanner.idle_sessions(table, NOW, lambda: PLENTY)
        warning.assert_not_called()


# ============================================
# _session_from_row
# ============================================

class TestARowBecomesASessionOnlyWithBothKeyPrefixes:
    @pytest.mark.parametrize('row', [
        {'pk': 'USER#a', 'sk': 'MSG#1'},
        {'pk': 'AGENT#a', 'sk': 'CONV#1'},
        {'pk': 'USER#a'},
        {'sk': 'CONV#1'},
        {},
        {'pk': 1, 'sk': 'CONV#1'},
        {'pk': 'USER#a', 'sk': None},
    ])
    def test_rows_without_both_prefixes_are_skipped(self, row):
        assert scanner._session_from_row(row) is None

    def test_prefixes_are_stripped_and_fields_defaulted(self):
        assert scanner._session_from_row({'pk': 'USER#sub-x', 'sk': 'CONV#conv-y'}) == {
            'owner_sub': 'sub-x', 'session_id': 'conv-y', 'message_count': 0, 'updated_at': '',
        }

    @pytest.mark.parametrize(('raw', 'count'), [(None, 0), ('abc', 0), ('7', 7), (3.9, 3), (0, 0)])
    def test_message_count_is_an_int_or_zero(self, raw, count):
        row = {'pk': 'USER#a', 'sk': 'CONV#1', 'message_count': raw, 'updated_at': 'when'}
        assert scanner._session_from_row(row) == {
            'owner_sub': 'a', 'session_id': '1', 'message_count': count, 'updated_at': 'when',
        }


# ============================================
# needs_extraction
# ============================================

class TestNeedsExtractionEdges:
    @pytest.mark.parametrize(('cursor', 'count', 'expected'), [
        # count 0 is never due, even against a stale cursor
        ({'extracted_count': 5}, 0, False),
        # one message with no cursor is due (the bound is 0, not 1)
        (None, 1, True),
        ({'owner_sub': 'a'}, 1, True),
        # a cursor that matches exactly is not due
        ({'extracted_count': 1}, 1, False),
        # enqueued and extracted at the same instant: nothing in flight
        ({'extracted_count': 2, 'enqueued_at': _iso(minutes=5), 'extracted_at': _iso(minutes=5)}, 4, True),
        # an enqueue later than the last extraction is in flight
        ({'extracted_count': 2, 'enqueued_at': _iso(minutes=5), 'extracted_at': _iso(minutes=6)}, 4, False),
        # presumed lost strictly after 120 minutes
        ({'extracted_count': 2, 'enqueued_at': _iso(minutes=120)}, 4, False),
        ({'extracted_count': 2, 'enqueued_at': _iso(minutes=120, seconds=1)}, 4, True),
        # an unparseable enqueued_at is no enqueue
        ({'extracted_count': 2, 'enqueued_at': 'not-a-date'}, 4, True),
    ])
    def test_boundaries(self, cursor, count, expected):
        assert scanner.needs_extraction({'message_count': count}, cursor, NOW) is expected


# ============================================
# _send_batch
# ============================================

class TestSendBatchReportsExactlyWhatSqsAccepted:
    def _sqs(self, response: dict) -> MagicMock:
        sqs = MagicMock()
        sqs.send_message_batch.return_value = response
        return sqs

    def test_entries_are_indexed_and_all_accepted_without_failures(self, monkeypatch):
        sqs = self._sqs({'Successful': []})
        monkeypatch.setattr(scanner, 'get_sqs_client', lambda: sqs)
        monkeypatch.setattr(scanner, 'MEMORY_QUEUE_URL', 'https://sqs.test/q')
        with patch.object(logger, 'warning') as warning:
            accepted = scanner._send_batch([{'kind': 'session', 'session_id': 'a'}, {'kind': 'session', 'session_id': 'b'}])
        assert accepted == {0, 1}
        sqs.send_message_batch.assert_called_once_with(QueueUrl='https://sqs.test/q', Entries=[
            {'Id': '0', 'MessageBody': '{"kind": "session", "session_id": "a"}'},
            {'Id': '1', 'MessageBody': '{"kind": "session", "session_id": "b"}'},
        ])
        warning.assert_not_called()

    def test_failed_ids_are_removed_and_counted_in_the_warning(self, monkeypatch):
        sqs = self._sqs({'Failed': [{'Id': '1', 'Code': 'x'}, {'Code': 'no-id'}, {'Id': ''}, {'Id': 'abc'}]})
        monkeypatch.setattr(scanner, 'get_sqs_client', lambda: sqs)
        monkeypatch.setattr(scanner, 'MEMORY_QUEUE_URL', 'https://sqs.test/q')
        with patch.object(logger, 'warning') as warning:
            accepted = scanner._send_batch([{'n': 0}, {'n': 1}, {'n': 2}])
        assert accepted == {0, 2}
        warning.assert_called_once_with('Some memory messages were not accepted by SQS', extra={'failed': 1})


# ============================================
# scan_and_enqueue
# ============================================

class TestScanAndEnqueueRefusesToRunUnconfigured:
    @pytest.mark.usefixtures('world')
    @pytest.mark.parametrize('break_it', ['conversations', 'memory', 'queue'])
    def test_each_missing_piece_raises_the_same_error(self, monkeypatch, break_it):
        if break_it == 'conversations':
            monkeypatch.setattr(scanner, 'get_conversations_table', lambda: None)
        elif break_it == 'memory':
            monkeypatch.setattr(scanner, 'get_memory_table', lambda: None)
        else:
            monkeypatch.setattr(scanner, 'MEMORY_QUEUE_URL', '')
        with pytest.raises(RuntimeError, match=r'^memory scanner is not configured$'):
            scanner.scan_and_enqueue(NOW, lambda: PLENTY)

    @pytest.mark.usefixtures('world')
    def test_the_memory_table_is_the_stores(self):
        assert scanner.get_memory_table() is store.get_memory_table()


class TestScanAndEnqueueWritesOneCursorPerAcceptedSession:
    def test_two_due_sessions_count_two_and_stamp_both_cursors(self, world):
        _conv(world, 's1', updated_at=_iso(hours=1), owner='o1')
        _conv(world, 's2', updated_at=_iso(hours=2), owner='o2')
        with patch.object(metrics, 'add_metric') as add_metric:
            result = scanner.scan_and_enqueue(NOW, lambda: PLENTY)
        assert result == {'scanned': 2, 'enqueued': 2}
        assert sorted(world.queued(), key=lambda m: m['session_id']) == [
            {'kind': 'session', 'session_id': 's1', 'owner_sub': 'o1'},
            {'kind': 'session', 'session_id': 's2', 'owner_sub': 'o2'},
        ]
        for session_id, owner in (('s1', 'o1'), ('s2', 'o2')):
            assert world.memory.get_item(Key=store.cursor_key(session_id))['Item'] == {
                'pk': 'MEMCURSOR', 'sk': f'SESSION#{session_id}', 'owner_sub': owner,
                'enqueued_at': NOW_ISO, 'updated_at': NOW_ISO,
            }
        add_metric.assert_called_once_with(name='MemorySessionsEnqueued', unit=MetricUnit.Count, value=2)

    def test_nothing_due_emits_no_metric(self, world):
        _conv(world, 'active', updated_at=_iso(minutes=1))
        with patch.object(metrics, 'add_metric') as add_metric:
            assert scanner.scan_and_enqueue(NOW, lambda: PLENTY) == {'scanned': 0, 'enqueued': 0}
        add_metric.assert_not_called()

    def test_only_accepted_sessions_get_a_cursor(self, world, monkeypatch):
        _conv(world, 'kept', updated_at=_iso(hours=1))
        _conv(world, 'lost', updated_at=_iso(hours=2))
        sent: list[list[dict]] = []

        def send(messages: list[dict]) -> set[int]:
            sent.append(messages)
            return {i for i, m in enumerate(messages) if m['session_id'] == 'kept'}

        monkeypatch.setattr(scanner, '_send_batch', send)
        assert scanner.scan_and_enqueue(NOW, lambda: PLENTY) == {'scanned': 2, 'enqueued': 1}
        assert len(sent) == 1
        assert 'Item' in world.memory.get_item(Key=store.cursor_key('kept'))
        assert 'Item' not in world.memory.get_item(Key=store.cursor_key('lost'))

    def test_sessions_are_sent_in_batches_of_ten(self, world, monkeypatch):
        for i in range(11):
            _conv(world, f's{i:02d}', updated_at=_iso(hours=1))
        sizes: list[int] = []

        def send(messages: list[dict]) -> set[int]:
            sizes.append(len(messages))
            return set(range(len(messages)))

        monkeypatch.setattr(scanner, '_send_batch', send)
        assert scanner.scan_and_enqueue(NOW, lambda: PLENTY) == {'scanned': 11, 'enqueued': 11}
        assert sizes == [10, 1]


# ============================================
# Direct enqueue
# ============================================

class TestDirectMessageIsValidatedAndBounded:
    def test_project_chat_is_accepted_with_both_optional_ids_stripped(self):
        assert scanner.direct_message({
            'kind': 'project_chat', 'ref': 'proj_1', 'text': 'hello',
            'owner_sub': '  sub-1  ', 'agent_id': ' ag-1 ', 'extra': 'dropped',
        }) == {'kind': 'project_chat', 'ref': 'proj_1', 'text': 'hello', 'owner_sub': 'sub-1', 'agent_id': 'ag-1'}

    @pytest.mark.parametrize('event', [
        {'kind': 'session', 'ref': 'r', 'text': 't'},
        {'kind': 'XXproject_chatXX', 'ref': 'r', 'text': 't'},
        {'ref': 'r', 'text': 't'},
        {'kind': 'agent_run', 'ref': 'x' * 129, 'text': 't'},
        {'kind': 'agent_run', 'ref': 7, 'text': 't'},
        {'kind': 'agent_run', 'ref': 'r', 'text': 7},
        {'kind': 'agent_run', 'ref': 'r'},
    ])
    def test_rejections(self, event):
        assert scanner.direct_message(event) is None

    @pytest.mark.parametrize('ref', ['r', 'x' * 128])
    def test_a_ref_of_one_to_128_characters_is_accepted(self, ref):
        assert scanner.direct_message({'kind': 'agent_run', 'ref': ref, 'text': 't'}) == {
            'kind': 'agent_run', 'ref': ref, 'text': 't'}

    @pytest.mark.parametrize('optional', ['owner_sub', 'agent_id'])
    def test_an_optional_id_is_kept_at_128_and_dropped_at_129_or_blank_or_non_string(self, optional):
        base = {'kind': 'agent_run', 'ref': 'r', 'text': 't'}
        assert scanner.direct_message({**base, optional: 'x' * 128}) == {**base, optional: 'x' * 128}
        assert scanner.direct_message({**base, optional: 'x' * 129}) == base
        assert scanner.direct_message({**base, optional: '   '}) == base
        assert scanner.direct_message({**base, optional: 5}) == base

    def test_text_keeps_exactly_its_last_sixty_thousand_characters(self):
        message = scanner.direct_message({'kind': 'agent_run', 'ref': 'r', 'text': 'HEAD' + 'x' * 60_000})
        assert message is not None
        assert message['text'] == 'x' * 60_000
        whole = scanner.direct_message({'kind': 'agent_run', 'ref': 'r', 'text': 'y' * 60_000})
        assert whole is not None
        assert whole['text'] == 'y' * 60_000


class TestEnqueueDirect:
    def test_a_malformed_event_is_logged_and_counts_zero_without_touching_sqs(self, world):
        with patch.object(logger, 'warning') as warning:
            assert scanner.enqueue_direct({'kind': 'agent_run', 'ref': '', 'text': 'x'}) == {'enqueued': 0}
        warning.assert_called_once_with('Rejected a malformed direct memory enqueue')
        assert world.queued() == []

    def test_a_valid_event_is_sent_as_json_to_the_configured_queue(self, monkeypatch):
        sqs = MagicMock()
        monkeypatch.setattr(scanner, 'get_sqs_client', lambda: sqs)
        monkeypatch.setattr(scanner, 'MEMORY_QUEUE_URL', 'https://sqs.test/q')
        with patch.object(logger, 'warning') as warning:
            assert scanner.enqueue_direct({'kind': 'project_chat', 'ref': 'p1', 'text': 'hi'}) == {'enqueued': 1}
        sqs.send_message.assert_called_once_with(
            QueueUrl='https://sqs.test/q', MessageBody=json.dumps({'kind': 'project_chat', 'ref': 'p1', 'text': 'hi'}))
        warning.assert_not_called()

    def test_without_a_queue_a_valid_event_raises(self, monkeypatch):
        sqs = MagicMock()
        monkeypatch.setattr(scanner, 'get_sqs_client', lambda: sqs)
        monkeypatch.setattr(scanner, 'MEMORY_QUEUE_URL', '')
        with pytest.raises(RuntimeError, match=r'^MEMORY_QUEUE_URL is not configured$'):
            scanner.enqueue_direct({'kind': 'agent_run', 'ref': 'r', 'text': 't'})
        sqs.send_message.assert_not_called()


# ============================================
# The Lambda entry point: routing and the three decorators
# ============================================

class TestLambdaHandlerRoutesAndIsWrapped:
    @pytest.mark.parametrize('event', [{'source': 'aws.events'}, {}, 'not-a-dict', {'kind': 'session'}, None])
    def test_anything_but_a_direct_kind_is_a_scan(self, world, worker_context, event):
        _conv(world, 'ended', updated_at=(datetime.now(UTC) - timedelta(hours=1)).isoformat())
        assert scanner.lambda_handler(event, worker_context) == {'scanned': 1, 'enqueued': 1}

    @pytest.mark.usefixtures('world')
    def test_a_scan_passes_the_clock_and_the_contexts_remaining_time(self, worker_context, monkeypatch):
        seen: list[tuple[datetime, Callable[[], int]]] = []

        def scan(now: datetime, time_left_ms: Callable[[], int]) -> dict[str, int]:
            seen.append((now, time_left_ms))
            return {'scanned': 0, 'enqueued': 0}

        monkeypatch.setattr(scanner, 'scan_and_enqueue', scan)
        before = datetime.now(UTC)
        scanner.lambda_handler({}, worker_context)
        [(now, time_left_ms)] = seen
        assert before <= now <= datetime.now(UTC)
        assert now.tzinfo is UTC
        assert time_left_ms is worker_context.get_remaining_time_in_millis

    @pytest.mark.parametrize('kind', ['agent_run', 'project_chat'])
    def test_a_direct_kind_is_enqueued_not_scanned(self, world, worker_context, kind):
        _conv(world, 'ended', updated_at=(datetime.now(UTC) - timedelta(hours=1)).isoformat())
        assert scanner.lambda_handler({'kind': kind, 'ref': 'r1', 'text': 'body'}, worker_context) == {'enqueued': 1}
        assert world.queued() == [{'kind': kind, 'ref': 'r1', 'text': 'body'}]

    @pytest.mark.usefixtures('world')
    def test_the_lambda_context_reaches_the_logger(self):
        context = SimpleNamespace(
            function_name='voc-memory-scanner', memory_limit_in_mb=512,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-memory-scanner',
            aws_request_id='req-1', get_remaining_time_in_millis=lambda: PLENTY,
        )
        logger.remove_keys(['function_name', 'cold_start'])
        scanner.lambda_handler({}, context)
        assert logger.get_current_keys()['function_name'] == 'voc-memory-scanner'

    @pytest.mark.usefixtures('world')
    def test_the_cold_start_metric_is_flushed_as_emf(self, worker_context, capsys):
        names = cold_start_metric_names(metrics, lambda: scanner.lambda_handler({}, worker_context), capsys)
        assert names == {'ColdStart'}

    def test_the_handler_is_registered_with_the_tracer(self):
        try:
            with patch.object(tracer, 'capture_lambda_handler', side_effect=lambda f: f) as capture:
                importlib.reload(scanner)
            wrapped = vars(scanner.lambda_handler)['__wrapped__']
            assert capture.call_args_list == [call(wrapped)]
            assert wrapped.__name__ == 'lambda_handler'
        finally:
            importlib.reload(scanner)
