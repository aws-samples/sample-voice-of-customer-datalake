"""A workspace's erasure finds its items by index, no Scan of voc-feedback but two fallbacks (TENETS.md D5; 7.96.00).

A job that names a workspace (``workspace_id``, test_named_workspace_erasure.py) reads that workspace's own index
partitions only, for their keys: by ``source_id`` (with its source) one Query of ``gsi4-by-feedback-id`` at
``WS#{ws}#FEEDBACK#{feedback_item_id(source, source_id)}``; by ``author``, ``csv_row_id`` or ``email`` the
``gsi1-by-date`` day walk the category reprocess built (7.94.00), one Query per ``WS#{ws}#DATE#{day}`` from the day
before the workspace's ``META`` ``created_at`` to today UTC, its cursor ``{day, start}`` handed over. Each Query
filters on the index with the Scan's own filter (``erase_filter``) and returns the keys alone; each hit is decided on
the row as a strongly consistent read of the table returns it, and only a row that still matches
(``shared/retention.py`` ``erase_matches``, the Python twin of ``erase_filter``) is tombstoned and deleted (the delete
itself is unconditioned, as with the Scan). A workspace
whose ``META`` names no ``created_at`` keeps the Scan (logged, counted ``workspace_item_scans``), and so does a job
handed over with a Scan cursor before this release. The deployment's erasures Scan as before.
"""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Self
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import ConditionExpressionBuilder

from jobs.retention import handler
from jobs.retention.copies import ItemDeleter
from jobs.retention.test.conftest import days_ago, erasure_rows, put_feedback
from jobs.retention.test.test_named_workspace_erasure import _audit, _job, _job_row
from jobs.retention.test.test_workspace_erasure import WS, WS_TWO, _items, _tombstones, put_workspace_feedback
from shared import retention
from shared.feedback_keys import feedback_item_id
from shared.indexes import FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_DATE_POSITION, FEEDBACK_BY_ID_INDEX
from shared.ws_repo import WorkspaceScope, WorkspaceTable

JANE = 'Jane Doe'
JANE_EMAIL = 'jane@example.com'
SCAN_COUNTER = 'workspace_item_scans'
REPO = Path(__file__).resolve().parents[5]


def _meta(aws, ws: str = WS, created_days_ago: int | None = 5) -> None:
    """The workspace's ``META`` (voc-workspaces ``WS#{ws}`` / ``META``), created ``created_days_ago`` days ago at 00:30
    UTC (None: a row with no ``created_at``)."""
    row: dict[str, Any] = {'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active'}
    if created_days_ago is not None:
        day = datetime.now(UTC).date() - timedelta(days=created_days_ago)
        row['created_at'] = f'{day.isoformat()}T00:30:00+00:00'
    aws['workspaces'].put_item(Item=row)


def _put(aws, ws: str, source: str, source_id: str, day: str | None = None, **extra: Any) -> tuple[str, str]:
    """One workspace review as the processor stores it (lambda/processor/handler.py ``build_feedback_item``): its id
    from its source and source id, filed under the day it was processed in gsi1 and under its id in gsi4."""
    day = day or days_ago(1)
    feedback_id = feedback_item_id(source, source_id)
    put_workspace_feedback(aws, ws, feedback_id, source, source_id=source_id, date=day,
                           gsi1pk=f'WS#{ws}#DATE#{day}', gsi1sk=f'{day}T10:00:00+00:00#{feedback_id}',
                           gsi4pk=f'WS#{ws}#FEEDBACK#{feedback_id}', **extra)
    return f'WS#{ws}#SOURCE#{source}', f'FEEDBACK#{feedback_id}'


def _put_deployment(aws, source: str, source_id: str, **extra: Any) -> tuple[str, str]:
    """The deployment's copy of the same review, with its own (unprefixed) index keys."""
    day = days_ago(1)
    feedback_id = feedback_item_id(source, source_id)
    put_feedback(aws, feedback_id, source, source_id=source_id, gsi1pk=f'DATE#{day}',
                 gsi1sk=f'{day}T10:00:00+00:00#{feedback_id}', gsi4pk=f'FEEDBACK#{feedback_id}', **extra)
    return f'SOURCE#{source}', f'FEEDBACK#{feedback_id}'


