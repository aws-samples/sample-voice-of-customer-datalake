"""Mutation hardening for `shared/reprocess_jobs.py`.

`test_reprocess_jobs.py` drives the lock and the worker-token compare-and-set
through moto, so it pins that a refused write IS refused. A mutation run found
what a round trip through a real table cannot see:

* the STORAGE CONTRACT — the literal partition key, lock sort key, job-id
  prefix, `ConsistentRead=True` on every read, `Limit=1` on the "latest"
  query, and the exact `ConditionExpression` / attribute-name / attribute-value
  maps of every conditional write. moto accepts a weaker condition just as
  happily as the right one, so these are pinned against a mock with
  `assert_called_once_with`.
* the API VIEW's field names and defaults (`started_by` '', `created_at`,
  `updated_at`), and that DynamoDB booleans and non-numbers read as 0.
* every BOUNDARY as a literal: exactly `STALE_AFTER_SECONDS` since the last
  checkpoint is still live, one millisecond more is stale; an error of 501
  characters is stored as exactly 500, one of 500 is kept whole.
* the RECLAIM path's decisions: a live holder keeps the lock (no second
  claim), a vanished lock row counts as free, a stale holder is failed with
  the literal error 'Job stopped making progress', and the fresh job — not
  nobody — ends up holding the lock afterwards (`and`, not `or`).

The moto table is created once per module and emptied between tests: table
creation is the slow part of a moto test, and these tests must stay fast
enough to run once per mutant.
"""
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, call

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import reprocess_jobs as jobs
from shared.test.moto_tables import create_pk_sk_table
from shared.test.reprocess_jobs_fixtures import NOW
from shared.test.reprocess_jobs_fixtures import present as _present
from shared.test.reprocess_jobs_fixtures import start as _start

NOW_ISO = '2026-03-01T12:00:00+00:00'
NOW_JOB_ID = 'rp_019ca9450a00'   # 1772366400000 ms as 12 hex digits
JOB_KEY = {'pk': 'JOB#category_reprocess', 'sk': 'rp_000000000001'}
LOCK_KEY = {'pk': 'JOB#category_reprocess', 'sk': 'LOCK'}
ACTIVE_CONDITION = 'attribute_exists(sk) AND #status IN (:queued, :running)'
CONDITIONAL_FAILURE = ClientError(
    {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'refused'}}, 'UpdateItem',
)
OTHER_FAILURE = ClientError(
    {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}}, 'UpdateItem',
)


@pytest.fixture(scope='module')
def _moto_table():
    with mock_aws():
        yield create_pk_sk_table('test-aggregates-reprocess-mutation')


@pytest.fixture
def table(_moto_table):
    for item in _moto_table.scan(ProjectionExpression='pk, sk')['Items']:
        _moto_table.delete_item(Key=item)
    return _moto_table


def _lock_row(table) -> dict:
    return table.get_item(Key=LOCK_KEY, ConsistentRead=True).get('Item') or {}


class TestConstantsAreTheStorageContract:
    def test_keys_and_prefix(self):
        assert jobs.JOB_PK == 'JOB#category_reprocess'
        assert jobs.LOCK_SK == 'LOCK'
        assert jobs.JOB_ID_PREFIX == 'rp_'

    def test_statuses_and_modes(self):
        assert jobs.MODES == ('processed', 'raw', 'dimensions')
        assert jobs.ACTIVE_STATUSES == ('queued', 'running')
        assert (jobs.STATUS_COMPLETED, jobs.STATUS_FAILED, jobs.STATUS_CANCELLED) == (
            'completed', 'failed', 'cancelled')
        assert jobs.COUNTERS == ('scanned', 'updated', 'unchanged', 'skipped_manual', 'failed')

    def test_limits(self):
        assert jobs.STALE_AFTER_SECONDS == 1200
        assert jobs.MAX_ERROR_CHARS == 500
        assert jobs.MAX_REPROCESS_ITEMS == 50000


