"""Pure-function contracts of shared.project_writes: the tombstone and fixture
predicates, the table-name resolution and the shared condition-check shape.

The DynamoDB-evaluated behaviour lives in test_project_writes.py.
"""

from unittest.mock import MagicMock

import pytest

from shared.project_writes import (
    PROJECT_WRITABLE_CONDITION,
    VERIFICATION_FIXTURE_ATTRIBUTE,
    is_project_tombstone,
    is_verification_fixture,
    project_meta_key,
    project_writable_condition,
    projects_table_name,
)


@pytest.mark.parametrize('item', [
    None,
    {},
    {'pk': 'PROJECT#p1', 'sk': 'META'},
    {'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'active'},
    {'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'archived'},
])
def test_live_or_missing_project_is_not_a_tombstone(item):
    assert is_project_tombstone(item) is False


@pytest.mark.parametrize('item', [
    {'pk': 'PROJECT#p1', 'sk': 'META', 'deletion_started_at': '2026-09-03T12:00:00+00:00'},
    {'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'deleting'},
    {'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'deleted'},
    {'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'active', 'deletion_started_at': ''},
])
def test_deletion_marker_or_terminal_status_is_a_tombstone(item):
    assert is_project_tombstone(item) is True


def test_fixture_marker_is_the_attribute_the_fixture_provider_writes():
    # lambda/api/verification_fixture_provider.py writes this exact name on
    # every fixture record; the project list hides rows that carry it.
    assert VERIFICATION_FIXTURE_ATTRIBUTE == 'verification_fixture_id'


@pytest.mark.parametrize(('item', 'expected'), [
    (None, False),
    ({}, False),
    ({'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'active'}, False),
    ({'pk': 'PROJECT#p1', 'sk': 'META', 'verification_fixture_id': 'abca-1'}, True),
    # Presence, not value: an empty marker still hides the row.
    ({'pk': 'PROJECT#p1', 'sk': 'META', 'verification_fixture_id': ''}, True),
])
def test_only_rows_carrying_the_fixture_marker_are_fixtures(item, expected):
    assert is_verification_fixture(item) is expected


def _table_named(name):
    table = MagicMock()
    table.name = name
    return table


def test_table_object_name_wins_over_the_environment(monkeypatch):
    monkeypatch.setenv('PROJECTS_TABLE', 'voc-projects-env')

    assert projects_table_name(_table_named('voc-projects-table')) == 'voc-projects-table'


@pytest.mark.parametrize('table', [
    _table_named(''),
    _table_named(None),
    MagicMock(),  # its .name is itself a Mock, never a str
], ids=['empty', 'none', 'mock-attribute'])
def test_unusable_table_name_falls_back_to_projects_table_env(monkeypatch, table):
    monkeypatch.setenv('PROJECTS_TABLE', 'voc-projects-env')

    assert projects_table_name(table) == 'voc-projects-env'


@pytest.mark.parametrize('env', [None, ''])
def test_no_table_name_anywhere_is_refused(monkeypatch, env):
    if env is None:
        monkeypatch.delenv('PROJECTS_TABLE', raising=False)
    else:
        monkeypatch.setenv('PROJECTS_TABLE', env)

    with pytest.raises(ValueError, match=r'^Projects table name is required$'):
        projects_table_name(_table_named(''))


def test_meta_key_addresses_the_project_partition_meta_row():
    assert project_meta_key('p1') == {'pk': 'PROJECT#p1', 'sk': 'META'}


def test_writable_condition_checks_the_meta_row_with_the_tombstone_fence():
    assert project_writable_condition('voc-projects', 'p1') == {
        'ConditionCheck': {
            'TableName': 'voc-projects',
            'Key': {'pk': 'PROJECT#p1', 'sk': 'META'},
            'ConditionExpression': PROJECT_WRITABLE_CONDITION,
            'ExpressionAttributeNames': {
                '#deleting': 'deletion_started_at',
                '#status': 'status',
            },
            'ExpressionAttributeValues': {
                ':deleting_status': 'deleting',
                ':deleted_status': 'deleted',
            },
        },
    }


def test_writable_condition_hands_out_fresh_mappings():
    first = project_writable_condition('voc-projects', 'p1')['ConditionCheck']
    first['ExpressionAttributeNames']['#extra'] = 'extra'
    first['ExpressionAttributeValues'][':extra'] = 1

    second = project_writable_condition('voc-projects', 'p1')['ConditionCheck']
    assert '#extra' not in second['ExpressionAttributeNames']
    assert ':extra' not in second['ExpressionAttributeValues']
