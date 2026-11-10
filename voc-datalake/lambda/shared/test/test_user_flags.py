"""Tests for shared/user_flags.py — real DynamoDB semantics via moto (the
fallback-owner invariant lives in a conditional transaction a mock can't refuse)."""
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from shared import user_flags
from shared.exceptions import ConflictError
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def resource_and_table():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        yield resource, create_pk_sk_table('test-aggregates', resource)


@pytest.fixture
def table(resource_and_table):
    return resource_and_table[1]


def _set(table, sub, **changes):
    return user_flags.set_flags(table, sub=sub, username=f'user-{sub}', changes=changes, actor_sub='admin-sub')


class TestFlags:
    def test_fallback_owner_moves_and_there_is_only_one(self, table):
        _set(table, 's1', fallback_owner=True, memory_reviewer=True)
        assert user_flags.get_fallback_owner(table) == {'sub': 's1', 'username': 'user-s1'}
        _set(table, 's2', fallback_owner=True)
        assert user_flags.get_fallback_owner(table) == {'sub': 's2', 'username': 'user-s2'}
        # The previous owner's mirror row was cleared in the same transaction,
        # and their other flag kept.
        assert user_flags.get_user_flags(table, 's1') == {'fallback_owner': False, 'memory_reviewer': True}
        assert user_flags.get_user_flags(table, 's2')['fallback_owner'] is True

    def test_clearing_the_owner(self, table):
        _set(table, 's1', fallback_owner=True)
        _set(table, 's1', fallback_owner=False)
        assert user_flags.get_fallback_owner(table) is None
        # Setting someone after a clear works (pointer row exists without a sub).
        _set(table, 's2', fallback_owner=True)
        assert user_flags.get_fallback_owner(table) == {'sub': 's2', 'username': 'user-s2'}

    def test_concurrent_change_is_a_conflict(self, table):
        _set(table, 's1', fallback_owner=True)
        stale = {'sub': 's0', 'username': 'x'}  # what a racing request read
        with patch.object(user_flags, 'get_fallback_owner', return_value=stale), pytest.raises(ConflictError):
            _set(table, 's2', fallback_owner=True)
        assert user_flags.get_fallback_owner(table) == {'sub': 's1', 'username': 'user-s1'}


class TestFlagsForSubs:
    def test_batch_read_with_pointer_as_source_of_truth(self, resource_and_table):
        resource, table = resource_and_table
        _set(table, 's1', memory_reviewer=True)
        _set(table, 's2', fallback_owner=True)
        flags = user_flags.flags_for_subs(resource, 'test-aggregates', ['s1', 's2', 's3', '', 's1'])
        assert flags == {
            's1': {'fallback_owner': False, 'memory_reviewer': True},
            's2': {'fallback_owner': True, 'memory_reviewer': False},
            's3': {'fallback_owner': False, 'memory_reviewer': False},
        }