class TestJobIdsAndTokens:
    def test_job_id_is_the_creation_millisecond_in_hex(self):
        assert jobs.new_job_id(NOW) == NOW_JOB_ID
        assert jobs.new_job_id(NOW + timedelta(milliseconds=1)) == 'rp_019ca9450a01'

    @pytest.mark.parametrize(('value', 'expected'), [
        (NOW_JOB_ID, True),
        ('rp_000000000000', True),
        ('rp_019CA9450A00', False),     # upper-case hex is not produced
        ('rp_019ca9450a0', False),      # 11 digits
        ('rp_019ca9450a000', False),    # 13 digits
        ('rq_019ca9450a00', False),
        (' rp_019ca9450a00', False),
        (b'rp_019ca9450a00', False),
        (None, False),
    ])
    def test_is_job_id(self, value, expected):
        assert jobs.is_job_id(value) is expected

    def test_worker_token_is_32_hex_chars_and_unique(self):
        first, second = jobs.new_worker_token(), jobs.new_worker_token()
        assert len(first) == 32
        assert int(first, 16) >= 0
        assert first != second

    def test_now_iso(self):
        assert jobs.now_iso(NOW) == NOW_ISO
        parsed = datetime.fromisoformat(jobs.now_iso())
        assert parsed.tzinfo is not None
        assert abs((datetime.now(UTC) - parsed).total_seconds()) < 5


class TestJobViewIsTheApiShape:
    @pytest.mark.parametrize(('stored', 'expected'), [
        (True, 0), (False, 0), (7, 7), (Decimal('7'), 7), ('7', 0), (None, 0), (7.5, 0),
    ])
    def test_numbers_read_as_int_and_everything_else_as_zero(self, stored, expected):
        assert jobs.job_view({'days': stored})['days'] == expected
        assert jobs.job_view({'scanned': stored})['scanned'] == expected

    def test_full_item(self):
        item = {
            'pk': 'JOB#category_reprocess', 'sk': NOW_JOB_ID, 'status': 'running', 'mode': 'raw',
            'days': Decimal('7'), 'include_manual': True, 'scanned': Decimal('5'),
            'updated': Decimal('4'), 'unchanged': Decimal('3'), 'skipped_manual': Decimal('2'),
            'failed': Decimal('1'), 'started_by': 'alice', 'created_at': 'c', 'updated_at': 'u',
            'finished_at': 'f', 'error': 'boom', 'stopped_at_ceiling': True,
            'worker_token': 'secret', 'cursor': {'pk': 'x'},
        }
        assert jobs.job_view(item) == {
            'job_id': NOW_JOB_ID, 'status': 'running', 'mode': 'raw', 'days': 7,
            'include_manual': True, 'scanned': 5, 'updated': 4, 'unchanged': 3,
            'skipped_manual': 2, 'failed': 1, 'started_by': 'alice', 'created_at': 'c',
            'updated_at': 'u', 'stopped_at_ceiling': True, 'finished_at': 'f', 'error': 'boom',
        }

    def test_empty_item_defaults(self):
        assert jobs.job_view({}) == {
            'job_id': None, 'status': None, 'mode': None, 'days': 0, 'include_manual': False,
            'scanned': 0, 'updated': 0, 'unchanged': 0, 'skipped_manual': 0, 'failed': 0,
            'started_by': '', 'created_at': None, 'updated_at': None, 'stopped_at_ceiling': False,
        }

    @pytest.mark.parametrize('flag', ['include_manual', 'stopped_at_ceiling'])
    @pytest.mark.parametrize('stored', ['yes', 1, Decimal('1'), None])
    def test_flags_are_true_only_for_a_real_true(self, flag, stored):
        assert jobs.job_view({flag: stored})[flag] is False

    @pytest.mark.parametrize('optional', ['finished_at', 'error'])
    def test_empty_optionals_are_omitted(self, optional):
        assert optional not in jobs.job_view({optional: ''})
        assert optional not in jobs.job_view({optional: None})
        assert jobs.job_view({optional: 'x'})[optional] == 'x'


