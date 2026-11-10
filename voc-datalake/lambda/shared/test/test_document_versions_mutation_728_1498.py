"""Mutation hardening for `shared/document_versions.py`, lines 728-1498.

`test_document_versions.py` proves through moto that allocations come out
unique, that a deleted allocation cannot be replayed and that a deleted
project fences every write. A mutation run over the legacy identity writes,
the allocation-history guards and `persist_versioned_document` found what that
end-to-end view cannot see:

* the exact TRANSACTION each path commits (counter Put vs optimistic Update,
  the allocation row, the document, the META count bump, the lease
  ConditionCheck): moto accepts a weaker condition, so only a literal pin shows
  that a guard was dropped;
* WHICH refusal each failure ends in. A refused write is retried only while it
  is transient, the counter moved or a migration holds the lease; every other
  cause has its own message, and that message is the API error body;
* the RETRY budget: exactly four attempts, a 25 ms doubling backoff, and the
  replay check that turns a lost race into the winner's document;
* the small parsers (`_positive_int`, `_managed_document_type`, the paging
  walks) at their boundaries: 0, 1, a fractional Decimal, a bare prefix.
"""
import re
from collections.abc import Callable, Iterator
from dataclasses import FrozenInstanceError
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import shared.document_versions as dv
from shared.document_versions import (
    _allocation_item,
    _allocation_retryable,
    _assert_allocation_item,
    _assert_allocation_reference,
    _conditional_failure,
    _counter_key,
    _counter_moved,
    _document_key,
    _ensure_allocation_history,
    _existing_document,
    _get_item,
    _legacy_assignment_item,
    _legacy_assignment_key,
    _legacy_document_update,
    _legacy_identity_settled,
    _persist_legacy_identity,
    _positive_int,
    _query_project_documents,
    _release_legacy_migration,
    _require_expected_version,
    _series_state,
    _transient,
    _VersionCandidate,
    get_versioned_document_by_allocation,
    managed_document_type,
    persist_versioned_document,
    preserve_versioned_document_allocation,
    versioned_document_id,
)
from shared.exceptions import ConflictError, ServiceError, ValidationError
from shared.project_writes import (
    PROJECT_WRITABLE_ATTRIBUTE_NAMES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
    project_writable_condition,
)
from shared.test.document_versions_fixtures import COUNTER_KEY, NOW_EPOCH, NOW_ISO, frozen_time
from shared.test.document_versions_fixtures import client_error as _client_error
from shared.test.document_versions_fixtures import mock_table as _table
from shared.test.document_versions_fixtures import sha as _sha
from shared.test.document_versions_fixtures import transactions as _transactions


@pytest.fixture(autouse=True)
def frozen_clock() -> Iterator[tuple[MagicMock, MagicMock]]:
    with frozen_time() as clock:
        yield clock


PARTITION = 'DOCUMENT_VERSIONS#PROJECT#p1'
META = {'pk': 'PROJECT#p1', 'sk': 'META'}
NOT_EXISTS = 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
CANONICAL = {'base_title': 'T', 'version': 2, 'title': 'T (v2)'}
LEASE_LOST = 'Legacy document changed or its migration lease was lost. Please retry.'
NO_VERSION = 'Could not allocate a document version. Please retry.'
CONFLICT = 'Document allocation history conflict detected'
DOC_ID = f"prd_{_sha('p1|prd|a1')[:20]}"
DOC_KEY = {'pk': 'PROJECT#p1', 'sk': f'PRD#{DOC_ID}'}
ALLOCATION_KEY = {'pk': PARTITION, 'sk': f"ALLOCATION#PRD#{_sha('a1')}"}
SERIES_KEY = {'pk': PARTITION, 'sk': f"PRD#{_sha('launch')}"}


def _store(*items: dict[str, Any], name: object = 'projects') -> MagicMock:
    """A mock table whose ``get_item`` reads ``table.rows`` (mutable) by key."""
    table = _table(name)
    table.rows = {(item['pk'], item['sk']): item for item in items}

    def get_item(**kwargs: Any) -> dict[str, Any]:
        assert set(kwargs) == {'Key', 'ConsistentRead'}
        key = kwargs['Key']
        row = table.rows.get((key['pk'], key['sk']))
        return {} if row is None else {'Item': row}

    table.get_item.side_effect = get_item
    return table


def _refusal(caught: pytest.ExceptionInfo[ServiceError]) -> str:
    return caught.value.message


def _generated(**overrides: Any) -> dict[str, Any]:
    """A committed generated PRD v1 for allocation ``a1``."""
    return {
        **DOC_KEY,
        'document_id': DOC_ID,
        'document_type': 'prd',
        'base_title': 'Launch',
        'version': 1,
        'title': 'Launch (v1)',
        'created_at': NOW_ISO,
        'version_allocation_id': 'a1',
        **overrides,
    }


def _allocation_row(**overrides: Any) -> dict[str, Any]:
    return {
        **ALLOCATION_KEY,
        'allocation_id': 'a1',
        'document_id': DOC_ID,
        'document_pk': DOC_KEY['pk'],
        'document_sk': DOC_KEY['sk'],
        'document_type': 'prd',
        'base_title': 'Launch',
        'version': 1,
        'title': 'Launch (v1)',
        'created_at': NOW_ISO,
        **overrides,
    }