def _in_three_scopes(aws, source: str, source_id: str, **extra: Any) -> dict[str, tuple[str, str]]:
    _meta(aws, WS)
    _meta(aws, WS_TWO)
    return {'ws': _put(aws, WS, source, source_id, **extra), 'other': _put(aws, WS_TWO, source, source_id, **extra),
            'deployment': _put_deployment(aws, source, source_id, **extra)}


def _no_scan() -> Any:
    return patch.object(handler, '_scan_page', side_effect=AssertionError('a workspace erasure scanned voc-feedback'))


class _IndexQueries:
    """Every Query the run sends to a voc-feedback index through the workspace layer: (index, partition, kwargs)."""

    def __init__(self, after: Any = None) -> None:
        self.sent: list[tuple[str, str, dict[str, Any]]] = []
        self._after = after
        self._real = WorkspaceTable.query

    def __enter__(self) -> Self:
        record = self

        def query(view: WorkspaceTable, attribute: str, partition: str, **kwargs: Any) -> dict:
            answer = record._real(view, attribute, partition, **kwargs)
            if kwargs.get('IndexName') in (FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_ID_INDEX):
                record.sent.append((kwargs['IndexName'], partition, kwargs))
                if record._after is not None:
                    record._after(answer)
            return answer

        self._patch = patch.object(WorkspaceTable, 'query', query)
        self._patch.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._patch.stop()


