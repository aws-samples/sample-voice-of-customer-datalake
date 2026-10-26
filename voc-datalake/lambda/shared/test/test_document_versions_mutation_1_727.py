"""Mutation hardening for `shared/document_versions.py`, lines 1-727.

`test_document_versions.py` drives the module end to end through moto: it
proves versions come out unique and that retries eventually succeed. A mutation
run over the title, legacy-planning and lease helpers found what that view
cannot see:

* the exact KEYS and PREFIXES the counter, assignment and allocation rows are
  stored under — a renamed prefix keeps every round trip consistent and fails
  no moto test, but strands every row an older deployment already wrote;
* the exact TRANSACTION and UPDATE shapes (condition expressions, attribute
  aliases, values): moto accepts a weaker condition, so only a literal pin
  shows that a lease check or an optimistic ``#last = :observed`` was dropped;
* the BOUNDARIES of the lease: a lease expiring this very second is still
  held (``>=``), a suffix equal to the counter floor is not reusable, and the
  retry budget is exactly four attempts with a 25 ms doubling backoff capped
  at 250 ms;
* the WORDING of every refusal, which reaches the API caller as the error body.
"""
from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import shared.document_versions as dv
from shared.document_versions import (
    VERSIONED_DOCUMENT_TYPES,
    _acquire_legacy_migration,
    _allocation_key,
    _assign_persisted_legacy_versions,
    _assign_unpersisted_legacy_versions,
    _creation_order,
    _historical_legacy_versions,
    _legacy_assignment_item,
    _legacy_assignment_key,
    _legacy_document_update,
    _legacy_migration_active,
    _legacy_suffix_version,
    _migration_backoff_seconds,
    _plan_legacy_series,
    _project_accepts_writes,
    _query_legacy_assignments,
    _raise_locked_high_water,
    _renew_legacy_migration,
    _requires_legacy_persistence,
    _transient,
    _wait_for_legacy_migration,
    canonical_document_title,
    normalize_document_versions,
    normalized_base_title,
    persist_legacy_document_versions,
    split_versioned_title,
    version_partition_key,
)
from shared.exceptions import ServiceError, ValidationError
from shared.project_writes import project_writable_condition
from shared.test.document_versions_fixtures import COUNTER_KEY, NOW_EPOCH, NOW_ISO, frozen_time
from shared.test.document_versions_fixtures import client_error as _client_error
from shared.test.document_versions_fixtures import mock_table as _table
from shared.test.document_versions_fixtures import sha as _sha
from shared.test.document_versions_fixtures import transactions as _transactions


@pytest.fixture(autouse=True)
def frozen_clock() -> Iterator[tuple[MagicMock, MagicMock]]:
    with frozen_time() as clock:
        yield clock


class TestStoredKeysKeepTheirPrefixes:
    def test_version_partition(self):
        assert version_partition_key('p1') == 'DOCUMENT_VERSIONS#PROJECT#p1'

    def test_legacy_assignment_key(self):
        assert _legacy_assignment_key(COUNTER_KEY, 'PRD#x') == {
            'pk': 'DOCUMENT_VERSIONS#PROJECT#p1',
            'sk': f"LEGACY_ASSIGNMENT#PRD#digest#{_sha('PRD#x')}",
        }

    def test_allocation_key(self):
        assert _allocation_key('p1', 'prd', 'a1') == {
            'pk': 'DOCUMENT_VERSIONS#PROJECT#p1',
            'sk': f"ALLOCATION#PRD#{_sha('a1')}",
        }

    def test_managed_types(self):
        assert frozenset({'prd', 'prfaq', 'prototype'}) == VERSIONED_DOCUMENT_TYPES