class TestLegacyDocumentUpdate:
    def test_a_partly_canonical_row_is_still_updated(self):
        original = {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'base_title': 'T', 'version': 2}
        update = _legacy_document_update('projects', original, CANONICAL)
        assert update is not None
        assert update['Update']['ExpressionAttributeValues'] == {
            ':base': 'T', ':version': 2, ':title': 'T (v2)',
            ':observed_base_title': 'T', ':observed_version': 2,
        }


ORIGINAL = {'pk': 'PROJECT#p1', 'sk': 'PRD#a', 'document_id': 'a', 'title': 'T'}
LEASE_CHECK = {'ConditionCheck': {
    'TableName': 'projects',
    'Key': COUNTER_KEY,
    'ConditionExpression': '#owner = :owner AND #expires >= :now_epoch',
    'ExpressionAttributeNames': {
        '#owner': 'migration_owner', '#expires': 'migration_expires_at',
    },
    'ExpressionAttributeValues': {':owner': 'me', ':now_epoch': NOW_EPOCH},
}}
ASSIGNMENT_PUT = {'Put': {
    'TableName': 'projects',
    'Item': _legacy_assignment_item(COUNTER_KEY, 'prd', 't', ORIGINAL, CANONICAL),
    'ConditionExpression': NOT_EXISTS,
}}


def _persist_identity(
    table: MagicMock,
    original: dict[str, Any] = ORIGINAL,
    existing: dict[str, Any] | None = None,
) -> None:
    _persist_legacy_identity(
        table, 'p1', COUNTER_KEY, 'prd', 't', 'me', original, CANONICAL, existing,
    )


class TestPersistLegacyIdentity:
    @pytest.mark.parametrize('name', [None, '', 5])
    def test_needs_a_table_name(self, name):
        with pytest.raises(ValueError, match=r'^Projects table name is required for legacy migration$'):
            _persist_identity(_table(name))

    def test_writes_assignment_and_document_under_the_renewed_lease(self):
        table = _table()
        _persist_identity(table)
        assert table.update_item.call_args.kwargs['UpdateExpression'] == (
            'SET #expires = :expires, updated_at = :now'
        )
        assert _transactions(table) == [[
            project_writable_condition('projects', 'p1'),
            LEASE_CHECK,
            ASSIGNMENT_PUT,
            _legacy_document_update('projects', ORIGINAL, CANONICAL),
        ]]

    def test_a_canonical_document_still_gets_its_assignment_row(self):
        table = _table()
        original = {**ORIGINAL, **CANONICAL}
        _persist_identity(table, original)
        assert _transactions(table)[0][2:] == [{'Put': {
            'TableName': 'projects',
            'Item': _legacy_assignment_item(COUNTER_KEY, 'prd', 't', original, CANONICAL),
            'ConditionExpression': NOT_EXISTS,
        }}]

    @pytest.mark.parametrize(('original', 'existing'), [
        ({**ORIGINAL, 'version_allocation_id': 'job'}, None),
        (ORIGINAL, {'source_document_sk': 'PRD#a', 'version': 2}),
    ])
    def test_an_allocated_or_assigned_document_only_needs_its_update(self, original, existing):
        table = _table()
        _persist_identity(table, original, existing)
        assert _transactions(table)[0][2:] == [
            _legacy_document_update('projects', original, CANONICAL),
        ]

    def test_nothing_to_write_writes_nothing(self):
        table = _table()
        _persist_identity(table, {**ORIGINAL, **CANONICAL}, {'version': 2})
        table.update_item.assert_not_called()
        table.meta.client.transact_write_items.assert_not_called()

    def test_a_refused_write_already_settled_is_done(self):
        table = _table()
        table.meta.client.transact_write_items.side_effect = [_client_error('ThrottlingException')]
        with patch.object(dv, '_legacy_identity_settled', return_value=True) as settled:
            _persist_identity(table)
        settled.assert_called_once_with(table, COUNTER_KEY, ORIGINAL, CANONICAL, True)
        assert len(_transactions(table)) == 1

    def test_transient_refusals_retry_four_times_then_refuse(self, frozen_clock):
        _, sleep = frozen_clock
        table = _table()
        table.meta.client.transact_write_items.side_effect = [
            _client_error('ThrottlingException'),
        ] * 4
        with (
            patch.object(dv, '_legacy_identity_settled', return_value=False),
            pytest.raises(ServiceError) as caught,
        ):
            _persist_identity(table)
        assert _refusal(caught) == 'Could not persist legacy document versions. Please retry.'
        assert len(_transactions(table)) == 4
        assert sleep.call_args_list == [call(0.025), call(0.05), call(0.1)]

    def test_a_transient_refusal_then_success_stops(self):
        table = _table()
        table.meta.client.transact_write_items.side_effect = [
            _client_error('ThrottlingException'), None,
        ]
        with patch.object(dv, '_legacy_identity_settled', return_value=False):
            _persist_identity(table)
        assert len(_transactions(table)) == 2

    def test_a_permanent_cancellation_names_the_lost_lease(self):
        table = _table()
        table.meta.client.transact_write_items.side_effect = [
            _client_error('TransactionCanceledException', 'ConditionalCheckFailed'),
        ]
        with (
            patch.object(dv, '_legacy_identity_settled', return_value=False),
            pytest.raises(ServiceError) as caught,
        ):
            _persist_identity(table)
        assert _refusal(caught) == LEASE_LOST
        assert len(_transactions(table)) == 1

    def test_any_other_error_is_re_raised(self):
        table = _table()
        error = _client_error('AccessDeniedException')
        table.meta.client.transact_write_items.side_effect = [error]
        with (
            patch.object(dv, '_legacy_identity_settled', return_value=False),
            pytest.raises(ClientError) as caught,
        ):
            _persist_identity(table)
        assert caught.value is error


