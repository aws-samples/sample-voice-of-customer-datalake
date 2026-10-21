"""Tests for shared/data_quality.py — job store helpers and the pure profile math."""
import json
import re
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared import data_quality as dq
from shared.enrichment_fields import USEFULNESS


def _conditional_failure() -> ClientError:
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'PutItem')


class TestJobIds:
    def test_ids_sort_by_creation_time(self):
        early = dq.new_job_id(datetime(2026, 1, 1, tzinfo=timezone.utc))
        late = dq.new_job_id(datetime(2026, 1, 2, tzinfo=timezone.utc))
        assert early < late

    def test_ids_match_the_settings_route_pattern(self):
        assert re.fullmatch(r'dq_\d{14}_[0-9a-f]{8}', dq.new_job_id())


class TestLocks:
    def test_acquire_returns_false_when_held(self):
        table = MagicMock()
        table.put_item.side_effect = _conditional_failure()
        assert dq.acquire_lock(table, 'enrich#a#usefulness', 'job') is False

    def test_acquire_allows_taking_over_an_expired_lock(self):
        table = MagicMock()
        assert dq.acquire_lock(table, 'k', 'job') is True
        assert '#ttl < :now' in table.put_item.call_args.kwargs['ConditionExpression']

    def test_acquire_propagates_other_errors(self):
        table = MagicMock()
        table.put_item.side_effect = ClientError({'Error': {'Code': 'Throttling'}}, 'PutItem')
        with pytest.raises(ClientError):
            dq.acquire_lock(table, 'k', 'job')

    def test_release_ignores_a_lock_now_held_by_another_job(self):
        table = MagicMock()
        table.delete_item.side_effect = _conditional_failure()
        dq.release_lock(table, 'k', 'job')  # does not raise


class TestFinishJob:
    def test_transitions_once_and_releases_the_lock(self):
        table = MagicMock()
        job = {'job_id': 'j', 'kind': 'enrich', 'source': 's', 'field': 'usefulness'}
        assert dq.finish_job(table, job, dq.STATUS_COMPLETED) is True
        assert table.delete_item.call_args.kwargs['Key'] == {'pk': dq.LOCK_PK, 'sk': 'enrich#s#usefulness'}

    def test_a_job_already_finished_is_left_alone(self):
        table = MagicMock()
        table.update_item.side_effect = _conditional_failure()
        assert dq.finish_job(table, {'job_id': 'j'}, dq.STATUS_COMPLETED) is False
        table.delete_item.assert_not_called()

    def test_error_text_is_bounded(self):
        table = MagicMock()
        dq.finish_job(table, {'job_id': 'j'}, dq.STATUS_FAILED, 'x' * 2000)
        assert len(table.update_item.call_args.kwargs['ExpressionAttributeValues'][':error']) == 500


class TestProgress:
    def test_add_progress_skips_zero_deltas(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'processed': 1}}
        dq.add_progress(table, 'j', processed=1, failed=0)
        assert table.update_item.call_args.kwargs['ExpressionAttributeNames'] == {'#processed': 'processed'}

    @pytest.mark.parametrize('job,expected', [
        ({'planned': True, 'processed': 3, 'total': 3}, True),
        ({'planned': True, 'processed': 4, 'total': 3}, True),
        ({'planned': False, 'processed': 3, 'total': 3}, False),
        ({'planned': True, 'processed': 2, 'total': 3}, False),
        ({'planned': True, 'processed': Decimal(0), 'total': Decimal(0)}, True),
    ])
    def test_is_complete(self, job, expected):
        assert dq.is_complete(job) is expected


class TestProfile:
    @pytest.mark.parametrize('rating,bucket', [
        (5, '5'), (Decimal(4), '4'), ('3', '3'), (4.6, '5'), (None, 'none'), ('x', 'none'), (9, 'none'),
    ])
    def test_rating_bucket(self, rating, bucket):
        assert dq.rating_bucket(rating) == bucket

    @pytest.mark.parametrize('length,bucket', [
        (0, '0-100'), (100, '0-100'), (101, '101-500'), (1000, '501-1000'), (2001, '2000+'),
    ])
    def test_length_bucket(self, length, bucket):
        assert dq.length_bucket('x' * length) == bucket

    def test_accumulates_per_source_and_ignores_non_feedback_rows(self):
        profile = dq.accumulate_profile({}, [
            {'pk': 'SOURCE#a', 'sk': 'FEEDBACK#1', 'rating': 5, 'sentiment_label': 'positive',
             'usefulness': 'high', 'original_text': 'short'},
            {'pk': 'SOURCE#a', 'sk': 'FEEDBACK#2', 'original_text': 'x' * 300},
            {'pk': 'SOURCE#a', 'sk': 'META'},
            {'pk': 'OTHER#x', 'sk': 'FEEDBACK#3'},
        ])
        assert list(profile) == ['a']
        a = profile['a']
        assert a['count'] == 2
        assert a['ratings'] == {'5': 1, 'none': 1}
        assert a['sentiments'] == {'positive': 1, 'unknown': 1}
        assert a['enrichment']['usefulness'] == {'high': 1, 'unscored': 1}
        assert a['lengths'] == {'0-100': 1, '101-500': 1}

    def test_folds_sources_beyond_the_cap_into_one_bucket(self):
        items = [{'pk': f'SOURCE#s{i}', 'sk': 'FEEDBACK#1'} for i in range(dq.MAX_PROFILE_SOURCES + 5)]
        profile = dq.accumulate_profile({}, items)
        assert len(profile) == dq.MAX_PROFILE_SOURCES + 1
        assert profile[dq.OVERFLOW_SOURCE]['count'] == 5

    def test_partial_profile_survives_a_json_round_trip(self):
        profile = dq.accumulate_profile({}, [{'pk': 'SOURCE#a', 'sk': 'FEEDBACK#1', 'rating': Decimal(5)}])
        again = dq.accumulate_profile(json.loads(dq.to_json(profile)), [{'pk': 'SOURCE#a', 'sk': 'FEEDBACK#2'}])
        assert again['a']['count'] == 2

    def test_projection_names_every_counted_attribute(self):
        expression, names = dq.profile_projection()
        assert set(names.values()) >= {'pk', 'sk', 'rating', 'sentiment_label', 'original_text', 'usefulness'}
        assert expression.count('#p') == len(names)

    def test_snapshot_sources_are_largest_first(self):
        ordered = dq.snapshot_sources({'a': {'count': 1}, 'b': {'count': 5}})
        assert [s['source'] for s in ordered] == ['b', 'a']


class TestParsing:
    @pytest.mark.parametrize('answer,expected', [
        ('{"usefulness":"high"}', 'high'),
        ('Sure! ```json\n{"usefulness": "Medium"}\n```', 'medium'),
        ('{"usefulness":"amazing"}', None),
        ('{"other":"high"}', None),
        ('no json here', None),
        ('{broken', None),
        ('["high"]', None),
    ])
    def test_parse_single_field_answer(self, answer, expected):
        assert dq.parse_single_field_answer(USEFULNESS, answer) == expected

    def test_to_plain_converts_nested_decimals(self):
        assert dq.to_plain({'a': [Decimal(1), Decimal('1.5')], 'b': {'c': Decimal(2)}}) == {
            'a': [1, 1.5], 'b': {'c': 2},
        }