class TestReadsAreConsistentAndNarrow:
    def test_get_job(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'sk': 'rp_000000000001'}}
        assert jobs.get_job(table, 'rp_000000000001') == {'sk': 'rp_000000000001'}
        table.get_item.assert_called_once_with(Key=JOB_KEY, ConsistentRead=True)

    def test_get_job_missing(self):
        table = MagicMock()
        table.get_item.return_value = {}
        assert jobs.get_job(table, 'rp_000000000001') is None

    def test_get_latest_job_is_one_descending_consistent_query(self):
        table = MagicMock()
        table.query.return_value = {'Items': [{'sk': 'newest'}]}
        assert jobs.get_latest_job(table) == {'sk': 'newest'}
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('JOB#category_reprocess') & Key('sk').begins_with('rp_'),
            ScanIndexForward=False,
            Limit=1,
            ConsistentRead=True,
        )

    @pytest.mark.parametrize('response', [{}, {'Items': []}, {'Items': None}])
    def test_get_latest_job_none_when_empty(self, response):
        table = MagicMock()
        table.query.return_value = response
        assert jobs.get_latest_job(table) is None


class TestStaleness:
    @pytest.mark.parametrize('updated_at', [None, 1772366400, 'not-a-date', '', b'2026-03-01'])
    def test_unreadable_timestamp_is_stale(self, updated_at):
        assert jobs.is_stale({'updated_at': updated_at}, NOW) is True

    def test_missing_timestamp_is_stale(self):
        assert jobs.is_stale({}, NOW) is True

    @pytest.mark.parametrize(('age', 'expected'), [
        (timedelta(seconds=1200), False),
        (timedelta(seconds=1200, milliseconds=1), True),
        (timedelta(seconds=1199, milliseconds=999), False),
        (timedelta(0), False),
    ])
    def test_boundary_is_strictly_after_stale_after_seconds(self, age, expected):
        assert jobs.is_stale({'updated_at': (NOW - age).isoformat()}, NOW) is expected


class TestLockWritesAreConditional:
    def test_claim_lock(self):
        table = MagicMock()
        assert jobs._claim_lock(table, 'rp_000000000001', NOW) is True
        table.update_item.assert_called_once_with(
            Key=LOCK_KEY,
            UpdateExpression='SET active_job_id = :id, updated_at = :now',
            ConditionExpression='attribute_not_exists(active_job_id)',
            ExpressionAttributeValues={':id': 'rp_000000000001', ':now': NOW_ISO},
        )

    def test_claim_lock_refused_is_false(self):
        table = MagicMock()
        table.update_item.side_effect = CONDITIONAL_FAILURE
        assert jobs._claim_lock(table, 'rp_000000000001', NOW) is False

    def test_claim_lock_other_errors_raise(self):
        table = MagicMock()
        table.update_item.side_effect = OTHER_FAILURE
        with pytest.raises(ClientError) as info:
            jobs._claim_lock(table, 'rp_000000000001', NOW)
        assert info.value is OTHER_FAILURE

    def test_release_lock(self):
        table = MagicMock()
        assert jobs.release_lock(table, 'rp_000000000001') is None
        table.update_item.assert_called_once_with(
            Key=LOCK_KEY,
            UpdateExpression='REMOVE active_job_id',
            ConditionExpression='active_job_id = :id',
            ExpressionAttributeValues={':id': 'rp_000000000001'},
        )

    def test_release_lock_swallows_only_the_refusal(self):
        table = MagicMock()
        table.update_item.side_effect = CONDITIONAL_FAILURE
        assert jobs.release_lock(table, 'rp_000000000001') is None
        table.update_item.side_effect = OTHER_FAILURE
        with pytest.raises(ClientError) as info:
            jobs.release_lock(table, 'rp_000000000001')
        assert info.value is OTHER_FAILURE


