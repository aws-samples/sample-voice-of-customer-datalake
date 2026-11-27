"""shared/project_scope.py ``projects_switched``: whether the deployment's projects have switched (7.100.00, 3h-S0).

True only when the switch row is complete, the review registries' backfill marker is complete, and the row names that
marker (``marker_at`` equal to the marker's ``completed_at``), both read strongly consistent. No row, a malformed row,
a row of an older check version, no marker (an ``--unmark``, the marker's reset on a rollback, a restore that brought
the row back without it), an incomplete marker, a re-backfilled marker the row does not name, or a failed read is
False. Against moto, and a table double for the failed reads.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from moto import mock_aws

from shared import project_scope
from shared.project_keys import REVIEW_REGISTRIES_MARKER_KEY
from shared.test.moto_tables import (
    REVIEW_REGISTRIES_MARKER,
    create_projects_table_with_type_index,
    mark_review_registries_backfilled,
)

ROW: dict[str, Any] = {**project_scope.SWITCH_KEY, 'switched_at': '2026-11-27T12:00:00+00:00', 'release': '7.99.0',
                       'projects_checked': 12, 'steps': 1, 'marker_at': REVIEW_REGISTRIES_MARKER['completed_at'],
                       'check': 1, 'applied_by': 'arn:aws:iam::111122223333:role/Operator'}


@pytest.fixture
def table():
    with mock_aws():
        yield create_projects_table_with_type_index('projects')


def test_the_row_for_the_current_marker_reads_as_switched(table):
    mark_review_registries_backfilled(table)
    table.put_item(Item=dict(ROW))
    assert project_scope.projects_switched(table) is True


def test_the_row_has_exactly_these_attributes():
    assert sorted(project_scope.SWITCH_ATTRIBUTES) == sorted(ROW)
    assert project_scope.switch_row('2026-11-27T12:00:00+00:00', '7.99.0', 12, 1, ROW['marker_at'],
                                    ROW['applied_by']) == ROW


def test_no_row_reads_as_not_switched(table):
    mark_review_registries_backfilled(table)
    assert project_scope.projects_switched(table) is False


def test_a_row_without_the_marker_reads_as_not_switched(table):
    """An --unmark, the marker's reset on a rollback below 7.48.00, or a restore that brought the row back alone."""
    table.put_item(Item=dict(ROW))
    assert project_scope.projects_switched(table) is False


def test_a_row_for_an_older_marker_reads_as_not_switched(table):
    """A re-backfill (an unmark, then --apply) writes a new marker: the projects stay off until the check runs again."""
    table.put_item(Item={**REVIEW_REGISTRIES_MARKER, 'completed_at': '2026-12-01T00:00:00+00:00'})
    table.put_item(Item=dict(ROW))
    assert project_scope.projects_switched(table) is False


@pytest.mark.parametrize('broken', [{'release': '7.47.0'}, {'completed_at': None}, {'projects_found': None}])
def test_a_row_with_an_incomplete_marker_reads_as_not_switched(table, broken):
    marker = {**REVIEW_REGISTRIES_MARKER, **broken}
    table.put_item(Item={name: value for name, value in marker.items() if value is not None})
    table.put_item(Item=dict(ROW))
    assert project_scope.projects_switched(table) is False


@pytest.mark.parametrize('broken', [
    {'switched_at': None}, {'switched_at': 'yesterday'}, {'switched_at': '2026-11-27T12:00:00'},
    {'release': None}, {'release': '7.100'}, {'release': '7.47.9'},
    {'projects_checked': None}, {'projects_checked': -1}, {'projects_checked': '12'}, {'projects_checked': True},
    {'projects_checked': Decimal('1.5')},
    {'steps': None}, {'steps': 0}, {'steps': False},
    {'marker_at': None}, {'marker_at': 'yesterday'},
    {'check': None}, {'check': 0}, {'check': '1'}, {'check': True},
    {'applied_by': None}, {'applied_by': ''}, {'applied_by': 7},
    {'note': 'by hand'},
])
def test_a_malformed_row_reads_as_not_switched(table, broken):
    mark_review_registries_backfilled(table)
    item = {name: value for name, value in {**ROW, **broken}.items() if value is not None}
    table.put_item(Item=item)
    assert project_scope.projects_switched(table) is False


def test_a_later_check_version_is_accepted():
    assert project_scope.switch_row_complete({**ROW, 'check': project_scope.CHECK_VERSION + 1}) is True


@pytest.mark.parametrize('key', [{'pk': 'DOCSHARE_IDS'}, {'sk': 'META'}, {'pk': 'WS#ws_x#PROJECTS_SWITCH'}])
def test_a_row_under_another_key_is_not_a_switch_row(key):
    assert project_scope.switch_row_complete({**ROW, **key}) is False


def test_numbers_as_dynamodb_answers_them_are_counts():
    assert project_scope.switch_row_complete(
        {**ROW, 'projects_checked': Decimal(12), 'steps': Decimal(1), 'check': Decimal(1)}) is True


@pytest.mark.parametrize('row', [None, 'switched', [ROW], {}])
def test_what_is_not_a_row_is_not_complete(row):
    assert project_scope.switch_row_complete(row) is False


@pytest.mark.parametrize('error', [
    ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetItem'),
    ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}}, 'GetItem'),
    EndpointConnectionError(endpoint_url='https://dynamodb.example'),
])
@pytest.mark.parametrize('failing_read', [0, 1])
def test_a_failed_read_of_either_row_reads_as_not_switched(error, failing_read):
    answers: list[Any] = [{'Item': dict(ROW)}, {'Item': dict(REVIEW_REGISTRIES_MARKER)}]
    answers[failing_read] = error
    reader = MagicMock()
    reader.get_item.side_effect = answers
    assert project_scope.projects_switched(reader) is False


def test_both_reads_are_strongly_consistent_and_name_their_keys():
    reader = MagicMock()
    reader.get_item.side_effect = [{'Item': dict(ROW)}, {'Item': dict(REVIEW_REGISTRIES_MARKER)}]
    assert project_scope.projects_switched(reader) is True
    assert [call.kwargs for call in reader.get_item.call_args_list] == [
        {'Key': project_scope.SWITCH_KEY, 'ConsistentRead': True},
        {'Key': REVIEW_REGISTRIES_MARKER_KEY, 'ConsistentRead': True}]


@pytest.mark.parametrize('answer', [{}, {'Item': None}, {'Item': 'switched'}])
def test_an_answer_without_a_marker_reads_as_not_switched(answer):
    reader = MagicMock()
    reader.get_item.side_effect = [{'Item': dict(ROW)}, answer]
    assert project_scope.projects_switched(reader) is False