class TestEachFieldIsFoundByIndex:
    def test_by_source_id_one_query_of_its_id_partition(self, aws, worker_context):
        keys = _in_three_scopes(aws, 'tickets', '12345')
        web = _put(aws, WS, 'web', '12345')

        with _no_scan(), _IndexQueries() as queries:
            result = handler.handle_event(_job(aws, 'source_id', '12345', source='tickets'), worker_context)

        assert result['status'] == 'completed'
        assert _items(aws) == {keys['other'], keys['deployment'], web}
        assert (result['deleted_items'], result['deleted_workspace_items']) == (1, 1)
        assert set(_tombstones(aws, 'tickets')) == {f'{WS}#{feedback_item_id("tickets", "12345")}'}
        assert [(index, partition) for index, partition, _ in queries.sent] == [
            (FEEDBACK_BY_ID_INDEX, f'WS#{WS}#FEEDBACK#{feedback_item_id("tickets", "12345")}')]
        assert SCAN_COUNTER not in result

    def test_by_author_the_day_walk_in_every_source(self, aws, worker_context):
        keys = _in_three_scopes(aws, 'tickets', 't1', author=JANE)
        web = _put(aws, WS, 'web', 'w1', author=JANE)
        john = _put(aws, WS, 'web', 'w2', author='John Roe')

        with _no_scan(), _IndexQueries() as queries:
            result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert result['status'] == 'completed'
        assert not {keys['ws'], web} & _items(aws)
        assert {keys['other'], keys['deployment'], john} <= _items(aws)
        assert result['deleted_workspace_items'] == 2
        # One Query a day, from the day before created_at (5 days ago) to today: 7 days.
        days = [partition for index, partition, _ in queries.sent if index == FEEDBACK_BY_DATE_INDEX]
        assert days == [f'WS#{WS}#DATE#{days_ago(n)}' for n in range(6, -1, -1)]

    def test_by_csv_row_within_its_source(self, aws, worker_context):
        keys = _in_three_scopes(aws, 'tickets', 'c1', csv_row_id='row-7')
        web = _put(aws, WS, 'web', 'c2', csv_row_id='row-7')

        with _no_scan():
            result = handler.handle_event(_job(aws, 'csv_row_id', 'row-7', source='tickets'), worker_context)

        assert result['deleted_workspace_items'] == 1
        assert _items(aws) == {keys['other'], keys['deployment'], web}

    def test_by_email_both_spellings_and_both_fields(self, aws, worker_context):
        _meta(aws)
        lower = _put(aws, WS, 'web', 'e1', metadata={'email': JANE_EMAIL})
        typed = _put(aws, WS, 'web', 'e2', metadata={'submitter_email': 'Jane@Example.com'})
        shouted = _put(aws, WS, 'web', 'e3', metadata={'email': 'JANE@EXAMPLE.COM'})
        other = _put(aws, WS_TWO, 'web', 'e1', metadata={'email': JANE_EMAIL})
        deployment = _put_deployment(aws, 'web', 'e1', metadata={'email': JANE_EMAIL})

        with _no_scan():
            result = handler.handle_event(_job(aws, 'email', 'Jane@Example.com'), worker_context)

        assert result['status'] == 'completed'
        assert result['deleted_workspace_items'] == 2
        assert not {lower, typed} & _items(aws)
        # As the Scan's filter: the value as typed or lower-cased, no other spelling.
        assert {shouted, other, deployment} <= _items(aws)

    def test_items_across_days_are_each_found(self, aws, worker_context):
        _meta(aws, created_days_ago=5)
        found = [_put(aws, WS, 'web', f'd{n}', day=days_ago(n), author=JANE) for n in (6, 3, 0)]

        with _no_scan():
            result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert result['deleted_workspace_items'] == 3
        assert not set(found) & _items(aws)

    def test_the_index_reads_keys_only_and_filters_on_the_erasure(self, aws, worker_context):
        """Keys only returned, and the Scan's own filter (``erase_filter`` in the workspace) on the index: both
        indexes project every attribute, so the index can rule a row out before it is read again."""
        _meta(aws)
        _put(aws, WS, 'tickets', 's1', author=JANE)

        with _IndexQueries() as queries:
            handler.handle_event(_job(aws, 'author', JANE), worker_context)
            by_author = list(queries.sent)
        with _IndexQueries() as queries:
            _put(aws, WS, 'tickets', 's2')
            handler.handle_event(_job(aws, 'source_id', 's2', source='tickets'), worker_context)
            by_id = list(queries.sent)

        scope = WorkspaceScope(WS)
        expected = {'author': retention.erase_filter('author', JANE, None, retention.STORE_FEEDBACK, scope),
                    'source_id': retention.erase_filter('source_id', 's2', 'tickets', retention.STORE_FEEDBACK, scope)}
        assert by_author
        assert by_id
        for field, sent in (('author', by_author), ('source_id', by_id)):
            for index, _partition, kwargs in sent:
                keys = {FEEDBACK_BY_DATE_INDEX: FEEDBACK_BY_DATE_POSITION, FEEDBACK_BY_ID_INDEX: ('pk', 'sk', 'gsi4pk')}
                assert kwargs['Select'] == 'SPECIFIC_ATTRIBUTES'
                assert [name.strip() for name in kwargs['ProjectionExpression'].split(',')] == list(keys[index])
                # A builder of its own each (its placeholders count up across calls).
                assert ConditionExpressionBuilder().build_expression(kwargs['FilterExpression']) == \
                    ConditionExpressionBuilder().build_expression(expected[field])

    @pytest.mark.parametrize('field', ['author', 'source_id'])
    def test_a_row_the_index_filter_rules_out_is_never_read_again(self, aws, worker_context, field):
        """Only the index's hits are read from the table: a review of another author (or another source with the same
        source id) costs no GetItem."""
        _meta(aws)
        jane = _put(aws, WS, 'tickets', '12345', author=JANE)
        others = [_put(aws, WS, 'web', '12345', author='John Roe'), _put(aws, WS, 'tickets', '999', author='John Roe')]
        real = WorkspaceTable.get_item
        reads: list[tuple[str, str]] = []

        def get_item(view: WorkspaceTable, item_key: Any, **kwargs: Any) -> dict:
            reads.append((str(item_key.get('pk')), str(item_key.get('sk'))))
            return real(view, item_key, **kwargs)

        job = _job(aws, 'author', JANE) if field == 'author' else _job(aws, 'source_id', '12345', source='tickets')
        with _no_scan(), patch.object(WorkspaceTable, 'get_item', get_item):
            result = handler.handle_event(job, worker_context)

        assert (result['status'], result['deleted_workspace_items']) == ('completed', 1)
        assert jane in reads
        assert not set(others) & set(reads)
        assert set(others) <= _items(aws)

    def test_each_hit_is_read_again_strongly_consistent(self, aws, worker_context):
        _meta(aws)
        key = _put(aws, WS, 'web', 'r1', author=JANE)
        real = WorkspaceTable.get_item
        reads: list[tuple[dict, dict]] = []

        def get_item(view: WorkspaceTable, item_key: Any, **kwargs: Any) -> dict:
            reads.append((dict(item_key), kwargs))
            return real(view, item_key, **kwargs)

        with patch.object(WorkspaceTable, 'get_item', get_item):
            handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert ({'pk': key[0], 'sk': key[1]}, {'ConsistentRead': True}) in reads


