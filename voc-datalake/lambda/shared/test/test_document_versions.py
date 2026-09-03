"""Document-version allocation and legacy-read contracts."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.document_versions import (
    get_versioned_document_by_allocation,
    normalize_document_versions,
    persist_legacy_document_versions,
    persist_versioned_document,
    version_partition_key,
)
from shared.exceptions import ServiceError


@pytest.fixture
def projects_table():
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='test-projects',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        table.put_item(Item={
            'pk': 'PROJECT#p1',
            'sk': 'META',
            'project_id': 'p1',
            'document_count': 0,
        })
        yield table


def fields(created_at: str = '2026-09-01T10:00:00+00:00') -> dict:
    return {
        'gsi1pk': 'PROJECT#p1#DOCUMENTS',
        'gsi1sk': created_at,
        'content': '# document',
        'created_at': created_at,
    }


def late_legacy_document() -> dict:
    return {
        'pk': 'PROJECT#p1',
        'sk': 'PRD#late',
        'document_id': 'late',
        'document_type': 'prd',
        'title': 'Launch',
        'created_at': '2026-10-01',
    }


def test_assigns_stable_unique_versions_to_duplicate_legacy_titles():
    documents = [
        {
            'sk': 'PRD#old', 'document_id': 'old', 'document_type': 'prd',
            'title': 'Launch Plan', 'created_at': '2026-01-01',
        },
        {
            'sk': 'PRD#claimed', 'document_id': 'claimed', 'document_type': 'prd',
            'title': 'Launch Plan (v2)', 'created_at': '2026-02-01',
        },
        {
            'sk': 'PRD#duplicate', 'document_id': 'duplicate', 'document_type': 'prd',
            'title': 'Launch Plan (v2)', 'created_at': '2026-03-01',
        },
    ]

    normalized = normalize_document_versions(documents)

    assert [document['version'] for document in normalized] == [1, 2, 3]
    assert [document['title'] for document in normalized] == [
        'Launch Plan (v1)', 'Launch Plan (v2)', 'Launch Plan (v3)',
    ]
    assert all(document['base_title'] == 'Launch Plan' for document in normalized)


def test_allocates_versions_by_type_and_normalized_base_title(projects_table):
    prd_v1 = persist_versioned_document(
        projects_table, 'p1', 'prd', 'Launch Plan', 'job-prd-1', fields(),
    )
    prd_v2 = persist_versioned_document(
        projects_table, 'p1', 'prd', ' launch   plan (v99) ', 'job-prd-2',
        fields('2026-09-01T11:00:00+00:00'),
    )
    prfaq_v1 = persist_versioned_document(
        projects_table, 'p1', 'prfaq', 'Launch Plan', 'job-prfaq-1',
        fields('2026-09-01T12:00:00+00:00'),
    )

    assert (prd_v1['version'], prd_v1['title']) == (1, 'Launch Plan (v1)')
    assert (prd_v2['version'], prd_v2['title']) == (2, 'Launch Plan (v2)')
    assert (prfaq_v1['version'], prfaq_v1['title']) == (1, 'Launch Plan (v1)')

    meta = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert meta['document_count'] == 3


def test_replaying_the_same_job_returns_the_existing_document(projects_table):
    first = persist_versioned_document(
        projects_table, 'p1', 'prd', 'Retry-safe', 'job-same', fields(),
    )
    with patch('shared.document_versions._query_project_documents') as query:
        replay = persist_versioned_document(
            projects_table, 'p1', 'prd', 'Retry-safe', 'job-same',
            fields('2026-09-01T13:00:00+00:00'),
        )

    assert replay == first
    query.assert_not_called()
    meta = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert meta['document_count'] == 1


def test_bootstraps_after_legacy_documents_without_reusing_a_version(projects_table):
    projects_table.put_item(Item={
        'pk': 'PROJECT#p1',
        'sk': 'PRD#legacy',
        'document_id': 'legacy',
        'document_type': 'prd',
        'title': 'Existing title',
        'created_at': '2026-01-01',
    })

    item = persist_versioned_document(
        projects_table, 'p1', 'prd', 'Existing title', 'job-new', fields(),
    )

    assert (item['version'], item['title']) == (2, 'Existing title (v2)')
    counters = projects_table.query(
        KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
    )['Items']
    series_counters = [
        counter for counter in counters
        if counter.get('last_version') is not None
    ]
    assert [counter['last_version'] for counter in series_counters] == [2]


def test_missing_project_metadata_commits_nothing(projects_table):
    projects_table.delete_item(Key={'pk': 'PROJECT#p1', 'sk': 'META'})

    with pytest.raises(ServiceError, match='Project deletion has started'):
        persist_versioned_document(
            projects_table, 'p1', 'prd', 'Orphan', 'job-orphan', fields(),
        )

    assert projects_table.scan()['Items'] == []


def _transaction_error(*reasons: str) -> ClientError:
    return ClientError(
        {
            'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
            'CancellationReasons': [{'Code': reason} for reason in reasons],
        },
        'TransactWriteItems',
    )


def test_persisted_legacy_version_survives_older_sibling_deletion(projects_table):
    legacy = [
        {
            'pk': 'PROJECT#p1', 'sk': 'PRD#old', 'document_id': 'old',
            'document_type': 'prd', 'title': 'Launch', 'created_at': '2026-01-01',
        },
        {
            'pk': 'PROJECT#p1', 'sk': 'PRD#new', 'document_id': 'new',
            'document_type': 'prd', 'title': 'Launch', 'created_at': '2026-02-01',
        },
    ]
    for document in legacy:
        projects_table.put_item(Item=document)

    first_read = persist_legacy_document_versions(projects_table, 'p1', legacy)
    projects_table.delete_item(Key={'pk': 'PROJECT#p1', 'sk': 'PRD#old'})
    remaining = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'PRD#new'}, ConsistentRead=True,
    )['Item']
    second_read = persist_legacy_document_versions(projects_table, 'p1', [remaining])

    assert [(document['document_id'], document['version']) for document in first_read] == [
        ('old', 1), ('new', 2),
    ]
    assert (second_read[0]['version'], second_read[0]['title']) == (2, 'Launch (v2)')
    stored = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'PRD#new'}, ConsistentRead=True,
    )['Item']
    assert (stored['base_title'], stored['version'], stored['title']) == (
        'Launch', 2, 'Launch (v2)',
    )


def test_persisted_legacy_suffix_sets_counter_high_water(projects_table):
    legacy = {
        'pk': 'PROJECT#p1', 'sk': 'PRFAQ#old', 'document_id': 'old',
        'document_type': 'prfaq', 'title': 'Launch (v10)', 'created_at': '2026-01-01',
    }
    projects_table.put_item(Item=legacy)

    migrated = persist_legacy_document_versions(projects_table, 'p1', [legacy])
    generated = persist_versioned_document(
        projects_table, 'p1', 'prfaq', 'Launch', 'job-next', fields(),
    )

    assert (migrated[0]['version'], migrated[0]['title']) == (10, 'Launch (v10)')
    assert (generated['version'], generated['title']) == (11, 'Launch (v11)')


def test_retries_a_transient_transaction_conflict_once(projects_table):
    client = projects_table.meta.client
    original = client.transact_write_items
    calls = 0

    def conflict_once(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise _transaction_error('TransactionConflict', 'None', 'None')
        return original(**kwargs)

    with (
        patch.object(client, 'transact_write_items', side_effect=conflict_once),
        patch('shared.document_versions.time.sleep'),
    ):
        item = persist_versioned_document(
            projects_table, 'p1', 'prd', 'Retry', 'job-retry', fields(),
        )

    assert (calls, item['version'], item['title']) == (2, 1, 'Retry (v1)')


def test_reports_retryable_transaction_exhaustion(projects_table):
    client = projects_table.meta.client
    error = _transaction_error('TransactionConflict', 'None', 'None')

    with (
        patch.object(client, 'transact_write_items', side_effect=error) as transact,
        patch('shared.document_versions.time.sleep'),
        pytest.raises(ServiceError, match='Could not allocate a document version'),
    ):
        persist_versioned_document(
            projects_table, 'p1', 'prd', 'Retry', 'job-exhausted', fields(),
        )

    assert transact.call_count == 4


def test_does_not_retry_a_non_transient_transaction_cancellation(projects_table):
    client = projects_table.meta.client
    error = _transaction_error('ConditionalCheckFailed', 'None', 'None')

    with (
        patch.object(client, 'transact_write_items', side_effect=error) as transact,
        patch('shared.document_versions.time.sleep'),
        pytest.raises(ClientError),
    ):
        persist_versioned_document(
            projects_table, 'p1', 'prd', 'No retry', 'job-no-retry', fields(),
        )

    assert transact.call_count == 1


def test_competing_allocations_receive_unique_versions(projects_table):
    client = projects_table.meta.client
    original = client.transact_write_items
    barrier = threading.Barrier(2)
    call_lock = threading.Lock()
    calls = 0

    def synchronize_first_attempts(**kwargs):
        nonlocal calls
        with call_lock:
            calls += 1
            current_call = calls
        if current_call <= 2:
            barrier.wait(timeout=5)
        return original(**kwargs)

    with (
        patch.object(client, 'transact_write_items', side_effect=synchronize_first_attempts),
        patch('shared.document_versions.time.sleep'),
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        futures = [
            pool.submit(
                persist_versioned_document,
                projects_table,
                'p1',
                'prd',
                'Concurrent',
                f'job-{index}',
                fields(f'2026-09-01T1{index}:00:00+00:00'),
            )
            for index in range(2)
        ]
        documents = [future.result(timeout=10) for future in futures]

    assert sorted(document['version'] for document in documents) == [1, 2]
    assert {document['title'] for document in documents} == {
        'Concurrent (v1)', 'Concurrent (v2)',
    }


def test_legacy_backfill_allocates_above_existing_counter_history(projects_table):
    generated = persist_versioned_document(
        projects_table, 'p1', 'prd', 'Launch', 'job-deleted', fields(),
    )
    projects_table.delete_item(Key={'pk': generated['pk'], 'sk': generated['sk']})
    legacy = late_legacy_document()
    projects_table.put_item(Item=legacy)

    migrated = persist_legacy_document_versions(projects_table, 'p1', [legacy])

    assert (migrated[0]['version'], migrated[0]['title']) == (2, 'Launch (v2)')
    counters = projects_table.query(
        KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
    )['Items']
    series_counter = next(
        item for item in counters if item['sk'].startswith('PRD#')
    )
    assert series_counter['last_version'] == 2


def test_expired_migration_lease_cannot_write_assignments(projects_table):
    legacy = late_legacy_document()
    projects_table.put_item(Item=legacy)

    with (
        patch('shared.document_versions.time.time', side_effect=[100, 100, 131]),
        pytest.raises(ServiceError, match='lease was lost'),
    ):
        persist_legacy_document_versions(projects_table, 'p1', [legacy])

    stored = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'PRD#late'}, ConsistentRead=True,
    )['Item']
    assert 'version' not in stored
    counter_items = projects_table.query(
        KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
    )['Items']
    assert all(not item['sk'].startswith('LEGACY_ASSIGNMENT#') for item in counter_items)


def test_retries_transaction_cancellation_without_reason_details(projects_table):
    client = projects_table.meta.client
    error = ClientError(
        {'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'}},
        'TransactWriteItems',
    )

    with (
        patch.object(client, 'transact_write_items', side_effect=error) as transact,
        patch('shared.document_versions.time.sleep'),
        pytest.raises(ServiceError, match='Could not allocate a document version'),
    ):
        persist_versioned_document(
            projects_table, 'p1', 'prd', 'Unknown cancellation', 'job-unknown', fields(),
        )

    assert transact.call_count == 4


def test_mixed_permanent_and_transient_cancellation_is_not_retried(projects_table):
    client = projects_table.meta.client
    error = _transaction_error(
        'TransactionConflict', 'ConditionalCheckFailed', 'None',
    )

    with (
        patch.object(client, 'transact_write_items', side_effect=error) as transact,
        patch('shared.document_versions.time.sleep'),
        pytest.raises(ClientError),
    ):
        persist_versioned_document(
            projects_table, 'p1', 'prd', 'Mixed cancellation', 'job-mixed', fields(),
        )

    assert transact.call_count == 1


def test_legacy_backfill_uses_counter_floor_observed_during_lease_acquisition(
    projects_table,
):
    legacy = late_legacy_document()
    projects_table.put_item(Item=legacy)

    from shared import document_versions

    original_get_item = document_versions._get_item
    counter_reads = 0

    def advance_counter_before_acquire(table, key):
        nonlocal counter_reads
        if key.get('pk') == version_partition_key('p1'):
            counter_reads += 1
            if counter_reads == 2:
                table.put_item(Item={
                    **key,
                    'document_type': 'prd',
                    'base_title': 'Launch',
                    'normalized_base_title': 'launch',
                    'last_version': 1,
                })
        return original_get_item(table, key)

    with patch(
        'shared.document_versions._get_item',
        side_effect=advance_counter_before_acquire,
    ):
        migrated = persist_legacy_document_versions(projects_table, 'p1', [legacy])

    assert (migrated[0]['version'], migrated[0]['title']) == (2, 'Launch (v2)')


def test_concurrent_first_reads_wait_and_return_the_same_persisted_identity(
    projects_table,
):
    legacy = [late_legacy_document()]
    projects_table.put_item(Item=legacy[0])

    from shared import document_versions

    original_persist = document_versions._persist_legacy_identity
    first_writer_entered = threading.Event()
    allow_first_writer = threading.Event()
    pause_lock = threading.Lock()
    paused = False

    def pause_first_writer(*args, **kwargs):
        nonlocal paused
        with pause_lock:
            should_pause = not paused
            if should_pause:
                paused = True
        if should_pause:
            first_writer_entered.set()
            assert allow_first_writer.wait(timeout=5)
        return original_persist(*args, **kwargs)

    with (
        patch(
            'shared.document_versions._persist_legacy_identity',
            side_effect=pause_first_writer,
        ),
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        first = pool.submit(
            persist_legacy_document_versions, projects_table, 'p1', legacy,
        )
        assert first_writer_entered.wait(timeout=5)
        second = pool.submit(
            persist_legacy_document_versions, projects_table, 'p1', legacy,
        )
        time.sleep(0.1)
        allow_first_writer.set()
        results = [first.result(timeout=10), second.result(timeout=10)]

    assert [
        (result[0]['version'], result[0]['title']) for result in results
    ] == [(1, 'Launch (v1)'), (1, 'Launch (v1)')]


def test_legacy_migration_retries_transient_lease_acquisition(projects_table):
    legacy = late_legacy_document()
    projects_table.put_item(Item=legacy)
    client = projects_table.meta.client
    original_transaction = client.transact_write_items
    counter_attempts = 0

    def throttle_first_counter_transaction(**kwargs):
        nonlocal counter_attempts
        actions = kwargs['TransactItems']
        is_acquisition = any(
            action.get('Put', {}).get('Item', {}).get('migration_owner')
            for action in actions
        )
        if is_acquisition:
            counter_attempts += 1
            if counter_attempts == 1:
                raise ClientError(
                    {'Error': {'Code': 'ThrottlingException', 'Message': 'slow'}},
                    'TransactWriteItems',
                )
        return original_transaction(**kwargs)

    with (
        patch.object(
            client,
            'transact_write_items',
            side_effect=throttle_first_counter_transaction,
        ),
        patch('shared.document_versions.time.sleep'),
    ):
        migrated = persist_legacy_document_versions(
            projects_table, 'p1', [legacy],
        )

    assert counter_attempts == 2
    assert (migrated[0]['version'], migrated[0]['title']) == (1, 'Launch (v1)')


def test_legacy_migration_retries_transient_identity_transaction(projects_table):
    legacy = late_legacy_document()
    projects_table.put_item(Item=legacy)
    client = projects_table.meta.client
    original_transaction = client.transact_write_items
    attempts = 0

    def throttle_first_identity_transaction(**kwargs):
        nonlocal attempts
        actions = kwargs['TransactItems']
        is_identity = any(
            action.get('Put', {}).get('Item', {}).get('source_document_sk')
            for action in actions
        )
        if is_identity:
            attempts += 1
            if attempts == 1:
                raise ClientError(
                    {'Error': {'Code': 'ThrottlingException', 'Message': 'slow'}},
                    'TransactWriteItems',
                )
        return original_transaction(**kwargs)

    with (
        patch.object(
            client,
            'transact_write_items',
            side_effect=throttle_first_identity_transaction,
        ),
        patch('shared.document_versions.time.sleep'),
    ):
        migrated = persist_legacy_document_versions(
            projects_table, 'p1', [legacy],
        )

    assert attempts == 2
    assert (migrated[0]['version'], migrated[0]['title']) == (1, 'Launch (v1)')


def test_release_throttling_does_not_fail_a_completed_migration(projects_table):
    legacy = late_legacy_document()
    projects_table.put_item(Item=legacy)
    original_update = projects_table.update_item

    def fail_release_only(**kwargs):
        if 'REMOVE #owner, #expires' in kwargs.get('UpdateExpression', ''):
            raise ClientError(
                {'Error': {'Code': 'ThrottlingException', 'Message': 'slow'}},
                'UpdateItem',
            )
        return original_update(**kwargs)

    with patch.object(
        projects_table, 'update_item', side_effect=fail_release_only,
    ):
        migrated = persist_legacy_document_versions(
            projects_table, 'p1', [legacy],
        )

    assert (migrated[0]['version'], migrated[0]['title']) == (1, 'Launch (v1)')
    stored = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'PRD#late'}, ConsistentRead=True,
    )['Item']
    assert (stored['version'], stored['title']) == (1, 'Launch (v1)')


def _allocation_history(table, allocation_id: str) -> dict:
    items = table.query(
        KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
        ConsistentRead=True,
    )['Items']
    return next(item for item in items if item.get('allocation_id') == allocation_id)


def test_prototype_allocations_are_canonical_deterministic_and_replay_safe(projects_table):
    import hashlib

    from shared.document_versions import versioned_document_id

    first = persist_versioned_document(
        projects_table, 'p1', 'prototype', 'Launch Prototype', 'job-prototype-1',
        fields(),
    )
    second = persist_versioned_document(
        projects_table, 'p1', 'prototype', ' launch   prototype (v99) ',
        'job-prototype-2', fields('2026-09-01T11:00:00+00:00'),
    )
    replay = persist_versioned_document(
        projects_table, 'p1', 'prototype', 'A replay cannot rename this',
        'job-prototype-1', fields('2026-09-01T12:00:00+00:00'),
    )

    expected_ids = [
        versioned_document_id('p1', 'prototype', allocation_id)
        for allocation_id in ('job-prototype-1', 'job-prototype-2')
    ]
    assert [first['document_id'], second['document_id']] == expected_ids
    assert [first['sk'], second['sk']] == [
        f'PROTOTYPE#{document_id}' for document_id in expected_ids
    ]
    assert [(first['version'], first['title']), (second['version'], second['title'])] == [
        (1, 'Launch Prototype (v1)'), (2, 'Launch Prototype (v2)'),
    ]
    assert replay == first

    for allocation_id, document in zip(
        ('job-prototype-1', 'job-prototype-2'), (first, second), strict=True,
    ):
        allocation = _allocation_history(projects_table, allocation_id)
        digest = hashlib.sha256(allocation_id.encode()).hexdigest()
        assert allocation == {
            'pk': version_partition_key('p1'),
            'sk': f'ALLOCATION#PROTOTYPE#{digest}',
            'allocation_id': allocation_id,
            'document_id': document['document_id'],
            'document_pk': 'PROJECT#p1',
            'document_sk': document['sk'],
            'document_type': 'prototype',
            'base_title': 'Launch Prototype',
            'version': document['version'],
            'title': document['title'],
            'created_at': document['created_at'],
        }

    meta = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert meta['document_count'] == 2


def test_deleted_allocation_replay_is_rejected_without_advancing_or_recreating(projects_table):
    item = persist_versioned_document(
        projects_table, 'p1', 'prototype', 'Deleted Prototype',
        'job-deleted-prototype', fields(),
    )
    allocation = _allocation_history(projects_table, 'job-deleted-prototype')
    counter_before = next(
        row for row in projects_table.query(
            KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
            ConsistentRead=True,
        )['Items']
        if row.get('last_version') is not None
    )
    projects_table.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})

    with pytest.raises(
        ServiceError,
        match='Document allocation was previously deleted and cannot be replayed',
    ):
        persist_versioned_document(
            projects_table, 'p1', 'prototype', 'Deleted Prototype',
            'job-deleted-prototype', fields('2026-09-01T13:00:00+00:00'),
        )

    assert projects_table.get_item(
        Key={'pk': item['pk'], 'sk': item['sk']}, ConsistentRead=True,
    ).get('Item') is None
    assert projects_table.get_item(
        Key={'pk': allocation['pk'], 'sk': allocation['sk']}, ConsistentRead=True,
    )['Item'] == allocation
    counter_after = projects_table.get_item(
        Key={'pk': counter_before['pk'], 'sk': counter_before['sk']},
        ConsistentRead=True,
    )['Item']
    assert counter_after['last_version'] == counter_before['last_version'] == 1
    meta = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert meta['document_count'] == 1


def test_generated_document_without_history_backfills_on_replay(projects_table):
    original = persist_versioned_document(
        projects_table, 'p1', 'prototype', 'Backfill Prototype',
        'job-history-backfill', fields(),
    )
    allocation = _allocation_history(projects_table, 'job-history-backfill')
    projects_table.delete_item(Key={'pk': allocation['pk'], 'sk': allocation['sk']})

    replay = persist_versioned_document(
        projects_table, 'p1', 'prototype', 'A replay cannot rename this',
        'job-history-backfill', fields('2026-09-01T14:00:00+00:00'),
    )

    assert replay == original
    assert _allocation_history(projects_table, 'job-history-backfill') == allocation
    counter = next(
        row for row in projects_table.query(
            KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
            ConsistentRead=True,
        )['Items']
        if row.get('last_version') is not None
    )
    assert counter['last_version'] == 1
    meta = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'}, ConsistentRead=True,
    )['Item']
    assert meta['document_count'] == 1


def test_legacy_prototypes_without_document_type_migrate_durably_and_hold_high_water(
    projects_table,
):
    legacy = [
        {
            'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#old', 'document_id': 'old',
            'title': 'Launch', 'created_at': '2026-01-01',
        },
        {
            'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#new', 'document_id': 'new',
            'title': 'Launch (v10)', 'created_at': '2026-02-01',
        },
    ]
    for document in legacy:
        projects_table.put_item(Item=document)

    migrated = persist_legacy_document_versions(projects_table, 'p1', legacy)
    assert [(item['document_id'], item['version'], item['title']) for item in migrated] == [
        ('old', 1, 'Launch (v1)'), ('new', 10, 'Launch (v10)'),
    ]
    for document_id, version in (('old', 1), ('new', 10)):
        stored = projects_table.get_item(
            Key={'pk': 'PROJECT#p1', 'sk': f'PROTOTYPE#{document_id}'},
            ConsistentRead=True,
        )['Item']
        assert (stored['base_title'], stored['version'], stored['title']) == (
            'Launch', version, f'Launch (v{version})',
        )

    projects_table.delete_item(Key={'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#old'})
    remaining = projects_table.get_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#new'}, ConsistentRead=True,
    )['Item']
    reread = persist_legacy_document_versions(projects_table, 'p1', [remaining])
    generated = persist_versioned_document(
        projects_table, 'p1', 'prototype', 'Launch', 'job-after-legacy', fields(),
    )

    assert (reread[0]['version'], reread[0]['title']) == (10, 'Launch (v10)')
    assert (generated['version'], generated['title']) == (11, 'Launch (v11)')


def test_legacy_bootstrap_does_not_consume_allocation_transaction_attempts(projects_table):
    legacy = {
        'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#legacy', 'document_id': 'legacy',
        'title': 'Retry Prototype', 'created_at': '2026-01-01',
    }
    projects_table.put_item(Item=legacy)
    client = projects_table.meta.client
    original_transaction = client.transact_write_items
    allocation_attempts = 0
    migration_transactions = 0

    def fail_three_allocation_attempts(**kwargs):
        nonlocal allocation_attempts, migration_transactions
        transaction = kwargs['TransactItems']
        if any(
            action.get('Put', {}).get('Item', {}).get('source_document_sk')
            for action in transaction
        ):
            migration_transactions += 1
        is_allocation = any(
            action.get('Put', {}).get('Item', {}).get('allocation_id')
            == 'job-after-bootstrap'
            for action in transaction
        )
        if is_allocation:
            allocation_attempts += 1
            if allocation_attempts < 4:
                raise _transaction_error(
                    'TransactionConflict', 'None', 'None', 'None',
                )
        return original_transaction(**kwargs)

    with (
        patch.object(
            client, 'transact_write_items', side_effect=fail_three_allocation_attempts,
        ),
        patch('shared.document_versions.time.sleep'),
    ):
        generated = persist_versioned_document(
            projects_table, 'p1', 'prototype', 'Retry Prototype',
            'job-after-bootstrap', fields(),
        )

    assert migration_transactions >= 1
    assert allocation_attempts == 4
    assert (generated['version'], generated['title']) == (
        2, 'Retry Prototype (v2)',
    )


@pytest.mark.parametrize(('document_type', 'sort_prefix'), [
    ('prd', 'PRD'),
    ('prfaq', 'PRFAQ'),
    ('prototype', 'PROTOTYPE'),
])
def test_late_legacy_row_is_persisted_before_next_allocation(
    projects_table, document_type, sort_prefix,
):
    first = persist_versioned_document(
        projects_table, 'p1', document_type, 'Launch',
        f'job-{document_type}-1', fields(),
    )
    late = {
        'pk': 'PROJECT#p1',
        'sk': f'{sort_prefix}#late',
        'document_id': f'{document_type}-late',
        'document_type': document_type,
        'title': 'Launch',
        'created_at': '2026-09-01T10:30:00+00:00',
    }
    projects_table.put_item(Item=late)

    before = normalize_document_versions([first, late])
    generated = persist_versioned_document(
        projects_table, 'p1', document_type, 'Launch',
        f'job-{document_type}-3', fields('2026-09-01T11:00:00+00:00'),
    )
    stored_late = projects_table.get_item(
        Key={'pk': late['pk'], 'sk': late['sk']}, ConsistentRead=True,
    )['Item']

    assert (before[1]['version'], before[1]['title']) == (2, 'Launch (v2)')
    assert (stored_late['version'], stored_late['title']) == (2, 'Launch (v2)')
    assert (generated['version'], generated['title']) == (3, 'Launch (v3)')


@pytest.mark.parametrize('tombstone', [
    {'deletion_started_at': '2026-09-01T10:00:00+00:00'},
    {'status': 'deleting'},
    {'status': 'deleted'},
])
def test_project_deletion_fence_blocks_all_managed_version_writes(
    projects_table, tombstone,
):
    attribute, value = next(iter(tombstone.items()))
    projects_table.update_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'},
        UpdateExpression='SET #tombstone = :value',
        ExpressionAttributeNames={'#tombstone': attribute},
        ExpressionAttributeValues={':value': value},
    )

    with pytest.raises(ServiceError, match='Project deletion has started'):
        persist_versioned_document(
            projects_table, 'p1', 'prd', 'Launch', 'job-after-delete', fields(),
        )

    late = late_legacy_document()
    projects_table.put_item(Item=late)
    with pytest.raises(ServiceError, match='Project deletion has started'):
        persist_legacy_document_versions(projects_table, 'p1', [late])

    stored_late = projects_table.get_item(
        Key={'pk': late['pk'], 'sk': late['sk']}, ConsistentRead=True,
    )['Item']
    assert 'version' not in stored_late
    assert projects_table.query(
        KeyConditionExpression=Key('pk').eq(version_partition_key('p1')),
        ConsistentRead=True,
    )['Items'] == []


@pytest.mark.parametrize('tombstone', [
    {'deletion_started_at': '2026-09-01T10:00:00+00:00'},
    {'status': 'deleting'},
    {'status': 'deleted'},
])
def test_project_deletion_fence_blocks_allocation_history_repair(
    projects_table, tombstone,
):
    original = persist_versioned_document(
        projects_table, 'p1', 'prototype', 'Launch', 'job-history-fence', fields(),
    )
    allocation = _allocation_history(projects_table, 'job-history-fence')
    projects_table.delete_item(Key={'pk': allocation['pk'], 'sk': allocation['sk']})
    attribute, value = next(iter(tombstone.items()))
    projects_table.update_item(
        Key={'pk': 'PROJECT#p1', 'sk': 'META'},
        UpdateExpression='SET #tombstone = :value',
        ExpressionAttributeNames={'#tombstone': attribute},
        ExpressionAttributeValues={':value': value},
    )

    with pytest.raises(ServiceError, match='Project deletion has started'):
        get_versioned_document_by_allocation(
            projects_table, 'p1', 'prototype', 'job-history-fence',
        )

    assert projects_table.get_item(
        Key={'pk': allocation['pk'], 'sk': allocation['sk']}, ConsistentRead=True,
    ).get('Item') is None
    assert projects_table.get_item(
        Key={'pk': original['pk'], 'sk': original['sk']}, ConsistentRead=True,
    )['Item'] == original


def test_fresh_allocation_waits_for_active_legacy_migration(projects_table):
    persist_versioned_document(
        projects_table, 'p1', 'prd', 'Launch', 'job-first', fields(),
    )
    late = late_legacy_document()
    projects_table.put_item(Item=late)

    from shared import document_versions

    lease_acquired = threading.Event()
    release_migration = threading.Event()
    original_persist_identity = document_versions._persist_legacy_identity

    def pause_after_lease(*args, **kwargs):
        lease_acquired.set()
        assert release_migration.wait(timeout=5)
        return original_persist_identity(*args, **kwargs)

    with (
        patch(
            'shared.document_versions._persist_legacy_identity',
            side_effect=pause_after_lease,
        ),
        patch('shared.document_versions._query_project_documents', return_value=[]),
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        migration = pool.submit(
            persist_legacy_document_versions, projects_table, 'p1', [late],
        )
        assert lease_acquired.wait(timeout=5)
        allocation = pool.submit(
            persist_versioned_document,
            projects_table,
            'p1',
            'prd',
            'Launch',
            'job-after-migration',
            fields('2026-09-01T12:00:00+00:00'),
        )
        time.sleep(0.05)
        assert not allocation.done()
        release_migration.set()
        migrated = migration.result(timeout=5)
        generated = allocation.result(timeout=5)

    assert (migrated[0]['version'], migrated[0]['title']) == (2, 'Launch (v2)')
    assert (generated['version'], generated['title']) == (3, 'Launch (v3)')