SOURCE = {'pk': 'PROJECT#p1', 'sk': 'PRD#a'}
ASSIGNMENT_KEY = _legacy_assignment_key(COUNTER_KEY, 'PRD#a')


def _settled(table: MagicMock, required: bool) -> bool:
    return _legacy_identity_settled(table, COUNTER_KEY, dict(SOURCE), CANONICAL, required)


class TestLegacyIdentitySettled:
    def test_a_deleted_document_is_settled(self):
        table = _store()
        assert _settled(table, True) is True
        table.get_item.assert_called_once_with(Key=SOURCE, ConsistentRead=True)

    def test_a_canonical_document_without_an_assignment_to_check(self):
        table = _store({**SOURCE, **CANONICAL})
        assert _settled(table, False) is True
        assert table.get_item.call_count == 1

    @pytest.mark.parametrize('key', ['base_title', 'version', 'title'])
    def test_any_differing_identity_field_is_unsettled(self, key):
        table = _store({**SOURCE, **CANONICAL, key: 'other'})
        assert _settled(table, False) is False

    @pytest.mark.parametrize(('assignment', 'expected'), [
        ({'source_document_sk': 'PRD#a', 'version': Decimal('2')}, True),
        ({'source_document_sk': 'PRD#b', 'version': 2}, False),
        ({'source_document_sk': 'PRD#a', 'version': 3}, False),
        (None, False),
    ])
    def test_a_required_assignment_must_match(self, assignment, expected):
        rows = [{**SOURCE, **CANONICAL}]
        if assignment is not None:
            rows.append({**ASSIGNMENT_KEY, **assignment})
        assert _settled(_store(*rows), True) is expected

    def test_a_matching_assignment_does_not_settle_a_stale_document(self):
        table = _store(
            {**SOURCE, **CANONICAL, 'version': 1},
            {**ASSIGNMENT_KEY, 'source_document_sk': 'PRD#a', 'version': 2},
        )
        assert _settled(table, True) is False

    def test_a_document_without_a_sort_key_is_looked_up_by_the_empty_identity(self):
        table = _table()
        table.get_item.side_effect = [{'Item': dict(CANONICAL)}, {}]
        original: dict[str, Any] = {'pk': 'PROJECT#p1', 'sk': None}
        assert _legacy_identity_settled(table, COUNTER_KEY, original, CANONICAL, True) is False
        assert table.get_item.call_args_list[1] == call(
            Key=_legacy_assignment_key(COUNTER_KEY, ''), ConsistentRead=True,
        )


class TestReleaseLegacyMigration:
    def test_removes_the_lease_it_owns(self):
        table = _table()
        _release_legacy_migration(table, COUNTER_KEY, 'me')
        table.update_item.assert_called_once_with(
            Key=COUNTER_KEY,
            UpdateExpression='SET updated_at = :now REMOVE #owner, #expires',
            ConditionExpression='#owner = :owner',
            ExpressionAttributeNames={
                '#owner': 'migration_owner', '#expires': 'migration_expires_at',
            },
            ExpressionAttributeValues={':owner': 'me', ':now': NOW_ISO},
        )

    def test_a_lease_already_gone_is_silent(self):
        table = _table()
        table.update_item.side_effect = [_client_error('ConditionalCheckFailedException')]
        with patch.object(dv, 'logger') as logger:
            _release_legacy_migration(table, COUNTER_KEY, 'me')
        logger.warning.assert_not_called()

    @pytest.mark.parametrize(('error', 'code'), [
        (_client_error('ThrottlingException'), 'ThrottlingException'),
        (ClientError({'Error': {}}, 'Op'), 'Unknown'),
    ])
    def test_any_other_failure_is_logged_and_left_to_expire(self, error, code):
        table = _table()
        table.update_item.side_effect = [error]
        with patch.object(dv, 'logger') as logger:
            _release_legacy_migration(table, COUNTER_KEY, 'me')
        logger.warning.assert_called_once_with(
            'Document version migration lease release failed; lease will expire',
            extra={'error_code': code},
        )


class TestConditionalFailure:
    @pytest.mark.parametrize(('error', 'expected'), [
        (_client_error('ConditionalCheckFailedException'), True),
        (_client_error('TransactionCanceledException'), False),
        (ClientError({}, 'Op'), False),
    ])
    def test_only_the_conditional_check_code(self, error, expected):
        assert _conditional_failure(error) is expected