class TestReclaimDecisions:
    def test_lock_row_without_holder_is_free(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'pk': 'JOB#category_reprocess', 'sk': 'LOCK'}}
        assert jobs._reclaim_lock_if_dead(table, NOW) is True
        table.get_item.assert_called_once_with(Key=LOCK_KEY, ConsistentRead=True)
        table.update_item.assert_not_called()

    def test_missing_lock_row_is_free(self):
        table = MagicMock()
        table.get_item.return_value = {}
        assert jobs._reclaim_lock_if_dead(table, NOW) is True
        table.update_item.assert_not_called()

    def test_holder_whose_job_is_missing_is_released(self):
        table = MagicMock()
        table.get_item.side_effect = [{'Item': {'active_job_id': 'rp_000000000001'}}, {}]
        assert jobs._reclaim_lock_if_dead(table, NOW) is True
        assert table.get_item.call_args_list == [
            call(Key=LOCK_KEY, ConsistentRead=True),
            call(Key=JOB_KEY, ConsistentRead=True),
        ]
        table.update_item.assert_called_once_with(
            Key=LOCK_KEY,
            UpdateExpression='REMOVE active_job_id',
            ConditionExpression='active_job_id = :id',
            ExpressionAttributeValues={':id': 'rp_000000000001'},
        )

    def test_live_holder_keeps_the_lock(self, table):
        job = _present(_start(table))
        assert jobs._reclaim_lock_if_dead(table, NOW + timedelta(seconds=1200)) is False
        assert _lock_row(table)['active_job_id'] == job['sk']
        assert _present(jobs.get_job(table, job['sk']))['status'] == 'queued'

    def test_stale_holder_is_failed_with_the_literal_error(self, table):
        job = _present(_start(table))
        later = NOW + timedelta(seconds=1200, milliseconds=1)
        assert jobs._reclaim_lock_if_dead(table, later) is True
        failed = _present(jobs.get_job(table, job['sk']))
        assert failed['status'] == 'failed'
        assert failed['error'] == 'Job stopped making progress'
        assert failed['finished_at'] == later.isoformat()
        assert failed['updated_at'] == later.isoformat()
        assert 'active_job_id' not in _lock_row(table)

    def test_terminal_holder_is_released(self, table):
        job = _present(_start(table))
        jobs.cancel_job(table, job['sk'])
        table.update_item(Key=LOCK_KEY, UpdateExpression='SET active_job_id = :id',
                          ExpressionAttributeValues={':id': job['sk']})
        assert jobs._reclaim_lock_if_dead(table, NOW) is True
        assert 'active_job_id' not in _lock_row(table)