class TestEachHitIsDecidedOnTheTablesRow:
    """The index answers eventually consistent: a row that passed its filter is a candidate only, decided by the row
    as a strongly consistent read of the table returns it (a row that matches on the index but no longer on the table
    is left)."""

    @staticmethod
    def _after_the_first_query(change: Any) -> Any:
        done: list[bool] = []

        def after(_answer: dict) -> None:
            if not done:
                done.append(True)
                change()

        return after

    def test_a_row_whose_author_changed_is_left_untombstoned(self, aws, worker_context):
        _meta(aws, created_days_ago=0)
        key = _put(aws, WS, 'web', 's1', author=JANE, day=days_ago(0))
        renamed = self._after_the_first_query(lambda: aws['feedback'].update_item(
            Key={'pk': key[0], 'sk': key[1]}, UpdateExpression='SET author = :a',
            ExpressionAttributeValues={':a': 'John Roe'}))

        with _no_scan(), _IndexQueries(after=lambda answer: renamed(answer) if answer.get('Items') else None):
            result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert result['status'] == 'completed'
        assert key in _items(aws)
        assert _tombstones(aws, 'web') == {}
        assert result['deleted_items'] == 0

    def test_a_row_deleted_meanwhile_is_skipped(self, aws, worker_context):
        _meta(aws, created_days_ago=0)
        key = _put(aws, WS, 'web', 's1', author=JANE, day=days_ago(0))
        gone = self._after_the_first_query(lambda: aws['feedback'].delete_item(Key={'pk': key[0], 'sk': key[1]}))

        with _no_scan(), _IndexQueries(after=lambda answer: gone(answer) if answer.get('Items') else None):
            result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert (result['status'], result['deleted_items']) == ('completed', 0)
        assert _tombstones(aws, 'web') == {}

    def test_an_id_hit_whose_source_changed_is_left(self, aws, worker_context):
        _meta(aws)
        key = _put(aws, WS, 'tickets', '12345')
        moved = self._after_the_first_query(lambda: aws['feedback'].update_item(
            Key={'pk': key[0], 'sk': key[1]}, UpdateExpression='SET source_platform = :s',
            ExpressionAttributeValues={':s': 'web'}))

        with _no_scan(), _IndexQueries(after=moved):
            result = handler.handle_event(_job(aws, 'source_id', '12345', source='tickets'), worker_context)

        assert (result['status'], result['deleted_items']) == ('completed', 0)
        assert key in _items(aws)
        assert (_tombstones(aws, 'tickets'), _tombstones(aws, 'web')) == ({}, {})