class TestProjectAcceptsWrites:
    @pytest.mark.parametrize(('meta', 'expected'), [
        (None, False),
        ({'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'deleting'}, False),
        ({'pk': 'PROJECT#p1', 'sk': 'META'}, True),
    ])
    def test_meta_row_decides(self, meta, expected):
        table = _table()
        table.get_item.return_value = {} if meta is None else {'Item': meta}
        assert _project_accepts_writes(table, 'p1') is expected
        table.get_item.assert_called_once_with(
            Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
        )


class TestTitles:
    @pytest.mark.parametrize(('title', 'expected'), [
        ('  Launch   Plan  (V3) ', ('Launch Plan', 3)),
        ('Plan (v10)', ('Plan', 10)),
        ('Plan (v0)', ('Plan (v0)', None)),
        ('Plan (v01)', ('Plan (v01)', None)),
        ('Plan(v2)', ('Plan(v2)', None)),
        ('Plan (v2) x', ('Plan (v2) x', None)),
        ('Plan v2', ('Plan v2', None)),
        ('\uff30lan', ('Plan', None)),
    ])
    def test_split(self, title, expected):
        assert split_versioned_title(title) == expected

    @pytest.mark.parametrize(('title', 'message'), [
        (5, 'Document title must be a string'),
        (None, 'Document title must be a string'),
        ('', 'Document title is required'),
        ('   ', 'Document title is required'),
    ])
    def test_split_refusals(self, title, message):
        with pytest.raises(ValidationError) as caught:
            split_versioned_title(title)
        assert caught.value.message == message

    def test_normalized_base_title_casefolds_without_suffix(self):
        assert normalized_base_title('Launch PLAN (v2)', 'prd') == 'launch plan'

    @pytest.mark.parametrize(('base', 'version', 'expected'), [
        ('Plan', 1, 'Plan (v1)'),
        ('Plan (v4)', 2, 'Plan (v2)'),
    ])
    def test_canonical_title(self, base, version, expected):
        assert canonical_document_title(base, version) == expected

    @pytest.mark.parametrize('version', [True, '1', 0, -1, 1.0])
    def test_canonical_title_refuses_non_positive_ints(self, version):
        with pytest.raises(ValueError, match=r'^Document version must be a positive integer$'):
            canonical_document_title('Plan', version)

    def test_creation_order(self):
        assert _creation_order({}) == ('', '', '')
        assert _creation_order({'created_at': 'c', 'document_id': 'd', 'sk': 's'}) == (
            'c', 'd', 's',
        )


def _doc(sk: str, created_at: str, **fields: Any) -> dict[str, Any]:
    return {'pk': 'PROJECT#p1', 'sk': sk, 'created_at': created_at, **fields}


def _identity(document: dict[str, Any]) -> tuple[Any, Any, Any]:
    return document['base_title'], document['version'], document['title']


class TestNormalizeDocumentVersions:
    def test_unmanaged_rows_pass_through_untouched_and_input_is_not_mutated(self):
        meta = {'pk': 'PROJECT#p1', 'sk': 'META', 'title': 'x'}
        prd = _doc('PRD#a', '1', title='A')
        result = normalize_document_versions([meta, prd])
        assert result[0] == meta
        assert prd == _doc('PRD#a', '1', title='A')
        assert _identity(result[1]) == ('A', 1, 'A (v1)')

    @pytest.mark.parametrize(('fields', 'expected'), [
        ({}, ('Untitled', 1, 'Untitled (v1)')),
        ({'title': 5}, ('Untitled', 1, 'Untitled (v1)')),
        ({'base_title': 'Base', 'title': 'Other (v4)'}, ('Base', 1, 'Base (v1)')),
        ({'title': 'X (v2)', 'version': 5}, ('X', 5, 'X (v5)')),
        ({'title': 'X', 'version': Decimal('3')}, ('X', 3, 'X (v3)')),
        ({'title': 'X (v2)'}, ('X', 2, 'X (v2)')),
    ])
    def test_single_document(self, fields, expected):
        [result] = normalize_document_versions([_doc('PRD#a', '1', **fields)])
        assert _identity(result) == expected

    def test_series_are_split_by_type_and_titled_by_their_earliest_member(self):
        documents = [
            _doc('PRD#late', '2', title='launch'),
            _doc('PRD#early', '1', title='Launch'),
            _doc('PRFAQ#a', '3', title='launch'),
            _doc('PROTOTYPE#a', '4', title='launch'),
        ]
        assert [_identity(d) for d in normalize_document_versions(documents)] == [
            ('Launch', 2, 'Launch (v2)'),
            ('Launch', 1, 'Launch (v1)'),
            ('launch', 1, 'launch (v1)'),
            ('launch', 1, 'launch (v1)'),
        ]

    def test_claims_go_first_and_free_versions_fill_from_one_in_creation_order(self):
        documents = [
            _doc('PRD#c', '3', title='T'),
            _doc('PRD#claim', '9', title='T (v1)'),
            _doc('PRD#b', '2', title='T'),
            _doc('PRD#high', '0', title='T (v4)'),
        ]
        assert [d['version'] for d in normalize_document_versions(documents)] == [3, 1, 2, 4]


class TestRequiresLegacyPersistence:
    @pytest.mark.parametrize(('document', 'expected'), [
        ({'base_title': 'A', 'title': 'A (v1)'}, True),
        ({'version': 1, 'title': 'A (v1)'}, True),
        ({'version': 1, 'base_title': 7, 'title': 'A (v1)'}, True),
        ({'version': 1, 'base_title': '  ', 'title': '  (v1)'}, True),
        ({'version': 1, 'base_title': 'A', 'title': 'A'}, True),
        ({'version': 1, 'base_title': 'A', 'title': 'A (v1)'}, False),
        ({'version': Decimal('2'), 'base_title': 'A', 'title': 'A (v2)'}, False),
    ])
    def test_only_a_fully_canonical_row_is_settled(self, document, expected):
        assert _requires_legacy_persistence(document) is expected


class TestLegacyPlanning:
    def test_historical_rows_skip_incomplete_and_map_both_ways(self):
        assignments = [
            {'source_document_sk': 'PRD#a', 'version': Decimal('2')},
            {'source_document_sk': 'PRD#a', 'version': 2},
            {'source_document_sk': '', 'version': 3},
            {'source_document_sk': 'PRD#b', 'version': 0},
            {'version': 4},
        ]
        assert _historical_legacy_versions(assignments) == ({'PRD#a': 2}, {2: 'PRD#a'})

    def test_historical_rows_refuse_a_shared_version(self):
        with pytest.raises(ServiceError) as caught:
            _historical_legacy_versions([
                {'source_document_sk': 'PRD#a', 'version': 2},
                {'source_document_sk': 'PRD#b', 'version': 2},
            ])
        assert caught.value.message == 'Duplicate persisted legacy document versions detected'

    def test_persisted_assignment_rows_win_then_document_versions(self):
        ordered = [
            {'sk': 'PRD#mapped', 'version': 3},
            {'sk': 'PRD#mapped_bare'},
            {'sk': 'PRD#own', 'version': 5},
            {'sk': 'PRD#none'},
        ]
        used_by = {3: 'PRD#mapped', 4: 'PRD#mapped_bare'}
        assigned = _assign_persisted_legacy_versions(
            ordered, {'PRD#mapped': 3, 'PRD#mapped_bare': 4}, used_by,
        )
        assert assigned == {'PRD#mapped': 3, 'PRD#mapped_bare': 4, 'PRD#own': 5}
        assert used_by == {3: 'PRD#mapped', 4: 'PRD#mapped_bare', 5: 'PRD#own'}

    @pytest.mark.parametrize(('ordered', 'historical', 'used_by', 'message'), [
        ([{'sk': 'PRD#a', 'version': 2}], {'PRD#a': 3}, {3: 'PRD#a'},
         'Legacy document version conflicts with its assignment'),
        ([{'sk': 'PRD#a', 'version': 2}], {}, {2: 'PRD#b'},
         'Duplicate persisted document versions detected'),
    ])
    def test_persisted_conflicts_refuse(self, ordered, historical, used_by, message):
        with pytest.raises(ServiceError) as caught:
            _assign_persisted_legacy_versions(ordered, historical, used_by)
        assert caught.value.message == message

    def test_own_version_already_claimed_by_itself_is_kept(self):
        assigned = _assign_persisted_legacy_versions(
            [{'sk': 'PRD#a', 'version': 2}], {}, {2: 'PRD#a'},
        )
        assert assigned == {'PRD#a': 2}

    @pytest.mark.parametrize(('document', 'floor', 'used_by', 'expected'), [
        ({'title': 'A (v3)', 'base_title': 'A (v9)'}, 0, {}, 3),
        ({'base_title': 'A (v9)'}, 0, {}, 9),
        ({'title': 'A (v3)'}, 2, {}, 3),
        ({'title': 'A (v3)'}, 3, {}, None),
        ({'title': 'A (v3)'}, 0, {3: 'PRD#x'}, None),
        ({'title': 'A'}, 0, {}, None),
        ({'title': 7}, 0, {}, None),
        ({}, 0, {}, None),
    ])
    def test_legacy_suffix(self, document, floor, used_by, expected):
        assert _legacy_suffix_version(document, floor, used_by) == expected

    def test_unpersisted_documents_take_suffixes_then_the_lowest_free_above_the_floor(self):
        ordered = [
            {'sk': 'PRD#a', 'title': 'T'},
            {'sk': 'PRD#b', 'title': 'T (v5)'},
            {'sk': 'PRD#c', 'title': 'T'},
            {'sk': 'PRD#done', 'title': 'T (v8)'},
        ]
        assigned = {'PRD#done': 3}
        used_by = {3: 'PRD#done'}
        _assign_unpersisted_legacy_versions(ordered, assigned, used_by, 2)
        assert assigned == {'PRD#done': 3, 'PRD#b': 5, 'PRD#a': 4, 'PRD#c': 6}
        assert used_by == {3: 'PRD#done', 5: 'PRD#b', 4: 'PRD#a', 6: 'PRD#c'}

    @pytest.mark.parametrize(('counter_base', 'expected_base'), [
        ('Stored (v2)', 'Stored'),
        (None, 'Earliest'),
        (7, 'Untitled'),
    ])
    def test_plan_titles_the_series_from_the_counter_then_the_earliest_document(
        self, counter_base, expected_base,
    ):
        documents = [
            {'sk': 'PRD#b', 'created_at': '2', 'title': 'Later'},
            {'sk': 'PRD#a', 'created_at': '1', 'base_title': 'Earliest', 'title': 'x'},
        ]
        planned = _plan_legacy_series(documents, [], counter_base, 0)
        assert [_identity(d) for d in planned] == [
            (expected_base, 2, f'{expected_base} (v2)'),
            (expected_base, 1, f'{expected_base} (v1)'),
        ]
        assert planned[0]['sk'] == 'PRD#b'

    def test_plan_falls_back_to_the_earliest_title_then_untitled(self):
        assert _plan_legacy_series(
            [{'sk': 'PRD#a', 'title': 'Named'}], [], None, 0,
        )[0]['base_title'] == 'Named'
        assert _plan_legacy_series([{'sk': 'PRD#a'}], [], None, 0)[0]['title'] == (
            'Untitled (v1)'
        )

    def test_plan_honours_assignment_rows(self):
        planned = _plan_legacy_series(
            [{'sk': 'PRD#a', 'title': 'T'}],
            [{'source_document_sk': 'PRD#a', 'version': 7}],
            None,
            0,
        )
        assert _identity(planned[0]) == ('T', 7, 'T (v7)')


class TestQueryLegacyAssignments:
    def test_pages_until_the_cursor_ends_and_keeps_only_dict_items(self):
        table = _table()
        table.query.side_effect = [
            {'Items': [{'v': 1}, 'junk'], 'LastEvaluatedKey': {'pk': 'k1'}},
            {'Items': 'junk', 'LastEvaluatedKey': {'pk': 'k2'}},
            {'Items': [{'v': 2}], 'LastEvaluatedKey': {}},
        ]
        assert _query_legacy_assignments(table, COUNTER_KEY) == [{'v': 1}, {'v': 2}]
        condition = (
            Key('pk').eq('DOCUMENT_VERSIONS#PROJECT#p1')
            & Key('sk').begins_with('LEGACY_ASSIGNMENT#PRD#digest#')
        )
        assert table.query.call_args_list == [
            call(KeyConditionExpression=condition, ConsistentRead=True),
            call(KeyConditionExpression=condition, ConsistentRead=True,
                 ExclusiveStartKey={'pk': 'k1'}),
            call(KeyConditionExpression=condition, ConsistentRead=True,
                 ExclusiveStartKey={'pk': 'k2'}),
        ]

    def test_a_non_dict_cursor_ends_the_walk(self):
        table = _table()
        table.query.side_effect = [{'Items': [{'v': 1}], 'LastEvaluatedKey': 'k'}]
        assert _query_legacy_assignments(table, COUNTER_KEY) == [{'v': 1}]

    def test_a_non_dict_response_ends_the_walk(self):
        table = _table()
        table.query.side_effect = [None]
        assert _query_legacy_assignments(table, COUNTER_KEY) == []


class TestLeaseTiming:
    @pytest.mark.parametrize(('attempt', 'seconds'), [
        (0, 0.025), (1, 0.05), (2, 0.1), (3, 0.2), (4, 0.25), (9, 0.25), (10_000, 0.25),
    ])
    def test_backoff(self, attempt, seconds):
        assert _migration_backoff_seconds(attempt) == pytest.approx(seconds)

    @pytest.mark.parametrize(('counter', 'expected'), [
        ({'migration_owner': 'o', 'migration_expires_at': NOW_EPOCH}, True),
        ({'migration_owner': 'o', 'migration_expires_at': Decimal(NOW_EPOCH + 1)}, True),
        ({'migration_owner': 'o', 'migration_expires_at': NOW_EPOCH - 1}, False),
        ({'migration_owner': '', 'migration_expires_at': NOW_EPOCH}, False),
        ({'migration_owner': 1, 'migration_expires_at': NOW_EPOCH}, False),
        ({'migration_owner': 'o', 'migration_expires_at': True}, False),
        ({'migration_owner': 'o', 'migration_expires_at': str(NOW_EPOCH)}, False),
        ({'migration_owner': 'o'}, False),
    ])
    def test_lease_is_held_through_its_expiry_second(self, counter, expected):
        assert _legacy_migration_active(counter) is expected

    def test_wait_returns_the_first_inactive_counter(self, frozen_clock):
        _, sleep = frozen_clock
        active = {'migration_owner': 'o', 'migration_expires_at': NOW_EPOCH}
        table = _table()
        table.get_item.side_effect = [{'Item': active}, {'Item': active}, {'Item': {'v': 1}}]
        assert _wait_for_legacy_migration(table, COUNTER_KEY) == {'v': 1}
        assert sleep.call_args_list == [call(0.025), call(0.05)]
        table.get_item.assert_called_with(Key=COUNTER_KEY, ConsistentRead=True)

    def test_wait_sleeps_no_longer_than_the_deadline_then_refuses(self, frozen_clock):
        monotonic, sleep = frozen_clock
        monotonic.side_effect = [0.0, 14.99, 15.0]
        active = {'migration_owner': 'o', 'migration_expires_at': NOW_EPOCH}
        table = _table()
        table.get_item.return_value = {'Item': active}
        with pytest.raises(ServiceError) as caught:
            _wait_for_legacy_migration(table, COUNTER_KEY)
        assert caught.value.message == 'Document versions are being initialized. Please retry.'
        assert sleep.call_count == 1
        assert sleep.call_args.args[0] == pytest.approx(0.01)


def _acquire(table: MagicMock, high_water: int = 3) -> int:
    return _acquire_legacy_migration(
        table, 'p1', COUNTER_KEY, 'prd', 'launch', 'Launch', high_water, 'me',
    )


UPDATE_NAMES = {
    '#last': 'last_version',
    '#owner': 'migration_owner',
    '#expires': 'migration_expires_at',
}


class TestAcquireLegacyMigration:
    @pytest.mark.parametrize('name', [None, '', 5])
    def test_needs_a_table_name(self, name):
        with pytest.raises(ValueError, match=r'^Projects table name is required for legacy migration$'):
            _acquire(_table(name))

    def test_a_missing_counter_is_created_with_the_lease(self):
        table = _table()
        table.get_item.return_value = {}
        assert _acquire(table) == 0
        assert _transactions(table) == [[
            project_writable_condition('projects', 'p1'),
            {'Put': {
                'TableName': 'projects',
                'Item': {
                    **COUNTER_KEY,
                    'document_type': 'prd',
                    'base_title': 'Launch',
                    'normalized_base_title': 'launch',
                    'last_version': 3,
                    'migration_owner': 'me',
                    'migration_expires_at': NOW_EPOCH + 5,
                    'updated_at': NOW_ISO,
                },
                'ConditionExpression': 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            }},
        ]]

    @pytest.mark.parametrize(('stored', 'high_water', 'last'), [(5, 3, 5), (2, 3, 3)])
    def test_an_existing_counter_is_leased_optimistically(
        self, stored, high_water, last,
    ):
        table = _table()
        table.get_item.return_value = {'Item': {
            **COUNTER_KEY, 'last_version': stored, 'base_title': 'Stored',
            'normalized_base_title': 'launch',
        }}
        assert _acquire(table, high_water) == stored
        assert _transactions(table)[0][1] == {'Update': {
            'TableName': 'projects',
            'Key': COUNTER_KEY,
            'UpdateExpression': (
                'SET #last = :last, base_title = :base, '
                'normalized_base_title = :normalized, #owner = :owner, '
                '#expires = :expires, updated_at = :now'
            ),
            'ConditionExpression': (
                '#last = :observed AND (attribute_not_exists(#owner) OR '
                'attribute_not_exists(#expires) OR #expires < :now_epoch)'
            ),
            'ExpressionAttributeNames': UPDATE_NAMES,
            'ExpressionAttributeValues': {
                ':last': last,
                ':base': 'Stored',
                ':normalized': 'launch',
                ':owner': 'me',
                ':expires': NOW_EPOCH + 5,
                ':now_epoch': NOW_EPOCH,
                ':now': NOW_ISO,
                ':observed': stored,
            },
        }}

    def test_a_counter_without_a_version_requires_the_attribute_absent(self):
        table = _table()
        table.get_item.return_value = {'Item': {**COUNTER_KEY, 'migration_owner': 'x'}}
        assert _acquire(table, 4) == 0
        update = _transactions(table)[0][1]['Update']
        assert update['ConditionExpression'].startswith('attribute_not_exists(#last) AND (')
        assert update['ExpressionAttributeValues'][':last'] == 4
        assert update['ExpressionAttributeValues'][':base'] == 'Launch'
        assert ':observed' not in update['ExpressionAttributeValues']

    def test_a_counter_for_another_title_is_refused(self):
        table = _table()
        table.get_item.return_value = {'Item': {'normalized_base_title': 'other'}}
        with pytest.raises(ServiceError) as caught:
            _acquire(table)
        assert caught.value.message == 'Document version counter title mismatch'
        table.meta.client.transact_write_items.assert_not_called()

    @pytest.mark.parametrize('error', [
        _client_error('ConditionalCheckFailedException'),
        _client_error('TransactionCanceledException', 'ConditionalCheckFailed'),
        _client_error('ThrottlingException'),
    ])
    def test_retryable_refusals_back_off_and_retry(self, frozen_clock, error):
        _, sleep = frozen_clock
        table = _table()
        table.get_item.side_effect = [{}, {'Item': {'pk': 'PROJECT#p1', 'sk': 'META'}}, {}, {}]
        table.meta.client.transact_write_items.side_effect = [error, None]
        assert _acquire(table) == 0
        assert len(_transactions(table)) == 2
        sleep.assert_called_once_with(0.025)

    def test_a_cancellation_on_a_deleted_project_is_final(self):
        table = _table()
        table.get_item.side_effect = [{}, {}]
        table.meta.client.transact_write_items.side_effect = [
            _client_error('TransactionCanceledException'),
        ]
        with pytest.raises(ServiceError) as caught:
            _acquire(table)
        assert caught.value.message == (
            'Project deletion has started; document versions cannot change.'
        )

    def test_a_non_retryable_error_is_re_raised(self):
        table = _table()
        table.get_item.return_value = {}
        error = _client_error('AccessDeniedException')
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _acquire(table)
        assert caught.value is error

    def test_retries_stop_at_the_deadline(self, frozen_clock):
        monotonic, sleep = frozen_clock
        monotonic.side_effect = [0.0, 14.9, 15.0]
        table = _table()
        table.get_item.return_value = {}
        table.meta.client.transact_write_items.side_effect = [
            _client_error('ThrottlingException'), _client_error('ThrottlingException'),
        ]
        with pytest.raises(ServiceError) as caught:
            _acquire(table)
        assert caught.value.message == 'Document versions are being initialized. Please retry.'
        assert sleep.call_args.args[0] == pytest.approx(0.025)
        assert sleep.call_count == 1


def _held(last: int, owner: str = 'me', expires: int = NOW_EPOCH) -> dict[str, Any]:
    return {'Item': {'last_version': last, 'migration_owner': owner,
                     'migration_expires_at': expires}}


class TestRaiseLockedHighWater:
    def test_raises_the_counter_under_the_lease(self):
        table = _table()
        table.get_item.return_value = _held(2)
        _raise_locked_high_water(table, COUNTER_KEY, 3, 'me')
        table.update_item.assert_called_once_with(
            Key=COUNTER_KEY,
            UpdateExpression='SET #last = :last, updated_at = :now',
            ConditionExpression=(
                '#owner = :owner AND #expires >= :now_epoch AND #last = :observed'
            ),
            ExpressionAttributeNames=UPDATE_NAMES,
            ExpressionAttributeValues={
                ':last': 3, ':observed': 2, ':owner': 'me',
                ':now_epoch': NOW_EPOCH, ':now': NOW_ISO,
            },
        )

    def test_a_counter_without_a_version_is_observed_as_zero(self):
        table = _table()
        table.get_item.return_value = {'Item': {
            'migration_owner': 'me', 'migration_expires_at': NOW_EPOCH,
        }}
        _raise_locked_high_water(table, COUNTER_KEY, 1, 'me')
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':observed'] == 0

    @pytest.mark.parametrize('stored', [3, 4])
    def test_a_counter_at_or_above_the_high_water_is_left(self, stored):
        table = _table()
        table.get_item.return_value = _held(stored)
        _raise_locked_high_water(table, COUNTER_KEY, 3, 'me')
        table.update_item.assert_not_called()

    @pytest.mark.parametrize('counter', [
        _held(2, owner='other'),
        _held(2, expires=NOW_EPOCH - 1),
        {'Item': {'last_version': 2, 'migration_owner': 'me'}},
    ])
    def test_a_lost_lease_refuses(self, counter):
        table = _table()
        table.get_item.return_value = counter
        with pytest.raises(ServiceError) as caught:
            _raise_locked_high_water(table, COUNTER_KEY, 3, 'me')
        assert caught.value.message == 'Document version migration lease was lost. Please retry.'

    def test_a_non_retryable_error_is_re_raised(self):
        table = _table()
        table.get_item.return_value = _held(2)
        error = _client_error('AccessDeniedException')
        table.update_item.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _raise_locked_high_water(table, COUNTER_KEY, 3, 'me')
        assert caught.value is error
        assert table.update_item.call_count == 1


class TestRenewLegacyMigration:
    def test_extends_the_lease_it_holds(self):
        table = _table()
        _renew_legacy_migration(table, COUNTER_KEY, 'me')
        table.update_item.assert_called_once_with(
            Key=COUNTER_KEY,
            UpdateExpression='SET #expires = :expires, updated_at = :now',
            ConditionExpression='#owner = :owner AND #expires >= :now_epoch',
            ExpressionAttributeNames={
                '#owner': 'migration_owner', '#expires': 'migration_expires_at',
            },
            ExpressionAttributeValues={
                ':owner': 'me', ':now_epoch': NOW_EPOCH,
                ':expires': NOW_EPOCH + 5, ':now': NOW_ISO,
            },
        )

    def test_a_lost_lease_refuses_at_once(self):
        table = _table()
        table.update_item.side_effect = [_client_error('ConditionalCheckFailedException')]
        with pytest.raises(ServiceError) as caught:
            _renew_legacy_migration(table, COUNTER_KEY, 'me')
        assert caught.value.message == 'Document version migration lease was lost. Please retry.'

    def test_a_non_transient_error_is_re_raised(self):
        table = _table()
        error = _client_error('AccessDeniedException')
        table.update_item.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _renew_legacy_migration(table, COUNTER_KEY, 'me')
        assert caught.value is error


def _raise_to_three(table: MagicMock) -> None:
    table.get_item.return_value = _held(2)
    _raise_locked_high_water(table, COUNTER_KEY, 3, 'me')


def _renew(table: MagicMock) -> None:
    _renew_legacy_migration(table, COUNTER_KEY, 'me')


LEASE_WRITES = [
    pytest.param(_raise_to_three, 'ConditionalCheckFailedException',
                 'Could not reserve legacy document versions. Please retry.', id='raise'),
    pytest.param(_renew, 'ThrottlingException',
                 'Could not renew document version migration. Please retry.', id='renew'),
]


class TestLeaseWritesRetryFourTimes:
    @pytest.mark.parametrize(('write', 'code', 'message'), LEASE_WRITES)
    def test_then_refuse(self, frozen_clock, write, code, message):
        _, sleep = frozen_clock
        table = _table()
        table.update_item.side_effect = [_client_error(code)] * 4
        with pytest.raises(ServiceError) as caught:
            write(table)
        assert caught.value.message == message
        assert table.update_item.call_count == 4
        assert sleep.call_args_list == [call(0.025), call(0.05), call(0.1)]

    @pytest.mark.parametrize(('write', 'code'), [
        pytest.param(_raise_to_three, 'ConditionalCheckFailedException', id='raise'),
        pytest.param(_renew, 'ThrottlingException', id='renew'),
    ])
    def test_or_stop_at_the_first_success(self, write, code):
        table = _table()
        table.update_item.side_effect = [_client_error(code), None]
        write(table)
        assert table.update_item.call_count == 2


CANONICAL = {'base_title': 'T', 'version': 2, 'title': 'T (v2)'}


class TestLegacyWrites:
    def test_assignment_item(self):
        original = {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'document_id': 'a'}
        assert _legacy_assignment_item(COUNTER_KEY, 'prd', 't', original, CANONICAL) == {
            **_legacy_assignment_key(COUNTER_KEY, 'PRD#a'),
            'source_document_sk': 'PRD#a',
            'document_id': 'a',
            'document_type': 'prd',
            'normalized_base_title': 't',
            'base_title': 'T',
            'version': 2,
            'title': 'T (v2)',
        }

    def test_assignment_item_without_ids(self):
        item = _legacy_assignment_item(COUNTER_KEY, 'prd', 't', {}, CANONICAL)
        assert (item['source_document_sk'], item['document_id']) == ('', '')

    def test_a_canonical_document_needs_no_update(self):
        assert _legacy_document_update('projects', {**CANONICAL, 'pk': 'x', 'sk': 'y'}, CANONICAL) is None

    def test_update_guards_every_observed_attribute(self):
        original = {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'title': 'T', 'version': 2}
        assert _legacy_document_update('projects', original, CANONICAL) == {'Update': {
            'TableName': 'projects',
            'Key': {'pk': 'PROJECT#p1', 'sk': 'PRD#a'},
            'UpdateExpression': 'SET #base = :base, #version = :version, #title = :title',
            'ConditionExpression': (
                'attribute_exists(pk) AND attribute_exists(sk) AND '
                'attribute_not_exists(#base) AND #version = :observed_version AND '
                '#title = :observed_title'
            ),
            'ExpressionAttributeNames': {
                '#base': 'base_title', '#version': 'version', '#title': 'title',
            },
            'ExpressionAttributeValues': {
                ':base': 'T', ':version': 2, ':title': 'T (v2)',
                ':observed_version': 2, ':observed_title': 'T',
            },
        }}

    def test_update_of_a_bare_row_requires_every_attribute_absent(self):
        original = {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'base_title': 'T'}
        update = _legacy_document_update('projects', original, CANONICAL)
        assert update is not None
        assert update['Update']['ConditionExpression'] == (
            'attribute_exists(pk) AND attribute_exists(sk) AND #base = :observed_base_title '
            'AND attribute_not_exists(#version) AND attribute_not_exists(#title)'
        )


class TestTransientErrors:
    @pytest.mark.parametrize(('error', 'expected'), [
        (_client_error('ProvisionedThroughputExceededException'), True),
        (_client_error('ThrottlingException'), True),
        (_client_error('TransactionConflictException'), True),
        (_client_error('AccessDeniedException'), False),
        (_client_error('TransactionCanceledException'), True),
        (_client_error('TransactionCanceledException', 'None'), True),
        (_client_error('TransactionCanceledException', 'TransactionConflict'), True),
        (_client_error('TransactionCanceledException', 'ThrottlingError'), True),
        (_client_error('TransactionCanceledException',
                       'ProvisionedThroughputExceeded'), True),
        (_client_error('TransactionCanceledException', 'Other'), False),
        (_client_error('TransactionCanceledException',
                       'ThrottlingError', 'ConditionalCheckFailed'), False),
        (_client_error('TransactionCanceledException',
                       'ThrottlingError', 'ItemCollectionSizeLimitExceeded'),
         False),
        (_client_error('TransactionCanceledException',
                       'ThrottlingError', 'ValidationError'), False),
    ])
    def test_classification(self, error, expected):
        assert _transient(error) is expected


class TestPersistLegacyDocumentVersions:
    def test_settled_series_are_not_written(self):
        table = _table()
        documents = [
            {'pk': 'PROJECT#p1', 'sk': 'META'},
            {'pk': 'PROJECT#p1', 'sk': 'PRD#a', **CANONICAL},
        ]
        assert persist_legacy_document_versions(table, 'p1', documents) == documents
        table.get_item.assert_not_called()
        table.query.assert_not_called()

    def test_each_unsettled_series_is_persisted_once_with_its_own_title_key(self):
        documents = [
            {'pk': 'PROJECT#p1', 'sk': 'META'},
            {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'title': 5},
            {'pk': 'PROJECT#p1', 'sk': 'PRD#b', **CANONICAL},
            {'pk': 'PROJECT#p1', 'sk': 'PRD#n'},
            {'pk': 'PROJECT#p1', 'sk': 'PRFAQ#c', 'base_title': 'Base', 'title': 'Other'},
        ]
        with patch.object(dv, '_persist_legacy_series') as series:
            series.side_effect = lambda _t, _p, _type, _n, docs: [
                {**d, 'planned': True} for d in docs
            ]
            result = persist_legacy_document_versions(_table(), 'p1', documents)
        assert [
            (c.args[2], c.args[3], [d['sk'] for d in c.args[4]])
            for c in series.call_args_list
        ] == [
            ('prd', 'untitled', ['PRD#a', 'PRD#n']),
            ('prfaq', 'base', ['PRFAQ#c']),
        ]
        assert [d.get('planned') for d in result] == [None, True, None, True, True]
        assert result[0] == documents[0]
        assert _identity(result[2]) == ('T', 2, 'T (v2)')


SERIES_KEY = dv._counter_key('p1', 'prd', 't')


@pytest.fixture
def series() -> Iterator[dict[str, MagicMock]]:
    with (
        patch.object(dv, '_query_legacy_assignments') as assignments,
        patch.object(dv, '_get_item') as get_item,
        patch.object(dv, '_acquire_legacy_migration') as acquire,
        patch.object(dv, '_raise_locked_high_water') as raise_high,
        patch.object(dv, '_persist_legacy_identity') as persist,
        patch.object(dv, '_release_legacy_migration') as release,
        patch.object(dv, 'uuid4') as uuid4,
    ):
        uuid4.return_value.hex = 'owner'
        yield {
            'assignments': assignments, 'get_item': get_item, 'acquire': acquire,
            'raise_high': raise_high, 'persist': persist, 'release': release,
        }


class TestPersistLegacySeries:
    """The plan before the lease seeds the lease; the plan after it is what is written."""

    def test_plans_from_the_counter_then_from_the_floor_won_with_the_lease(self, series):
        table = _table()
        documents = [{'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'title': 'T'}]
        series['assignments'].side_effect = [[], []]
        series['get_item'].side_effect = [
            {'last_version': 4, 'base_title': 'Stored'},
            {'last_version': 6, 'base_title': 'Leased'},
        ]
        series['acquire'].return_value = 6
        planned = dv._persist_legacy_series(table, 'p1', 'prd', 't', documents)
        assert _identity(planned[0]) == ('Leased', 7, 'Leased (v7)')
        series['acquire'].assert_called_once_with(
            table, 'p1', SERIES_KEY, 'prd', 't', 'Stored', 5, 'owner',
        )
        series['raise_high'].assert_called_once_with(table, SERIES_KEY, 7, 'owner')
        series['persist'].assert_called_once_with(
            table, 'p1', SERIES_KEY, 'prd', 't', 'owner', documents[0], planned[0], None,
        )
        series['release'].assert_called_once_with(table, SERIES_KEY, 'owner')
        assert series['assignments'].call_args_list == [call(table, SERIES_KEY)] * 2
        assert series['get_item'].call_args_list == [call(table, SERIES_KEY)] * 2

    def test_an_existing_assignment_is_handed_to_the_write(self, series):
        table = _table()
        documents = [
            {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'title': 'T'},
            {'pk': 'PROJECT#p1', 'sk': 'PRD#b', 'title': 'T'},
        ]
        assignment = {'source_document_sk': 'PRD#b', 'version': 1}
        series['assignments'].side_effect = [[assignment], [assignment]]
        series['get_item'].return_value = {}
        series['acquire'].return_value = 0
        dv._persist_legacy_series(table, 'p1', 'prd', 't', documents)
        assert [c.args[-1] for c in series['persist'].call_args_list] == [None, assignment]
        series['acquire'].assert_called_once_with(
            table, 'p1', SERIES_KEY, 'prd', 't', 'T', 2, 'owner',
        )

    @pytest.mark.parametrize(('document', 'assignment', 'message'), [
        ({'pk': 'PROJECT#p1', 'title': 'T'}, None,
         'Legacy managed document has no sort key'),
        ({'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'title': 'T'},
         {'source_document_sk': 'PRD#a', 'version': 0},
         'Conflicting legacy document version assignment'),
    ])
    def test_refusals_still_release_the_lease(self, series, document, assignment, message):
        table = _table()
        assignments = [] if assignment is None else [assignment]
        series['assignments'].side_effect = [assignments, assignments]
        series['get_item'].return_value = {}
        series['acquire'].return_value = 0
        with pytest.raises(ServiceError) as caught:
            dv._persist_legacy_series(table, 'p1', 'prd', 't', [document])
        assert caught.value.message == message
        series['persist'].assert_not_called()
        series['release'].assert_called_once_with(table, SERIES_KEY, 'owner')


class TestIncompleteRowsDoNotStopTheWalk:
    def test_an_incomplete_assignment_row_is_skipped_not_final(self):
        assert _historical_legacy_versions([
            {'version': 3},
            {'source_document_sk': 'PRD#a', 'version': 2},
        ]) == ({'PRD#a': 2}, {2: 'PRD#a'})

    def test_a_row_without_a_sort_key_is_tracked_under_the_empty_identity(self):
        used_by: dict[int, str] = {}
        assert _assign_persisted_legacy_versions([{'version': 2}], {}, used_by) == {'': 2}
        assert used_by == {2: ''}

    def test_the_wait_backoff_keeps_doubling(self, frozen_clock):
        _, sleep = frozen_clock
        active = {'Item': {'migration_owner': 'o', 'migration_expires_at': NOW_EPOCH}}
        table = _table()
        table.get_item.side_effect = [active, active, active, {}]
        assert _wait_for_legacy_migration(table, COUNTER_KEY) == {}
        assert sleep.call_args_list == [call(0.025), call(0.05), call(0.1)]

    def test_an_assignment_without_a_source_matches_no_document(self, series):
        table = _table()
        documents = [{'pk': 'PROJECT#p1', 'sk': 'XXXX', 'title': 'T'}]
        orphan = {'version': 5}
        series['assignments'].side_effect = [[orphan], [orphan]]
        series['get_item'].return_value = {}
        series['acquire'].return_value = 0
        dv._persist_legacy_series(table, 'p1', 'prd', 't', documents)
        assert series['persist'].call_args.args[-1] is None


class TestLeaseEdgeCases:
    def test_acquire_backoff_keeps_doubling(self, frozen_clock):
        _, sleep = frozen_clock
        table = _table()
        table.get_item.return_value = {}
        throttled = _client_error('ThrottlingException')
        table.meta.client.transact_write_items.side_effect = [throttled] * 3 + [None]
        assert _acquire(table) == 0
        assert sleep.call_args_list == [call(0.025), call(0.05), call(0.1)]

    def test_an_existing_counter_without_a_version_takes_the_high_water(self):
        table = _table()
        table.get_item.return_value = {'Item': {**COUNTER_KEY}}
        _acquire(table, 1)
        assert _transactions(table)[0][1]['Update']['ExpressionAttributeValues'][':last'] == 1

    def test_a_lease_without_an_expiry_is_lost_even_at_epoch_one(self):
        table = _table()
        table.get_item.return_value = {'Item': {'last_version': 2, 'migration_owner': 'me'}}
        with patch.object(dv.time, 'time', return_value=1), pytest.raises(ServiceError) as caught:
            _raise_locked_high_water(table, COUNTER_KEY, 3, 'me')
        assert caught.value.message == 'Document version migration lease was lost. Please retry.'
        table.update_item.assert_not_called()
