"""The reprocess slice (shared/reprocess_slices.py) and the lineage helpers (shared/reprocess_lineage.py)."""
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Attr, ConditionExpressionBuilder
from botocore.exceptions import ClientError

from shared import reprocess_lineage as lineage
from shared import reprocess_slices as slices
from shared.converse import ConverseResult
from shared.ws_repo import OutOfScopeError, WorkspaceScope


def _days(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError('days must be an integer (0 = all time)')
    return value


class TestParseSlice:
    def test_days_only_is_the_old_body(self):
        parsed = slices.parse_slice({'days': 30}, _days)
        assert parsed == slices.ReprocessSlice(days=30)
        assert parsed.fields() == {'date_basis': 'processed'}

    def test_every_axis(self):
        parsed = slices.parse_slice({
            'sources': [' web ', 'app', 'web', ''], 'categories': ['billing'],
            'date_from': '2026-02-01', 'date_to': '2026-02-28', 'date_basis': 'review',
        }, _days)
        assert parsed == slices.ReprocessSlice(
            sources=('web', 'app'), categories=('billing',), days=None,
            date_from='2026-02-01', date_to='2026-02-28', date_basis='review',
        )
        assert parsed.fields() == {
            'sources': ['web', 'app'], 'categories': ['billing'], 'date_from': '2026-02-01',
            'date_to': '2026-02-28', 'date_basis': 'review',
        }

    def test_an_open_ended_range_needs_no_days(self):
        assert slices.parse_slice({'date_from': '2026-02-01'}, _days).days is None

    @pytest.mark.parametrize(('body', 'message'), [
        ({'days': 7, 'date_from': '2026-02-01'}, 'mutually exclusive'),
        ({'days': 7, 'date_to': '2026-02-01'}, 'mutually exclusive'),
        ({'date_from': '2026-03-01', 'date_to': '2026-02-01'}, 'must not be after'),
        ({'date_from': '2026-02-30'}, 'real date'),
        ({'date_from': '01/02/2026'}, 'YYYY-MM-DD'),
        ({'days': 0, 'sources': 'web'}, 'list of strings'),
        ({'days': 0, 'sources': [1]}, 'list of strings'),
        ({'days': 0, 'categories': [f'c{i}' for i in range(51)]}, 'at most 50'),
        ({'days': 0, 'sources': ['x' * 129]}, 'at most 128'),
        ({'days': 0, 'date_basis': 'imported'}, 'date_basis'),
        ({}, 'days must be an integer'),
    ])
    def test_refusals(self, body, message):
        with pytest.raises(ValueError, match=message):
            slices.parse_slice(body, _days)


class TestStoredSlice:
    def test_a_row_from_before_slices_is_days_only(self):
        assert slices.slice_from_job({'days': Decimal('14')}) == slices.ReprocessSlice(days=14)
        assert slices.slice_from_job({}) == slices.ReprocessSlice(days=0)

    def test_a_stored_slice_round_trips(self):
        original = slices.ReprocessSlice(sources=('web',), categories=('a',), days=None,
                                         date_from='2026-01-01', date_basis='review')
        assert slices.slice_from_job(original.fields()) == original

    def test_malformed_fields_are_dropped(self):
        assert slices.slice_from_job({'sources': 'web', 'date_from': 'soon', 'date_basis': 'x', 'days': True}) == \
            slices.ReprocessSlice(days=0)


class TestAdmits:
    ITEM: ClassVar[dict] = {'source_platform': 'web', 'category': 'billing', 'date': '2026-02-10',
            'source_created_at': '2025-12-24T10:00:00Z'}

    def test_the_window(self):
        today = datetime(2026, 3, 10, tzinfo=UTC)
        assert slices.ReprocessSlice(days=10).window(today) == ('2026-03-01', None)
        assert slices.ReprocessSlice(days=None, date_to='2026-01-31').window(today) == (None, '2026-01-31')

    @pytest.mark.parametrize(('job_slice', 'expected'), [
        (slices.ReprocessSlice(), True),
        (slices.ReprocessSlice(sources=('app',)), False),
        (slices.ReprocessSlice(categories=('shipping',)), False),
        (slices.ReprocessSlice(days=None, date_from='2026-02-10', date_to='2026-02-10'), True),
        (slices.ReprocessSlice(days=None, date_from='2026-02-11'), False),
        (slices.ReprocessSlice(days=None, date_to='2025-12-31', date_basis='review'), True),
        (slices.ReprocessSlice(days=None, date_from='2026-01-01', date_basis='review'), False),
    ])
    def test_each_axis(self, job_slice, expected):
        assert slices.admits(self.ITEM, job_slice, job_slice.window(datetime(2026, 3, 10, tzinfo=UTC))) is expected

    def test_an_item_without_a_date_is_outside_any_window(self):
        assert slices.admits({}, slices.ReprocessSlice(days=None, date_from='2026-01-01'),
                             ('2026-01-01', None)) is False


def _names(condition) -> set[str]:
    """The attribute names a filter condition reads."""
    return set(ConditionExpressionBuilder().build_expression(condition).attribute_name_placeholders.values())


class TestReadPage:
    def test_every_read_is_a_scan_filtered_on_the_sources(self):
        table = MagicMock()
        table.scan.return_value = {'Items': []}
        slices.read_page(table, None, slices.ReprocessSlice(sources=('web', 'app')), (None, None), 25)
        table.query.assert_not_called()
        names = _names(table.scan.call_args.kwargs['FilterExpression'])
        assert {'sk', 'source_platform'} <= names
        assert 'ExclusiveStartKey' not in table.scan.call_args.kwargs

    def test_a_cursor_continues_the_scan(self):
        table = MagicMock()
        table.scan.return_value = {'Items': []}
        cursor = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#m'}
        slices.read_page(table, cursor, slices.ReprocessSlice(sources=('web',)), (None, None), 25)
        assert table.scan.call_args.kwargs['ExclusiveStartKey'] == cursor

    def test_the_filter_always_keeps_to_feedback_rows(self):
        """Feedback rows of the deployment: `sk` FEEDBACK#…, and `pk` never a workspace's (WS#…)."""
        condition = slices.read_filter(slices.ReprocessSlice(), (None, None))
        assert _names(condition) == {'sk', 'pk'}
        assert condition == Attr('sk').begins_with('FEEDBACK#') & ~Attr('pk').begins_with('WS#')

    def test_a_workspace_item_is_never_in_a_slice(self):
        workspace_item = {'pk': 'WS#ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8#SOURCE#web', 'source_platform': 'web',
                          'category': 'delivery', 'date': '2026-01-15'}
        assert slices.admits(workspace_item, slices.ReprocessSlice(), (None, None)) is False
        assert slices.admits({**workspace_item, 'pk': 'SOURCE#web'}, slices.ReprocessSlice(), (None, None)) is True


class TestLineage:
    def test_the_recorder_keeps_the_model_that_answered(self):
        result = ConverseResult(text='{}', model_id='fallback-model', requested_model_id='asked-model')
        recorder = lineage.AnswerRecorder()
        assert recorder.metadata() is None
        with patch.object(lineage, 'converse_detailed', return_value=result) as call:
            assert recorder(prompt='p', model_id='asked-model') == '{}'
        call.assert_called_once_with(prompt='p', model_id='asked-model')
        metadata = recorder.metadata()
        assert metadata is not None
        assert metadata['model_name'] == 'fallback-model'
        assert metadata['requested_model'] == 'asked-model'
        assert metadata['prompt_version'] == lineage.PROMPT_VERSION

    def test_the_digest_ignores_key_order(self):
        assert lineage.categories_digest([{'a': 1, 'b': 2}]) == lineage.categories_digest([{'b': 2, 'a': 1}])
        assert lineage.categories_digest([{'a': 1}]) != lineage.categories_digest([{'a': 2}])
        assert len(lineage.categories_digest([])) == 16

    @pytest.mark.parametrize(('response', 'expected'), [
        ({}, 0), ({'Item': {'v': Decimal('3')}}, 3), ({'Item': {'v': True}}, None), ({'Item': {'v': 'x'}}, None),
    ])
    def test_the_config_version(self, response, expected):
        table = MagicMock()
        table.get_item.return_value = response
        with patch.object(lineage, 'get_active_model_id', return_value='m'):
            assert lineage.job_config(table, [])['config_version'] == expected

    def test_an_unreadable_config_version_is_unknown(self):
        table = MagicMock()
        table.get_item.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetItem')
        with patch.object(lineage, 'get_active_model_id', return_value='m'):
            assert lineage.job_config(table, [])['config_version'] is None

    def test_the_actor_and_stamps(self):
        assert lineage.job_actor({'started_by_sub': 's', 'started_by': 'alice'}) == {'sub': 's', 'kind': 'admin'}
        assert lineage.job_actor({'started_by': 'alice'}) == {'sub': 'alice', 'kind': 'admin'}
        assert lineage.job_actor({}) == {'sub': 'unknown', 'kind': 'admin'}
        assert lineage.change_stamps({'sub': 's', 'kind': 'admin'}, 'now') == {
            'updated_by': {'sub': 's', 'kind': 'admin'}, 'updated_at': 'now', 'change_reason': 'reprocess'}


class TestTheWorkspaceDayWalk:
    """A workspace's job reads its own day partitions of gsi1-by-date (``read_day_page``), the days ``walk_days``."""

    WS: ClassVar[str] = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'

    @pytest.mark.parametrize(('job_slice', 'window', 'expected'), [
        (slices.ReprocessSlice(), (None, None), ('2026-11-09', '2026-11-20')),
        (slices.ReprocessSlice(days=None), ('2026-11-12', '2026-11-14'), ('2026-11-12', '2026-11-14')),
        (slices.ReprocessSlice(days=None), ('2026-01-01', '2027-01-01'), ('2026-11-09', '2026-11-20')),
        (slices.ReprocessSlice(days=None), ('2026-11-12', None), ('2026-11-12', '2026-11-20')),
        (slices.ReprocessSlice(days=None), (None, '2026-11-12'), ('2026-11-09', '2026-11-12')),
        # A review-date window never chooses the days: a review's processing day is not its own date.
        (slices.ReprocessSlice(days=None, date_basis='review'), ('2019-01-01', '2019-02-01'),
         ('2026-11-09', '2026-11-20')),
        (slices.ReprocessSlice(days=None), ('2025-01-01', '2025-02-01'), ('2026-11-09', '2025-02-01')),
    ])
    def test_the_days(self, job_slice, window, expected):
        assert slices.walk_days(job_slice, window, date(2026, 11, 9), date(2026, 11, 20)) == expected

    @pytest.mark.parametrize(('cursor', 'walks'), [
        (None, True), ({}, True), ({'day': '2026-11-10'}, True), ({'day': '2026-11-10', 'start': {'pk': 'x'}}, True),
        ({'pk': 'WS#x#SOURCE#web', 'sk': 'FEEDBACK#a'}, False),
    ])
    def test_which_cursor_walks(self, cursor, walks):
        assert slices.is_walk_cursor(cursor) is walks

    def _page(self, response: dict, cursor: dict | None) -> tuple[dict, MagicMock]:
        table = MagicMock()
        table.query.return_value = response
        page = slices.read_day_page(table, cursor, slices.ReprocessSlice(sources=('web',)), (None, None), 25,
                                    WorkspaceScope(self.WS), ('2026-11-09', '2026-11-11'))
        return page, table

    def test_one_query_of_the_first_days_partition_through_the_layer(self):
        page, table = self._page({'Items': [{'pk': 'a'}]}, None)

        assert page == {'Items': [{'pk': 'a'}], 'Day': '2026-11-09', 'LastEvaluatedKey': {'day': '2026-11-10'}}
        [call] = table.query.call_args_list
        assert (call.kwargs['IndexName'], call.kwargs['Limit']) == ('gsi1-by-date', 25)
        assert call.kwargs['KeyConditionExpression'] == '#p = :p'
        assert call.kwargs['ExpressionAttributeNames'] == {'#p': 'gsi1pk'}
        assert call.kwargs['ExpressionAttributeValues'] == {':p': f'WS#{self.WS}#DATE#2026-11-09'}
        assert call.kwargs['FilterExpression'] == slices.read_filter(
            slices.ReprocessSlice(sources=('web',)), (None, None), WorkspaceScope(self.WS))
        assert 'ExclusiveStartKey' not in call.kwargs

    def test_a_days_last_key_stays_on_that_day(self):
        start = {'pk': f'WS#{self.WS}#SOURCE#web', 'sk': 'FEEDBACK#a', 'gsi1pk': f'WS#{self.WS}#DATE#2026-11-10',
                 'gsi1sk': 't#a'}
        page, table = self._page({'Items': [], 'LastEvaluatedKey': start}, {'day': '2026-11-10', 'start': start})

        assert page['LastEvaluatedKey'] == {'day': '2026-11-10', 'start': start}
        assert table.query.call_args.kwargs['ExclusiveStartKey'] == start

    def test_the_last_day_ends_the_walk(self):
        page, _table = self._page({'Items': []}, {'day': '2026-11-11'})

        assert page == {'Items': [], 'Day': '2026-11-11'}

    def test_a_day_past_the_last_reads_nothing(self):
        page, table = self._page({'Items': []}, {'day': '2026-11-12'})

        assert page == {'Items': [], 'Day': '2026-11-12'}
        table.query.assert_not_called()

    @pytest.mark.parametrize('day', [
        'yesterday', '', None, 20261110,
        # Shapes date.fromisoformat takes that sort past '2026-11-11' as strings: unchecked, they would end the walk
        # with 2026-11-10 and 2026-11-11 unread.
        '20261110', '2026-W46-2', '2026-11-10T00:00:00',
    ])
    def test_a_cursor_day_that_is_no_yyyy_mm_dd_date_is_refused_never_skipped(self, day):
        with pytest.raises(ValueError, match=r'walk cursor day must be a date \(YYYY-MM-DD\)'):
            self._page({'Items': []}, {'day': day})

    def test_a_cursor_day_that_is_no_real_date_is_refused(self):
        table = MagicMock()
        with pytest.raises(ValueError, match=r'walk cursor day must be a real date'):
            slices.read_day_page(table, {'day': '2026-02-30'}, slices.ReprocessSlice(), (None, None), 25,
                                 WorkspaceScope(self.WS), ('2026-02-01', '2026-03-31'))
        table.query.assert_not_called()

    def test_a_start_key_outside_the_workspace_is_refused_by_the_layer(self):
        start = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a', 'gsi1pk': 'DATE#2026-11-10', 'gsi1sk': 't#a'}
        with pytest.raises(OutOfScopeError):
            self._page({'Items': []}, {'day': '2026-11-10', 'start': start})

    def test_the_position_after_a_review(self):
        item = {'pk': 'p', 'sk': 's', 'gsi1pk': 'g', 'gsi1sk': 'h', 'category': 'c'}

        assert slices.position_after({'Day': '2026-11-10'}, item) == {
            'day': '2026-11-10', 'start': {'pk': 'p', 'sk': 's', 'gsi1pk': 'g', 'gsi1sk': 'h'}}
        assert slices.position_after({'Items': [item]}, item) == {'pk': 'p', 'sk': 's'}