class TestStartJob:
    def test_item_and_lock_row_are_literal(self, table):
        item = jobs.start_job(table, mode='raw', days=7, include_manual=True, started_by='alice', now=NOW)
        assert item == {
            'pk': 'JOB#category_reprocess', 'sk': NOW_JOB_ID, 'status': 'queued', 'mode': 'raw',
            'days': 7, 'include_manual': True, 'scanned': 0, 'updated': 0, 'unchanged': 0,
            'skipped_manual': 0, 'failed': 0, 'started_by': 'alice',
            'created_at': NOW_ISO, 'updated_at': NOW_ISO,
        }
        assert jobs.job_view(_present(jobs.get_job(table, NOW_JOB_ID)))['started_by'] == 'alice'
        assert _lock_row(table) == {
            'pk': 'JOB#category_reprocess', 'sk': 'LOCK', 'active_job_id': NOW_JOB_ID, 'updated_at': NOW_ISO,
        }

    def test_put_is_guarded_and_a_failed_put_releases_the_lock(self):
        table = MagicMock()
        table.put_item.side_effect = OTHER_FAILURE
        with pytest.raises(ClientError) as info:
            _start(table)
        assert info.value is OTHER_FAILURE
        table.put_item.assert_called_once_with(
            Item={
                'pk': 'JOB#category_reprocess', 'sk': NOW_JOB_ID, 'status': 'queued',
                'mode': 'processed', 'days': 30, 'include_manual': False, 'scanned': 0,
                'updated': 0, 'unchanged': 0, 'skipped_manual': 0, 'failed': 0,
                'started_by': 'admin', 'created_at': NOW_ISO, 'updated_at': NOW_ISO,
            },
            ConditionExpression='attribute_not_exists(sk)',
        )
        assert table.update_item.call_args_list == [
            call(Key=LOCK_KEY, UpdateExpression='SET active_job_id = :id, updated_at = :now',
                 ConditionExpression='attribute_not_exists(active_job_id)',
                 ExpressionAttributeValues={':id': NOW_JOB_ID, ':now': NOW_ISO}),
            call(Key=LOCK_KEY, UpdateExpression='REMOVE active_job_id',
                 ConditionExpression='active_job_id = :id',
                 ExpressionAttributeValues={':id': NOW_JOB_ID}),
        ]

    def test_refused_start_writes_no_job_and_keeps_the_holder(self, table):
        first = _present(_start(table))
        later = NOW + timedelta(seconds=5)
        assert _start(table, now=later) is None
        assert jobs.get_job(table, jobs.new_job_id(later)) is None
        assert _lock_row(table)['active_job_id'] == first['sk']

    def test_after_a_stale_reclaim_the_fresh_job_holds_the_lock(self, table):
        stale = _present(_start(table))
        later = NOW + timedelta(seconds=1201)
        fresh = _present(_start(table, now=later))
        assert fresh['sk'] != stale['sk']
        assert _lock_row(table) == {
            'pk': 'JOB#category_reprocess', 'sk': 'LOCK',
            'active_job_id': fresh['sk'], 'updated_at': later.isoformat(),
        }
        assert _start(table, now=later + timedelta(seconds=1)) is None