class TestAHandOverResumesTheWalk:
    @pytest.mark.usefixtures('three_a_page')
    def test_mid_day_it_goes_on_right_after_the_last_item_erased(self, aws, worker_context, invoke_mock):
        _meta(aws)
        names = [_put(aws, WS, 'web', f'm{n}', author=JANE) for n in range(5)]
        deleted: list[Any] = []
        real = ItemDeleter.delete
        handed: list[bool] = []

        def delete(deleter: ItemDeleter, item: Any, store: str) -> None:
            deleted.append((item['pk'], item['sk']))
            real(deleter, item, store)

        worker_context.get_remaining_time_in_millis.side_effect = (
            lambda: 0 if len(deleted) == 2 and not handed else 900_000)
        with _no_scan(), patch.object(ItemDeleter, 'delete', delete):
            first = handler.handle_event(_job(aws, 'author', JANE), worker_context)
            handed.append(True)
            payload = invoke_mock.call_args.args[1]
            second = handler.handle_event(payload, worker_context)

        assert first['status'] == 'continued'
        assert (payload['phase'], payload['cursor']['day']) == ('items', days_ago(1))
        assert set(payload['cursor']['start']) == set(FEEDBACK_BY_DATE_POSITION)
        assert second['status'] == 'completed'
        # Each item erased once, none skipped.
        assert sorted(deleted) == sorted(names)
        assert second['deleted_workspace_items'] == 5

    def test_across_days_each_invocation_goes_on_from_its_cursor(self, aws, worker_context, invoke_mock):
        _meta(aws, created_days_ago=3)
        names = [_put(aws, WS, 'web', f'x{n}', day=days_ago(n), author=JANE) for n in (4, 2, 0)]
        cursors: list[Any] = []
        event = _job(aws, 'author', JANE)
        result: dict[str, Any] = {'status': 'not run'}
        with _no_scan(), patch.object(handler, 'MAX_PAGES', 1):
            for _ in range(40):
                result = handler.handle_event(event, worker_context)
                if result['status'] != 'continued':
                    break
                event = invoke_mock.call_args.args[1]
                if event['phase'] == 'items':
                    cursors.append(event['cursor'])

        assert result['status'] == 'completed'
        assert not set(names) & _items(aws)
        assert [cursor['day'] for cursor in cursors] == [days_ago(n) for n in range(3, -1, -1)]
        assert result['deleted_workspace_items'] == 3

    @staticmethod
    def _sharing_one_id(aws, count: int) -> list[tuple[str, str]]:
        """``count`` rows of one source id on one gsi4 partition (the review and copies of it under other ids), and
        the same source id in another source (not this job's)."""
        _meta(aws)
        rows = [_put(aws, WS, 'tickets', '12345')]
        partition = f'WS#{WS}#FEEDBACK#{feedback_item_id("tickets", "12345")}'
        for n in range(count - 1):
            put_workspace_feedback(aws, WS, f'copy-{n}', 'tickets', source_id='12345', gsi4pk=partition)
            rows.append((f'WS#{WS}#SOURCE#tickets', f'FEEDBACK#copy-{n}'))
        return rows

    @pytest.mark.usefixtures('three_a_page')
    def test_by_id_mid_page_it_goes_on_right_after_the_last_item_erased(self, aws, worker_context, invoke_mock):
        rows = self._sharing_one_id(aws, 5)
        web = _put(aws, WS, 'web', '12345')
        deleted: list[Any] = []
        real = ItemDeleter.delete
        handed: list[bool] = []

        def delete(deleter: ItemDeleter, item: Any, store: str) -> None:
            deleted.append((item['pk'], item['sk']))
            real(deleter, item, store)

        worker_context.get_remaining_time_in_millis.side_effect = (
            lambda: 0 if len(deleted) == 2 and not handed else 900_000)
        with _no_scan(), patch.object(ItemDeleter, 'delete', delete):
            first = handler.handle_event(_job(aws, 'source_id', '12345', source='tickets'), worker_context)
            handed.append(True)
            payload = invoke_mock.call_args.args[1]
            second = handler.handle_event(payload, worker_context)

        assert first['status'] == 'continued'
        assert payload['phase'] == 'items'
        assert set(payload['cursor']) == {'id_start'}
        assert set(payload['cursor']['id_start']) == {'pk', 'sk', 'gsi4pk'}
        assert second['status'] == 'completed'
        # Each item erased once, none skipped, the other source's left.
        assert sorted(deleted) == sorted(rows)
        assert second['deleted_workspace_items'] == 5
        assert web in _items(aws)

    def test_by_id_each_page_hand_over_goes_on_from_its_cursor(self, aws, worker_context, invoke_mock):
        rows = self._sharing_one_id(aws, 5)
        cursors: list[Any] = []
        event = _job(aws, 'source_id', '12345', source='tickets')
        result: dict[str, Any] = {'status': 'not run'}
        with _no_scan(), patch.object(handler, 'MAX_PAGES', 1), patch.object(handler, 'PAGE_SIZE', 2):
            for _ in range(40):
                result = handler.handle_event(event, worker_context)
                if result['status'] != 'continued':
                    break
                event = invoke_mock.call_args.args[1]
                if event['phase'] == 'items':
                    cursors.append(event['cursor'])

        assert result['status'] == 'completed'
        assert not set(rows) & _items(aws)
        # Pages of two: hand-overs after the first and the second page, each from the index's own key.
        assert len(cursors) >= 2
        assert all(set(cursor) == {'id_start'} for cursor in cursors)
        assert len({tuple(sorted(cursor['id_start'].items())) for cursor in cursors}) == len(cursors)
        assert result['deleted_workspace_items'] == 5