class TestDocumentIdentity:
    def test_versioned_document_id(self):
        assert versioned_document_id('p1', 'prd', 'a1') == DOC_ID
        assert versioned_document_id('p1', 'prototype', 'a1') == (
            f"prototype_{_sha('p1|prototype|a1')[:20]}"
        )

    @pytest.mark.parametrize(('args', 'message'), [
        ((None, 'prd', 'a1'), 'A project id is required for document persistence'),
        (('  ', 'prd', 'a1'), 'A project id is required for document persistence'),
        (('p1', 'note', 'a1'), "'note' is not a version-managed document type"),
        (('p1', 3, 'a1'), '3 is not a version-managed document type'),
        (('p1', 'prd', None), 'A stable document allocation id is required'),
        (('p1', 'prd', ' '), 'A stable document allocation id is required'),
    ])
    def test_refusals(self, args, message):
        with pytest.raises(ValueError, match=f'^{re.escape(message)}$'):
            versioned_document_id(*args)

    def test_document_key(self):
        assert _document_key('p1', 'prd', 'a1') == DOC_KEY

    def test_counter_key(self):
        assert _counter_key('p1', 'prd', 'launch') == SERIES_KEY


class TestAllocationItem:
    def test_copies_the_committed_identity(self):
        assert _allocation_item('p1', 'prd', 'a1', _generated(version=Decimal('1'))) == (
            _allocation_row()
        )

    @pytest.mark.parametrize('override', [
        {'pk': 'PROJECT#p2'},
        {'sk': 'PRD#other'},
        {'document_id': 'other'},
        {'version': 0},
        {'base_title': 5},
        {'base_title': ''},
        {'title': 5},
        {'title': ''},
        {'created_at': 5},
        {'created_at': ''},
    ])
    def test_an_incomplete_document_is_refused(self, override):
        with pytest.raises(ServiceError) as caught:
            _allocation_item('p1', 'prd', 'a1', _generated(**override))
        assert _refusal(caught) == 'Stored generated document allocation is incomplete'


class TestAllocationAssertions:
    def test_a_matching_reference_passes_whatever_its_identity(self):
        row = _allocation_row(version=9, extra=1)
        assert _assert_allocation_reference(row, 'p1', 'prd', 'a1') is None

    @pytest.mark.parametrize('key', [
        'pk', 'sk', 'allocation_id', 'document_id', 'document_pk', 'document_sk',
        'document_type',
    ])
    def test_any_differing_reference_field_is_a_conflict(self, key):
        with pytest.raises(ServiceError) as caught:
            _assert_allocation_reference(_allocation_row(**{key: 'x'}), 'p1', 'prd', 'a1')
        assert _refusal(caught) == CONFLICT

    def test_an_item_must_match_every_expected_field(self):
        _assert_allocation_item({'a': 1, 'b': 2, 'extra': 3}, {'a': 1, 'b': 2})
        with pytest.raises(ServiceError) as caught:
            _assert_allocation_item({'a': 1, 'b': 3}, {'a': 1, 'b': 2})
        assert _refusal(caught) == CONFLICT


HISTORY_PUT = [
    project_writable_condition('projects', 'p1'),
    {'Put': {
        'TableName': 'projects', 'Item': _allocation_row(), 'ConditionExpression': NOT_EXISTS,
    }},
]


def _ensure(table: MagicMock) -> None:
    _ensure_allocation_history(table, 'p1', 'prd', 'a1', _generated())


class TestEnsureAllocationHistory:
    def test_a_matching_history_row_is_kept(self):
        table = _store(_allocation_row(extra='kept'))
        _ensure(table)
        table.meta.client.transact_write_items.assert_not_called()
        table.get_item.assert_called_once_with(Key=ALLOCATION_KEY, ConsistentRead=True)

    def test_a_differing_history_row_is_a_conflict(self):
        with pytest.raises(ServiceError) as caught:
            _ensure(_store(_allocation_row(version=2)))
        assert _refusal(caught) == CONFLICT

    @pytest.mark.parametrize('name', [None, '', 5])
    def test_a_missing_row_needs_a_table_name(self, name):
        with pytest.raises(ValueError, match=r'^Projects table name is required for allocation history$'):
            _ensure(_store(name=name))

    def test_a_missing_row_is_written_under_the_project_fence(self):
        table = _store()
        _ensure(table)
        assert _transactions(table) == [HISTORY_PUT]

    def test_a_lost_race_to_the_same_row_is_accepted(self):
        table = _store()

        def race(**_kwargs):
            table.rows[(ALLOCATION_KEY['pk'], ALLOCATION_KEY['sk'])] = _allocation_row()
            raise _client_error('TransactionCanceledException', 'ConditionalCheckFailed')

        table.meta.client.transact_write_items.side_effect = race
        _ensure(table)
        assert len(_transactions(table)) == 1

    def test_a_lost_race_to_a_different_row_is_a_conflict(self):
        table = _store()

        def race(**_kwargs):
            table.rows[(ALLOCATION_KEY['pk'], ALLOCATION_KEY['sk'])] = _allocation_row(version=3)
            raise _client_error('TransactionCanceledException')

        table.meta.client.transact_write_items.side_effect = race
        with pytest.raises(ServiceError) as caught:
            _ensure(table)
        assert _refusal(caught) == CONFLICT

    def test_a_deleted_project_is_named(self):
        table = _store()
        table.meta.client.transact_write_items.side_effect = [_client_error('AccessDeniedException')]
        with pytest.raises(ServiceError) as caught:
            _ensure(table)
        assert _refusal(caught) == 'Project deletion has started; allocation history cannot change.'

    @pytest.mark.parametrize('error', [
        _client_error('ConditionalCheckFailedException'),
        _client_error('TransactionCanceledException'),
    ])
    def test_an_unexplained_refusal_is_named(self, error):
        table = _store(META)
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ServiceError) as caught:
            _ensure(table)
        assert _refusal(caught) == 'Could not identify the stored document allocation history'

    def test_any_other_error_is_re_raised(self):
        table = _store(META)
        error = _client_error('ThrottlingException')
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _ensure(table)
        assert caught.value is error