class TestTransitionWritesAreExact:
    def test_first_claim(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'status': 'running'}}
        assert jobs.claim_job(table, 'rp_000000000001', 'tok', now=NOW) == {'status': 'running'}
        table.update_item.assert_called_once_with(
            Key=JOB_KEY,
            UpdateExpression='SET #f0 = :v0, #f1 = :v1, #f2 = :v2',
            ConditionExpression=ACTIVE_CONDITION + ' AND attribute_not_exists(#token)',
            ExpressionAttributeNames={'#status': 'status', '#f0': 'status', '#f1': 'worker_token',
                                      '#f2': 'updated_at', '#token': 'worker_token'},
            ExpressionAttributeValues={':v0': 'running', ':v1': 'tok', ':v2': NOW_ISO,
                                       ':queued': 'queued', ':running': 'running'},
            ReturnValues='ALL_NEW',
        )

    def test_hand_over_claim(self):
        table = MagicMock()
        jobs.claim_job(table, 'rp_000000000001', 'next', previous_token='prev', now=NOW)
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['ConditionExpression'] == ACTIVE_CONDITION + ' AND #token = :claim_from'
        assert kwargs['ExpressionAttributeValues'] == {
            ':v0': 'running', ':v1': 'next', ':v2': NOW_ISO,
            ':queued': 'queued', ':running': 'running', ':claim_from': 'prev',
        }
        assert kwargs['ExpressionAttributeNames']['#token'] == 'worker_token'

    def test_checkpoint(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'scanned': 5}}
        counters = {'scanned': '5', 'updated': 4, 'failed': Decimal('1')}
        assert jobs.checkpoint(table, 'rp_000000000001', counters, {'pk': 'a', 'sk': 'b'}, 'tok', now=NOW) == {
            'scanned': 5}
        table.update_item.assert_called_once_with(
            Key=JOB_KEY,
            UpdateExpression='SET #f0 = :v0, #f1 = :v1, #f2 = :v2, #f3 = :v3, #f4 = :v4, #f5 = :v5, #f6 = :v6',
            ConditionExpression=ACTIVE_CONDITION + ' AND #token = :held_by',
            ExpressionAttributeNames={
                '#status': 'status', '#f0': 'scanned', '#f1': 'updated', '#f2': 'unchanged',
                '#f3': 'skipped_manual', '#f4': 'failed', '#f5': 'updated_at', '#f6': 'cursor',
                '#token': 'worker_token',
            },
            ExpressionAttributeValues={
                ':v0': 5, ':v1': 4, ':v2': 0, ':v3': 0, ':v4': 1, ':v5': NOW_ISO,
                ':v6': {'pk': 'a', 'sk': 'b'}, ':queued': 'queued', ':running': 'running', ':held_by': 'tok',
            },
            ReturnValues='ALL_NEW',
        )

    def test_checkpoint_without_cursor_stores_an_empty_map(self):
        table = MagicMock()
        jobs.checkpoint(table, 'rp_000000000001', {}, None, 'tok', now=NOW)
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':v6'] == {}

    def test_finish_with_everything(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'status': 'completed'}}
        result = jobs.finish_job(
            table, 'rp_000000000001', 'completed', counters={'scanned': 9}, error='boom',
            worker_token='tok', stopped_at_ceiling=True, now=NOW,
        )
        assert result == {'status': 'completed'}
        assert table.update_item.call_args_list[0] == call(
            Key=JOB_KEY,
            UpdateExpression='SET #f0 = :v0, #f1 = :v1, #f2 = :v2, #f3 = :v3, #f4 = :v4, #f5 = :v5, '
                             '#f6 = :v6, #f7 = :v7, #f8 = :v8, #f9 = :v9',
            ConditionExpression=ACTIVE_CONDITION + ' AND #token = :held_by',
            ExpressionAttributeNames={
                '#status': 'status', '#f0': 'status', '#f1': 'updated_at', '#f2': 'finished_at',
                '#f3': 'scanned', '#f4': 'updated', '#f5': 'unchanged', '#f6': 'skipped_manual',
                '#f7': 'failed', '#f8': 'error', '#f9': 'stopped_at_ceiling', '#token': 'worker_token',
            },
            ExpressionAttributeValues={
                ':v0': 'completed', ':v1': NOW_ISO, ':v2': NOW_ISO, ':v3': 9, ':v4': 0, ':v5': 0,
                ':v6': 0, ':v7': 0, ':v8': 'boom', ':v9': True,
                ':queued': 'queued', ':running': 'running', ':held_by': 'tok',
            },
            ReturnValues='ALL_NEW',
        )
        assert table.update_item.call_args_list[1] == call(
            Key=LOCK_KEY, UpdateExpression='REMOVE active_job_id',
            ConditionExpression='active_job_id = :id',
            ExpressionAttributeValues={':id': 'rp_000000000001'},
        )

    def test_finish_minimal_sets_only_status_and_stamps(self):
        table = MagicMock()
        jobs.finish_job(table, 'rp_000000000001', 'cancelled', now=NOW)
        assert table.update_item.call_args_list[0] == call(
            Key=JOB_KEY,
            UpdateExpression='SET #f0 = :v0, #f1 = :v1, #f2 = :v2',
            ConditionExpression=ACTIVE_CONDITION,
            ExpressionAttributeNames={'#status': 'status', '#f0': 'status', '#f1': 'updated_at',
                                      '#f2': 'finished_at'},
            ExpressionAttributeValues={':v0': 'cancelled', ':v1': NOW_ISO, ':v2': NOW_ISO,
                                       ':queued': 'queued', ':running': 'running'},
            ReturnValues='ALL_NEW',
        )
        assert len(table.update_item.call_args_list) == 2

    @pytest.mark.parametrize('error', ['', None])
    def test_finish_without_an_error_text_writes_no_error(self, error):
        table = MagicMock()
        jobs.finish_job(table, 'rp_000000000001', 'failed', error=error, now=NOW)
        assert 'error' not in table.update_item.call_args_list[0].kwargs['ExpressionAttributeNames'].values()

    @pytest.mark.parametrize(('length', 'stored'), [(499, 499), (500, 500), (501, 500), (2000, 500)])
    def test_error_is_cut_at_500_characters(self, length, stored):
        table = MagicMock()
        jobs.finish_job(table, 'rp_000000000001', 'failed', error='e' * length, now=NOW)
        values = table.update_item.call_args_list[0].kwargs['ExpressionAttributeValues']
        assert values[':v3'] == 'e' * stored

    def test_refused_worker_finish_leaves_the_lock_alone(self):
        table = MagicMock()
        table.update_item.side_effect = CONDITIONAL_FAILURE
        assert jobs.finish_job(table, 'rp_000000000001', 'completed', worker_token='tok') is None
        assert table.update_item.call_count == 1

    def test_refused_tokenless_finish_still_releases(self):
        table = MagicMock()
        table.update_item.side_effect = [CONDITIONAL_FAILURE, {}]
        assert jobs.finish_job(table, 'rp_000000000001', 'cancelled') is None
        assert table.update_item.call_args_list[1].kwargs['UpdateExpression'] == 'REMOVE active_job_id'

    def test_other_errors_propagate_from_the_transition(self):
        table = MagicMock()
        table.update_item.side_effect = OTHER_FAILURE
        with pytest.raises(ClientError) as info:
            jobs.claim_job(table, 'rp_000000000001', 'tok')
        assert info.value is OTHER_FAILURE
        assert table.update_item.call_count == 1

    def test_transition_returns_the_new_attributes(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'status': 'running', 'scanned': 3}}
        assert jobs.claim_job(table, 'rp_000000000001', 'tok') == {'status': 'running', 'scanned': 3}
        table.update_item.return_value = {}
        assert jobs.claim_job(table, 'rp_000000000001', 'tok') is None


