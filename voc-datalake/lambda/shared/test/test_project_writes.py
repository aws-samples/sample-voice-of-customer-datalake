"""DynamoDB-level contracts for retained project tombstones."""

from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import project_writes
from shared.project_writes import (
    put_project_item,
    put_project_item_and_increment,
)
from shared.test.moto_tables import create_pk_sk_table

META_KEY = {'pk': 'PROJECT#p1', 'sk': 'META'}
CHILD_KEY = {'pk': 'PROJECT#p1', 'sk': 'DOC#new'}


@pytest.fixture(scope='module')
def projects_table():
    # One moto table for the module: creating a table costs ~0.8 s per test,
    # and every test here writes the same two keys, which _empty_table clears.
    with mock_aws():
        yield create_pk_sk_table('test-project-writes')


@pytest.fixture(autouse=True)
def _empty_table(projects_table):
    for key in projects_table.scan(ProjectionExpression='pk, sk')['Items']:
        projects_table.delete_item(Key=key)


def _get(table, key):
    return table.get_item(Key=key, ConsistentRead=True).get('Item')


def _child(**extra):
    return {**CHILD_KEY, 'document_id': 'new', **extra}


def _write(writer, table, item):
    if writer == 'child_only':
        put_project_item(table, 'p1', item)
    else:
        put_project_item_and_increment(table, 'p1', item, 'document_count')


@pytest.mark.parametrize('writer', ['child_only', 'child_and_count'])
@pytest.mark.parametrize(('tombstone', 'expected_status'), [
    ({'deletion_started_at': '2026-09-03T12:00:00+00:00'}, None),
    ({'status': 'deleting'}, 'deleting'),
    ({'status': 'deleted'}, 'deleted'),
])
def test_retained_tombstone_rejects_project_child_creation(
    projects_table, writer, tombstone, expected_status,
):
    projects_table.put_item(Item={**META_KEY, 'document_count': 0, **tombstone})
    item = _child(created_at='2026-09-03T12:01:00+00:00')

    with pytest.raises(ClientError):
        _write(writer, projects_table, item)

    assert _get(projects_table, CHILD_KEY) is None
    stored = _get(projects_table, META_KEY)
    assert stored.get('status') == expected_status
    assert stored['document_count'] == 0


@pytest.mark.parametrize('writer', ['child_only', 'child_and_count'])
def test_missing_project_meta_rejects_project_child_creation(projects_table, writer):
    item = _child(created_at='2026-09-03T12:01:00+00:00')

    with pytest.raises(ClientError):
        _write(writer, projects_table, item)

    assert _get(projects_table, CHILD_KEY) is None


@pytest.mark.parametrize('status', [None, 'active', 'archived'])
def test_live_project_status_allows_project_child_creation(projects_table, status):
    meta = {**META_KEY, 'document_count': 0, 'updated_at': '2026-09-01T00:00:00+00:00'}
    if status is not None:
        meta['status'] = status
    projects_table.put_item(Item=meta)
    item = _child(created_at='2026-09-03T12:01:00+00:00')

    put_project_item_and_increment(
        projects_table, 'p1', item, 'document_count',
    )

    assert _get(projects_table, CHILD_KEY)['document_id'] == 'new'
    stored = _get(projects_table, META_KEY)
    assert stored['document_count'] == 1
    # META's updated_at is the child's created_at, not the wall clock.
    assert stored['updated_at'] == '2026-09-03T12:01:00+00:00'


def test_child_without_created_at_stamps_meta_with_the_clock(projects_table):
    projects_table.put_item(Item={**META_KEY, 'document_count': 2})
    frozen = datetime(2026, 9, 3, 12, 5, tzinfo=UTC)

    with patch.object(project_writes, 'datetime') as clock:
        clock.now.return_value = frozen
        put_project_item_and_increment(
            projects_table, 'p1', _child(), 'document_count',
        )

    clock.now.assert_called_once_with(UTC)
    stored = _get(projects_table, META_KEY)
    assert stored['document_count'] == 3
    assert stored['updated_at'] == '2026-09-03T12:05:00+00:00'


def test_first_child_counts_from_zero_when_meta_has_no_counter(projects_table):
    projects_table.put_item(Item=META_KEY)

    put_project_item_and_increment(
        projects_table, 'p1', _child(created_at='2026-09-03T12:01:00+00:00'),
        'persona_count',
    )

    assert _get(projects_table, META_KEY)['persona_count'] == 1


@pytest.mark.parametrize('writer', ['child_only', 'child_and_count'])
def test_existing_child_is_never_overwritten(projects_table, writer):
    projects_table.put_item(Item={**META_KEY, 'document_count': 1})
    projects_table.put_item(Item=_child(title='original'))
    item = _child(title='replacement', created_at='2026-09-03T12:01:00+00:00')

    with pytest.raises(ClientError):
        _write(writer, projects_table, item)

    assert _get(projects_table, CHILD_KEY)['title'] == 'original'
    assert _get(projects_table, META_KEY)['document_count'] == 1


def test_child_only_write_leaves_meta_untouched(projects_table):
    meta = {**META_KEY, 'document_count': 4, 'updated_at': '2026-09-01T00:00:00+00:00'}
    projects_table.put_item(Item=meta)

    put_project_item(projects_table, 'p1', _child(title='note'))

    assert _get(projects_table, CHILD_KEY)['title'] == 'note'
    assert _get(projects_table, META_KEY) == meta