def _by_allocation(table: MagicMock) -> dict[str, Any] | None:
    return get_versioned_document_by_allocation(table, 'p1', 'prd', 'a1')


class TestGetVersionedDocumentByAllocation:
    def test_a_committed_allocation_returns_its_document(self):
        table = _store(_allocation_row(), _generated())
        assert _by_allocation(table) == _generated()
        table.meta.client.transact_write_items.assert_not_called()

    def test_a_deleted_document_cannot_be_replayed(self):
        with pytest.raises(ServiceError) as caught:
            _by_allocation(_store(_allocation_row()))
        assert _refusal(caught) == (
            'Document allocation was previously deleted and cannot be replayed'
        )

    @pytest.mark.parametrize('rows', [
        [_allocation_row(document_type='prfaq'), _generated()],
        [_allocation_row(), _generated(version=2, title='Launch (v2)')],
    ])
    def test_a_disagreeing_history_is_a_conflict(self, rows):
        with pytest.raises(ServiceError) as caught:
            _by_allocation(_store(*rows))
        assert _refusal(caught) == CONFLICT

    def test_a_document_claimed_by_another_allocation_is_a_collision(self):
        with pytest.raises(ServiceError) as caught:
            _by_allocation(_store(_generated(version_allocation_id='a2')))
        assert _refusal(caught) == 'Document id collision detected'

    def test_nothing_stored_is_none(self):
        table = _store()
        assert _by_allocation(table) is None
        table.meta.client.transact_write_items.assert_not_called()

    def test_a_document_without_history_backfills_it(self):
        table = _store(META, _generated())
        assert _by_allocation(table) == _generated()
        assert _transactions(table) == [HISTORY_PUT]


class TestPreserveVersionedDocumentAllocation:
    @pytest.mark.parametrize('document', [
        {'sk': 'NOTE#x', 'version_allocation_id': 'a1'},
        _generated(version_allocation_id=None),
        _generated(version_allocation_id=7),
        _generated(version_allocation_id=''),
    ])
    def test_an_ungenerated_document_is_refused(self, document):
        with pytest.raises(ServiceError) as caught:
            preserve_versioned_document_allocation(_store(), 'p1', document)
        assert _refusal(caught) == 'Stored document has no generated allocation to preserve'

    @pytest.mark.parametrize('override', [
        {'pk': 'PROJECT#p2'}, {'sk': 'PRD#x', 'document_type': 'prd'}, {'document_id': 'x'},
    ])
    def test_an_inconsistent_document_is_refused(self, override):
        with pytest.raises(ServiceError) as caught:
            preserve_versioned_document_allocation(_store(), 'p1', _generated(**override))
        assert _refusal(caught) == 'Stored generated document allocation is inconsistent'

    def test_a_vanished_document_is_refused(self):
        with pytest.raises(ServiceError) as caught:
            preserve_versioned_document_allocation(_store(), 'p1', _generated())
        assert _refusal(caught) == (
            'Document disappeared before its allocation history was preserved'
        )

    def test_the_stored_copy_is_what_is_preserved(self):
        table = _store(META, _generated())
        preserve_versioned_document_allocation(
            table, 'p1', _generated(title='stale', base_title='stale'),
        )
        assert _transactions(table) == [HISTORY_PUT]


FIELDS = {'created_at': NOW_ISO, 'content': '# doc', 'version': 99, 'pk': 'x'}
META_BUMP = {'Update': {
    'TableName': 'projects',
    'Key': META,
    'UpdateExpression': (
        'SET document_count = if_not_exists(document_count, :zero) + :one, '
        'updated_at = :now'
    ),
    'ConditionExpression': PROJECT_WRITABLE_CONDITION,
    'ExpressionAttributeNames': dict(PROJECT_WRITABLE_ATTRIBUTE_NAMES),
    'ExpressionAttributeValues': {
        **PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':one': 1, ':zero': 0, ':now': NOW_ISO,
    },
}}


def _item(version: int, base: str = 'Launch') -> dict[str, Any]:
    return {
        **FIELDS,
        **DOC_KEY,
        'document_id': DOC_ID,
        'document_type': 'prd',
        'base_title': base,
        'version': version,
        'title': f'{base} (v{version})',
        'version_allocation_id': 'a1',
    }


def _allocation_put(version: int, base: str = 'Launch') -> dict[str, Any]:
    return {'Put': {
        'TableName': 'projects',
        'Item': _allocation_row(version=version, base_title=base, title=f'{base} (v{version})'),
        'ConditionExpression': NOT_EXISTS,
    }}


def _first_call(action: Callable[[], None]) -> Callable[..., None]:
    """A ``transact_write_items`` side effect: run *action* (which raises) once, then succeed."""
    calls = 0

    def side_effect(**_kwargs: Any) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            action()

    return side_effect


def _persist(table: MagicMock, title: object = ' Launch  (v9)') -> dict[str, Any]:
    return persist_versioned_document(table, 'p1', 'prd', title, 'a1', dict(FIELDS))