class TestFallbacksKeepTheScan:
    def test_a_workspace_with_no_created_at_scans_logged_and_counted(self, aws, worker_context):
        _meta(aws, created_days_ago=None)
        key = _put(aws, WS, 'web', 'n1', author=JANE)

        with patch('jobs.retention.item_walk.logger') as logger, \
                patch.object(handler, '_scan_page', wraps=handler._scan_page) as scans:
            result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert result['status'] == 'completed'
        assert key not in _items(aws)
        assert scans.call_count >= 1
        assert result[SCAN_COUNTER] == 1
        assert (_job_row(aws)[SCAN_COUNTER], _audit(aws)[SCAN_COUNTER]) == (1, 1)
        assert logger.warning.call_count == 1

    def test_no_workspaces_table_scans_with_its_own_warning(self):
        """voc-workspaces not configured is told apart from a META with no creation time (both Scan, counted)."""
        from jobs.retention import item_walk

        run: dict[str, Any] = {'job_id': 'j1', 'field': 'author'}
        with patch('jobs.retention.item_walk.logger') as logger:
            walk = item_walk.index_walk(run, JANE, object(), None, WorkspaceScope(WS), None,
                                        datetime.now(UTC).date(), 3)

        assert walk is None
        assert run[SCAN_COUNTER] == 1
        (message,), _kwargs = logger.warning.call_args
        assert 'not configured' in message
        assert 'creation time' not in message

    def test_a_job_handed_over_with_a_scan_cursor_finishes_with_the_scan(self, aws, worker_context):
        _meta(aws)
        _put(aws, WS, 'web', 'o1', author=JANE)
        before = _put_deployment(aws, 'web', 'o0')
        event = {**_job(aws, 'author', JANE), 'phase': 'items', 'cursor': {'pk': before[0], 'sk': before[1]}}

        with patch.object(handler, '_scan_page', wraps=handler._scan_page) as scans, _IndexQueries() as queries:
            result = handler.handle_event(event, worker_context)

        assert result['status'] == 'completed'
        assert scans.call_args_list[0].args[2] == {'pk': before[0], 'sk': before[1]}
        assert queries.sent == []
        assert SCAN_COUNTER not in result

    def test_a_source_id_job_without_its_source_walks_the_days(self, aws, worker_context):
        """A row written before the route required the source: no id key to build, so the day walk (never a Scan)."""
        _meta(aws)
        key = _put(aws, WS, 'tickets', '777')

        with _no_scan():
            result = handler.handle_event(_job(aws, 'source_id', '777'), worker_context)

        assert result['deleted_workspace_items'] == 1
        assert key not in _items(aws)

    def test_an_item_with_no_day_key_is_not_reached_by_the_walk(self, aws, worker_context):
        """The walk's one blind spot (TENETS.md D5's gaps): a review with no gsi1pk is on no day partition."""
        _meta(aws)
        put_workspace_feedback(aws, WS, 'nd1', 'web', author=JANE)
        aws['feedback'].update_item(Key={'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#nd1'},
                                    UpdateExpression='REMOVE gsi1pk')

        with _no_scan():
            result = handler.handle_event(_job(aws, 'author', JANE), worker_context)

        assert (result['status'], result['deleted_items']) == ('completed', 0)


