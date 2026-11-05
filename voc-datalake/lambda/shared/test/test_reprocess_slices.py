"""The reprocess slice (shared/reprocess_slices.py) and the lineage helpers (shared/reprocess_lineage.py)."""
from datetime import UTC, datetime
from decimal import Decimal
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import ConditionExpressionBuilder
from botocore.exceptions import ClientError

from shared import reprocess_lineage as lineage
from shared import reprocess_slices as slices
from shared.converse import ConverseResult


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
        assert _names(slices.read_filter(slices.ReprocessSlice(), (None, None))) == {'sk'}


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