@pytest.fixture
def legacy() -> Iterator[dict[str, MagicMock]]:
    with (
        patch.object(dv, '_query_project_documents', return_value=[]) as query,
        patch.object(dv, 'persist_legacy_document_versions') as persist,
    ):
        yield {'query': query, 'persist': persist}


@pytest.mark.usefixtures('legacy')
class TestPersistVersionedDocumentCommits:
    def test_a_first_allocation_creates_the_counter(self, legacy):
        table = _store(META)
        assert _persist(table) == _item(1)
        assert _transactions(table) == [[
            {'Put': {
                'TableName': 'projects',
                'Item': {
                    **SERIES_KEY,
                    'document_type': 'prd',
                    'base_title': 'Launch',
                    'normalized_base_title': 'launch',
                    'last_version': 1,
                    'updated_at': NOW_ISO,
                },
                'ConditionExpression': NOT_EXISTS,
            }},
            _allocation_put(1),
            {'Put': {'TableName': 'projects', 'Item': _item(1), 'ConditionExpression': NOT_EXISTS}},
            META_BUMP,
        ]]
        legacy['query'].assert_called_once_with(table, 'p1')
        legacy['persist'].assert_not_called()

    def test_a_first_allocation_continues_the_legacy_series(self, legacy):
        legacy['query'].return_value = [
            {'sk': 'PRD#old', 'document_type': 'prd', 'base_title': 'LAUNCH',
             'version': 3, 'title': 'LAUNCH (v3)'},
            {'sk': 'PRD#older', 'document_type': 'prd', 'base_title': 'LAUNCH',
             'version': 2, 'title': 'LAUNCH (v2)'},
        ]
        assert _persist(_store(META)) == _item(4, 'LAUNCH')
        legacy['persist'].assert_not_called()

    @pytest.mark.parametrize(('counter', 'base'), [
        ({'last_version': 4, 'base_title': 'Stored'}, 'Stored'),
        ({'last_version': Decimal('4')}, 'Launch'),
    ])
    def test_a_later_allocation_advances_the_counter_optimistically(self, counter, base):
        table = _store(META, {**SERIES_KEY, **counter})
        assert _persist(table) == _item(5, base)
        [transaction] = _transactions(table)
        assert transaction[0] == {'Update': {
            'TableName': 'projects',
            'Key': SERIES_KEY,
            'UpdateExpression': 'SET #last = :next, updated_at = :now',
            'ConditionExpression': (
                '#last = :observed AND normalized_base_title = :normalized '
                'AND (attribute_not_exists(#owner) OR attribute_not_exists(#expires) '
                'OR #expires < :now_epoch)'
            ),
            'ExpressionAttributeNames': {
                '#last': 'last_version',
                '#owner': 'migration_owner',
                '#expires': 'migration_expires_at',
            },
            'ExpressionAttributeValues': {
                ':next': 5, ':observed': 4, ':normalized': 'launch',
                ':now_epoch': NOW_EPOCH, ':now': NOW_ISO,
            },
        }}
        assert transaction[1:] == [
            _allocation_put(5, base),
            {'Put': {'TableName': 'projects', 'Item': _item(5, base),
                     'ConditionExpression': NOT_EXISTS}},
            META_BUMP,
        ]

    def test_a_replay_returns_the_committed_document_without_a_query(self, legacy):
        table = _store(_allocation_row(), _generated())
        assert _persist(table, 'Renamed') == _generated()
        legacy['query'].assert_not_called()
        table.meta.client.transact_write_items.assert_not_called()

    def test_unsettled_legacy_rows_are_persisted_first(self, legacy):
        rows = [
            {'sk': 'META', 'title': 'x'},
            {'sk': 'PRD#old', 'title': 'Launch'},
        ]
        legacy['query'].return_value = rows
        table = _store(META)
        _persist(table)
        legacy['persist'].assert_called_once_with(table, 'p1', rows)

    def test_an_unmanaged_row_never_triggers_a_legacy_migration(self, legacy):
        legacy['query'].return_value = [{'sk': 'META', 'title': 'x'}]
        _persist(_store(META))
        legacy['persist'].assert_not_called()

    @pytest.mark.parametrize('name', [None, '', 5])
    def test_needs_a_table_name(self, name):
        with pytest.raises(ValueError, match=r'^Projects table name is required for document persistence$'):
            _persist(_store(name=name))

    def test_needs_a_title(self):
        with pytest.raises(ValidationError):
            _persist(_store(META), '  ')

    def test_with_no_attempts_left_it_refuses(self):
        with patch.object(dv, 'VERSION_WRITE_ATTEMPTS', 0), pytest.raises(ServiceError) as caught:
            _persist(_store(META))
        assert _refusal(caught) == NO_VERSION


