"""delete_persona never drives persona_count negative, and still deletes when it drifted (#267 item 3).

The ordinary transaction decrements under ``persona_count >= :one``. When only
that guard refuses (a legacy project without the counter, or one that drifted to
zero), the persona is still deleted and the counter pinned at zero.
"""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

import projects
from shared.exceptions import ServiceError
from shared.test.document_versions_fixtures import client_error


def _cancelled(*codes: str) -> ClientError:
    return client_error('TransactionCanceledException', *codes)


@pytest.fixture
def table():
    table = MagicMock()
    with patch.object(projects, 'projects_table', table), \
            patch.object(projects, 'projects_table_name', return_value='projects-table'), \
            patch.object(projects, '_sweep_removed_persona_avatars') as sweep:
        table.sweep = sweep
        yield table


def _updates(table: MagicMock) -> list[dict]:
    return [
        c.kwargs['TransactItems'][1]['Update']
        for c in table.meta.client.transact_write_items.call_args_list
    ]


def test_a_counter_at_zero_still_deletes_the_persona_and_pins_the_counter_at_zero(table):
    table.meta.client.transact_write_items.side_effect = [
        _cancelled('None', 'ConditionalCheckFailed'), {},
    ]
    assert projects.delete_persona('p1', 'per_1') == {'success': True}
    first, floor = _updates(table)
    assert first['UpdateExpression'].startswith('SET persona_count = persona_count - :one')
    assert floor['UpdateExpression'] == 'SET persona_count = :zero, updated_at = :now'
    assert floor['ConditionExpression'].endswith(
        'AND (attribute_not_exists(persona_count) OR persona_count < :one)')
    assert floor['ExpressionAttributeValues'][':zero'] == 0
    assert projects.PROJECT_WRITABLE_CONDITION in floor['ConditionExpression']
    table.sweep.assert_called_once_with('p1', ['per_1'])


def test_no_write_ever_subtracts_without_the_non_negative_guard(table):
    table.meta.client.transact_write_items.side_effect = [
        _cancelled('None', 'ConditionalCheckFailed'), {},
    ]
    projects.delete_persona('p1', 'per_1')
    for update in _updates(table):
        if '- :one' in update['UpdateExpression']:
            assert 'persona_count >= :one' in update['ConditionExpression']


@pytest.mark.parametrize('error', [
    _cancelled('ConditionalCheckFailed', 'None'),
    _cancelled('ConditionalCheckFailed', 'ConditionalCheckFailed'),
    _cancelled('None', 'TransactionConflict'),
    _cancelled('None'),
    ClientError({'Error': {'Code': 'ValidationException', 'Message': 'bad'}}, 'TransactWriteItems'),
])
def test_any_other_refusal_is_reported_without_a_floor_retry(table, error):
    table.meta.client.transact_write_items.side_effect = error
    with pytest.raises(ServiceError, match=r'^Failed to delete persona$'):
        projects.delete_persona('p1', 'per_1')
    assert table.meta.client.transact_write_items.call_count == 1
    table.sweep.assert_not_called()


def test_a_refused_floor_write_is_reported(table):
    table.meta.client.transact_write_items.side_effect = [
        _cancelled('None', 'ConditionalCheckFailed'), _cancelled('None', 'ConditionalCheckFailed'),
    ]
    with pytest.raises(ServiceError, match=r'^Failed to delete persona$'):
        projects.delete_persona('p1', 'per_1')
    table.sweep.assert_not_called()