class TestCancel:
    def test_cancel_writes_cancelled_and_releases(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'status': 'cancelled'}}
        assert jobs.cancel_job(table, 'rp_000000000001', now=NOW) == {'status': 'cancelled'}
        values = table.update_item.call_args_list[0].kwargs['ExpressionAttributeValues']
        assert values[':v0'] == 'cancelled'
        assert values[':v1'] == NOW_ISO
        assert values[':v2'] == NOW_ISO
        table.get_item.assert_not_called()

    def test_refused_cancel_reads_the_job_back(self):
        table = MagicMock()
        table.update_item.side_effect = CONDITIONAL_FAILURE
        table.get_item.return_value = {'Item': {'status': 'completed'}}
        assert jobs.cancel_job(table, 'rp_000000000001') == {'status': 'completed'}
        table.get_item.assert_called_once_with(Key=JOB_KEY, ConsistentRead=True)


class TestStoredBehaviour:
    def test_checkpoint_stores_cursor_and_counters(self, table):
        job = _present(_start(table))
        jobs.claim_job(table, job['sk'], 'tok', now=NOW)
        later = NOW + timedelta(seconds=30)
        jobs.checkpoint(table, job['sk'], {'scanned': 5, 'failed': 2}, {'pk': 'a', 'sk': 'b'}, 'tok', now=later)
        stored = _present(jobs.get_job(table, job['sk']))
        assert stored['cursor'] == {'pk': 'a', 'sk': 'b'}
        assert stored['scanned'] == 5
        assert stored['failed'] == 2
        assert stored['updated'] == 0
        assert stored['updated_at'] == later.isoformat()
        assert stored['status'] == 'running'
        assert stored['worker_token'] == 'tok'
        assert 'cursor' not in jobs.job_view(stored)

    def test_finished_error_is_stored_at_500_characters(self, table):
        job = _present(_start(table))
        jobs.finish_job(table, job['sk'], 'failed', error='x' * 501, now=NOW)
        view = jobs.job_view(_present(jobs.get_job(table, job['sk'])))
        assert view['error'] == 'x' * 500
        assert view['finished_at'] == NOW_ISO
        assert view['status'] == 'failed'