@pytest.mark.usefixtures('legacy')
class TestPersistVersionedDocumentRefusals:
    def test_a_lost_race_to_the_same_allocation_returns_the_winner(self):
        table = _store(META)
        winner = _generated()

        def race(**_kwargs):
            table.rows[(ALLOCATION_KEY['pk'], ALLOCATION_KEY['sk'])] = _allocation_row()
            table.rows[(DOC_KEY['pk'], DOC_KEY['sk'])] = winner
            raise _client_error('AccessDeniedException')

        table.meta.client.transact_write_items.side_effect = race
        assert _persist(table) == winner

    def test_a_cancellation_on_a_deleted_project_is_named(self):
        table = _store()
        table.meta.client.transact_write_items.side_effect = [
            _client_error('TransactionCanceledException', 'ConditionalCheckFailed'),
        ]
        with pytest.raises(ServiceError) as caught:
            _persist(table)
        assert _refusal(caught) == 'Project deletion has started; documents cannot be created.'

    def test_another_error_on_a_deleted_project_is_re_raised(self):
        table = _store()
        error = _client_error('AccessDeniedException')
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _persist(table)
        assert caught.value is error

    def test_transient_refusals_retry_four_times_then_refuse(self, frozen_clock):
        _, sleep = frozen_clock
        table = _store(META)
        table.meta.client.transact_write_items.side_effect = [
            _client_error('ThrottlingException'),
        ] * 4
        with patch.object(dv, 'logger') as logger, pytest.raises(ServiceError) as caught:
            _persist(table)
        assert _refusal(caught) == NO_VERSION
        assert len(_transactions(table)) == 4
        assert sleep.call_args_list == [call(0.025), call(0.05), call(0.1)]
        logger.exception.assert_called_once_with(
            'Document version allocation exhausted retries',
            extra={'project_id': 'p1', 'document_type': 'prd'},
        )

    def test_a_moved_counter_is_retried_at_the_next_version(self):
        table = _store(META)

        def move_counter() -> None:
            table.rows[(SERIES_KEY['pk'], SERIES_KEY['sk'])] = {**SERIES_KEY, 'last_version': 1}
            raise _client_error('TransactionCanceledException', 'ConditionalCheckFailed')

        table.meta.client.transact_write_items.side_effect = _first_call(move_counter)
        assert _persist(table) == _item(2)

    def test_a_migration_taking_the_lease_is_waited_out(self):
        table = _store(META)
        lease = {'migration_owner': 'o', 'migration_expires_at': NOW_EPOCH}

        def take_lease() -> None:
            table.rows[(SERIES_KEY['pk'], SERIES_KEY['sk'])] = {**SERIES_KEY, **lease}
            raise _client_error('TransactionCanceledException', 'ConditionalCheckFailed')

        table.meta.client.transact_write_items.side_effect = _first_call(take_lease)
        with patch.object(dv, '_wait_for_legacy_migration', side_effect=[{}, {}]) as wait:
            assert _persist(table) == _item(1)
        assert wait.call_args_list == [call(table, SERIES_KEY)] * 2

    def test_a_permanent_refusal_with_nothing_moved_is_re_raised(self):
        table = _store(META, {**SERIES_KEY, 'last_version': 2})
        error = _client_error('TransactionCanceledException', 'ConditionalCheckFailed')
        table.meta.client.transact_write_items.side_effect = [error]
        with pytest.raises(ClientError) as caught:
            _persist(table)
        assert caught.value is error


class TestVersionCandidate:
    def test_is_an_immutable_slotted_record(self):
        candidate = _VersionCandidate(index=0, base_title='T', claimed_version=None, rank=('', '', ''))
        field = 'index'
        with pytest.raises(FrozenInstanceError):
            setattr(candidate, field, 1)
        assert not hasattr(candidate, '__dict__')


class TestManagedDocumentType:
    @pytest.mark.parametrize(('document', 'expected'), [
        ({'document_type': 'prfaq', 'sk': 'PRD#x'}, 'prfaq'),
        ({'document_type': 'note', 'sk': 'PRD#x'}, 'prd'),
        ({'sk': 'PRFAQ#x'}, 'prfaq'),
        ({'sk': 'PROTOTYPE#x'}, 'prototype'),
        ({'sk': 'PRD'}, None),
        ({'sk': 'PRFAQ'}, None),
        ({'sk': 'PROTOTYPE'}, None),
        ({'sk': 'XPRD#x'}, None),
        ({'sk': None}, None),
        ({}, None),
    ])
    def test_type_then_sort_key_prefix(self, document, expected):
        assert managed_document_type(document) == expected


class TestPositiveInt:
    @pytest.mark.parametrize(('value', 'expected'), [
        (True, None), (False, None), (1, 1), (0, None), (-1, None),
        (Decimal('1'), 1), (Decimal('0'), None), (Decimal('-2'), None), (Decimal('2.5'), None),
        ('1', 1), ('12', 12), ('0', None), ('', None), ('-1', None), ('1.0', None),
        (1.0, None), (None, None),
    ])
    def test_only_positive_whole_numbers(self, value, expected):
        assert _positive_int(value) == expected