class TestTheDeploymentStillScans:
    def test_its_author_erasure_scans_exactly_as_before(self, aws, worker_context):
        _in_three_scopes(aws, 'tickets', 'a1', author=JANE)

        with patch.object(handler, '_scan_page', wraps=handler._scan_page) as scans, _IndexQueries() as queries:
            result = handler.handle_event(_job(aws, 'author', JANE, source='tickets', ws=None), worker_context)

        assert result['status'] == 'completed'
        assert queries.sent == []
        table, condition, cursor = scans.call_args_list[0].args
        assert (table.name, cursor) == (handler.FEEDBACK_TABLE, None)
        expected = retention.erase_filter('author', JANE, 'tickets', retention.STORE_FEEDBACK)
        # A builder of its own each (its placeholders count up across calls).
        assert ConditionExpressionBuilder().build_expression(condition) == \
            ConditionExpressionBuilder().build_expression(expected)

    def test_its_email_erasure_still_reaches_every_workspace_by_its_scan(self, aws, worker_context):
        keys = _in_three_scopes(aws, 'web', 'e1', metadata={'email': JANE_EMAIL})

        with patch.object(handler, '_scan_page', wraps=handler._scan_page) as scans, _IndexQueries() as queries:
            result = handler.handle_event(_job(aws, 'email', JANE_EMAIL, ws=None), worker_context)

        assert result['status'] == 'completed'
        assert not set(keys.values()) & _items(aws)
        assert scans.call_count >= 1
        assert queries.sent == []
        _job_row_deployment, audit = erasure_rows(aws, 'er_00000000c0de')
        assert SCAN_COUNTER not in audit


class TestTheGrantsMatchTheReads:
    """lib/stacks/retention-worker.ts holds the index Queries to the partitions and keys these reads name."""

    @staticmethod
    def _list(name: str) -> list[str]:
        source = (REPO / 'voc-datalake/lib/stacks/retention-worker.ts').read_text(encoding='utf-8')
        found = re.search(rf'export const {name} = \[([^\]]*)\]', source)
        assert found, name
        return re.findall(r"'([^']*)'", found.group(1))

    def test_the_index_names_and_keys(self):
        from jobs.retention import item_walk

        assert self._list('FEEDBACK_DAY_INDEX_KEYS') == list(item_walk.DAY_KEYS) == list(FEEDBACK_BY_DATE_POSITION)
        assert self._list('FEEDBACK_ID_INDEX_KEYS') == list(item_walk.ID_KEYS)
        source = (REPO / 'voc-datalake/lib/stacks/retention-worker.ts').read_text(encoding='utf-8')
        assert f"export const FEEDBACK_DAY_INDEX = '{FEEDBACK_BY_DATE_INDEX}'" in source
        assert f"export const FEEDBACK_ID_INDEX = '{FEEDBACK_BY_ID_INDEX}'" in source

    def test_the_filter_names_only_attributes_the_grants_allow(self):
        """Each Query's filter (``erase_filter`` in a workspace, every workspace field, with and without a source)
        names only the keys and ``FEEDBACK_ERASE_FILTER_ATTRIBUTES``, and the grant names no attribute it never
        needs (``dynamodb:Attributes`` may count a filter's names: a Query must never be refused for them)."""
        scope = WorkspaceScope(WS)
        named: set[str] = set()
        for field in retention.WORKSPACE_ERASE_FIELDS:
            for source in (None, 'tickets'):
                condition = retention.erase_filter(field, 'x@example.com', source, retention.STORE_FEEDBACK, scope)
                built = ConditionExpressionBuilder().build_expression(condition)
                # Top-level names only (``metadata.email``'s ``email`` is a path inside ``metadata``).
                top = re.findall(r'(?<![.\w])(#n\d+)', built.condition_expression)
                named |= {built.attribute_name_placeholders[placeholder] for placeholder in top}
        allowed = self._list('FEEDBACK_ERASE_FILTER_ATTRIBUTES')
        assert named - {'pk', 'sk'} == set(allowed)
        assert {'pk', 'sk'} <= set(self._list('FEEDBACK_DAY_INDEX_KEYS')) & set(self._list('FEEDBACK_ID_INDEX_KEYS'))


@pytest.mark.usefixtures('aws')
class TestTheWalksCursorIsTold:
    @pytest.mark.parametrize(('cursor', 'kind'), [
        (None, 'start'), ({'day': '2026-11-20'}, 'day'), ({'day': '2026-11-20', 'start': {'pk': 'x'}}, 'day'),
        ({'id_start': {'pk': 'x'}}, 'id'), ({'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a'}, 'scan')])
    def test_each_shape(self, cursor, kind):
        from jobs.retention import item_walk

        assert item_walk.cursor_kind(cursor) == kind