class TestReads:
    @pytest.mark.parametrize(('response', 'expected'), [
        ({'Item': {'a': 1}}, {'a': 1}),
        ({'Item': 'junk'}, {}),
        ({}, {}),
        (None, {}),
    ])
    def test_get_item_is_consistent_and_always_a_dict(self, response, expected):
        table = _table()
        table.get_item.return_value = response
        assert _get_item(table, COUNTER_KEY) == expected
        table.get_item.assert_called_once_with(Key=COUNTER_KEY, ConsistentRead=True)

    def test_existing_document(self):
        row = {**DOC_KEY, 'version_allocation_id': 'a1'}
        assert _existing_document(_store(row), DOC_KEY, 'a1') == row
        assert _existing_document(_store(), DOC_KEY, 'a1') is None

    def test_query_project_documents_pages_and_keeps_managed_dicts(self):
        table = _table()
        table.query.side_effect = [
            {'Items': [{'sk': 'PRD#a'}, {'sk': 'META'}, 'junk'], 'LastEvaluatedKey': {'k': 1}},
            {'Items': 'junk', 'LastEvaluatedKey': {'k': 2}},
            {'Items': [{'sk': 'PROTOTYPE#b'}]},
        ]
        assert _query_project_documents(table, 'p1') == [{'sk': 'PRD#a'}, {'sk': 'PROTOTYPE#b'}]
        base = {
            'KeyConditionExpression': Key('pk').eq('PROJECT#p1'),
            'ConsistentRead': True,
            'ProjectionExpression': (
                'pk, sk, document_id, #type, #title, base_title, #version, created_at'
            ),
            'ExpressionAttributeNames': {
                '#type': 'document_type', '#title': 'title', '#version': 'version',
            },
        }
        assert table.query.call_args_list == [
            call(**base),
            call(**base, ExclusiveStartKey={'k': 1}),
            call(**base, ExclusiveStartKey={'k': 2}),
        ]

    @pytest.mark.parametrize('page', [None, {'Items': [{'sk': 'PRD#a'}], 'LastEvaluatedKey': 'k'},
                                      {'Items': [{'sk': 'PRD#a'}], 'LastEvaluatedKey': {}}])
    def test_query_project_documents_stops_without_a_cursor(self, page):
        table = _table()
        table.query.side_effect = [page]
        expected = [] if page is None else [{'sk': 'PRD#a'}]
        assert _query_project_documents(table, 'p1') == expected


class TestSeriesState:
    def test_an_empty_series_starts_from_the_fallback(self):
        documents = [
            {'sk': 'PRFAQ#a', 'title': 'Launch'},
            {'sk': 'PRD#b', 'title': 'Other (v5)'},
        ]
        assert _series_state(documents, 'prd', 'launch', 'Fallback') == ('Fallback', 0)

    def test_the_series_takes_its_earliest_title_and_highest_version(self):
        documents = [
            {'sk': 'PRD#b', 'created_at': '2', 'title': 'launch (v7)'},
            {'sk': 'PRD#a', 'created_at': '1', 'title': 'Launch'},
            {'sk': 'PRD#c', 'created_at': '3', 'title': 'Other (v9)'},
        ]
        assert _series_state(documents, 'prd', 'launch', 'Fallback') == ('Launch', 7)


class TestCounterMoved:
    @pytest.mark.parametrize(('rows', 'observed', 'expected'), [
        ([], None, False),
        ([], 1, True),
        ([{**SERIES_KEY, 'last_version': 2}], 2, False),
        ([{**SERIES_KEY, 'last_version': Decimal('3')}], 2, True),
        ([{**SERIES_KEY}], None, False),
    ])
    def test_compares_the_stored_version(self, rows, observed, expected):
        assert _counter_moved(_store(*rows), SERIES_KEY, observed) is expected


class TestTransientReasons:
    @pytest.mark.parametrize(('reasons', 'expected'), [
        ([{}], True),
        ([{'Code': None}], True),
        (['junk', {'Code': 'Other'}], False),
        ({'Code': 'ConditionalCheckFailed'}, True),
    ])
    def test_reason_shapes(self, reasons, expected):
        error = ClientError(
            {'Error': {'Code': 'TransactionCanceledException'}, 'CancellationReasons': reasons},
            'Op',
        )
        assert _transient(error) is expected


# Lines 1499-end (the stale-save guard appended after the slice above was hardened):
# no test named the 409's message, and none called the guard with a matching
# version, so both the message and the `!=` were unpinned.
STALE = 'The document was changed by someone else; reload it and try again'


def _moved_counter() -> tuple[MagicMock, ClientError]:
    """A counter already at v3 and the refusal its move caused."""
    error = _client_error('TransactionCanceledException', 'ConditionalCheckFailed')
    return _store({**SERIES_KEY, 'last_version': 3}), error


class TestStaleSaveGuard:
    @pytest.mark.parametrize(('expected', 'current'), [(None, 0), (None, 3), (3, 3), (1, 1)])
    def test_no_expectation_or_the_head_version_passes(self, expected, current):
        assert _require_expected_version(expected, current) is None

    @pytest.mark.parametrize(('expected', 'current'), [(2, 3), (4, 3), (0, 1)])
    def test_another_version_is_a_409_naming_the_reload(self, expected, current):
        with pytest.raises(ConflictError) as caught:
            _require_expected_version(expected, current)
        assert caught.value.message == STALE
        assert caught.value.status_code == 409

    def test_a_moved_counter_under_an_expectation_is_a_409_chained_to_the_refusal(self):
        table, error = _moved_counter()
        with pytest.raises(ConflictError) as caught:
            _allocation_retryable(table, SERIES_KEY, 2, error, 2)
        assert caught.value.message == STALE
        assert caught.value.__cause__ is error

    @pytest.mark.parametrize(('observed', 'expected', 'retryable'), [(2, None, True), (3, 3, False)])
    def test_without_an_expectation_a_moved_counter_retries(self, observed, expected, retryable):
        table, error = _moved_counter()
        assert _allocation_retryable(table, SERIES_KEY, observed, error, expected) is retryable
