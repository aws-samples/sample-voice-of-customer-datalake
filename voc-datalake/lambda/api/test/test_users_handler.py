"""
Tests for users_handler.py - GET /users membership reads.

The per-route contract (admin gate, exact Cognito calls, refusals, responses) is
pinned in test_users_handler_mutation.py; group-parsing/require_admin unit tests
live in lambda/shared/test/test_api.py.
"""
import json
from unittest.mock import patch

import pytest


def _call_users(api_gateway_event, lambda_context, **event_kwargs):
    """Build a /users event for the default (admin) caller, invoke the handler, return (status, body)."""
    from users_handler import lambda_handler
    response = lambda_handler(api_gateway_event(**event_kwargs), lambda_context)
    return response['statusCode'], json.loads(response['body'])


def _pool_user(name: str) -> dict:
    return {
        'Username': name, 'Attributes': [{'Name': 'sub', 'Value': f'sub-{name}'}],
        'UserStatus': 'CONFIRMED', 'Enabled': True,
    }


class TestListUsersGroupsWithoutPerUserCalls:
    """GET /users reads memberships per GROUP, not per user (E2E F10).

    It used to call AdminListGroupsForUser once per user, serially: production's
    13 users meant 13 round-trips and a p95 of ~3.8 s. The call count is now a
    function of the number of groups, which is fixed.
    """

    @staticmethod
    def _pool(mock_cognito, users: int) -> None:
        names = [f'user{i}' for i in range(users)]
        # Two pages of users, to prove ListUsers still pages.
        mock_cognito.list_users.side_effect = [
            {'Users': [_pool_user(n) for n in names[:users // 2]], 'PaginationToken': 'p2'},
            {'Users': [_pool_user(n) for n in names[users // 2:]]},
        ]
        mock_cognito.list_groups.return_value = {'Groups': [{'GroupName': 'admins'}, {'GroupName': 'users'}]}
        members = {'admins': names[:1], 'users': names[1:-1]}  # the last user is in no group
        mock_cognito.list_users_in_group.side_effect = lambda GroupName, **_kw: {
            'Users': [{'Username': n} for n in members[GroupName]]}

    @staticmethod
    def _groups_by_user(api_gateway_event, lambda_context) -> dict[str, list[str]]:
        """GET /users, reduced to each listed user's groups."""
        _, body = _call_users(api_gateway_event, lambda_context, method='GET', path='/users')
        return {u['username']: u['groups'] for u in body['users']}

    @pytest.mark.parametrize('users', [4, 40])
    @patch('users_handler.cognito')
    def test_cognito_calls_do_not_grow_with_users(self, mock_cognito, api_gateway_event, lambda_context, users):
        self._pool(mock_cognito, users)

        status, body = _call_users(api_gateway_event, lambda_context, method='GET', path='/users')

        assert status == 200
        assert len(body['users']) == users
        mock_cognito.admin_list_groups_for_user.assert_not_called()
        assert mock_cognito.list_groups.call_count == 1
        assert mock_cognito.list_users_in_group.call_count == 2
        assert mock_cognito.list_users.call_count == 2

    @patch('users_handler.cognito')
    def test_every_user_keeps_exactly_its_groups(self, mock_cognito, api_gateway_event, lambda_context):
        self._pool(mock_cognito, 4)

        assert self._groups_by_user(api_gateway_event, lambda_context) == {
            'user0': ['admins'], 'user1': ['users'], 'user2': ['users'], 'user3': []}

    @patch('users_handler.cognito')
    def test_group_listings_follow_next_token(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.list_users.return_value = {'Users': [_pool_user('a'), _pool_user('b')]}
        mock_cognito.list_groups.side_effect = [
            {'Groups': [{'GroupName': 'admins'}], 'NextToken': 'g2'},
            {'Groups': [{'GroupName': 'users'}]},
        ]
        # Keyed by (group, token), not an ordered list: the two groups are now
        # listed concurrently, so their calls interleave in any order.
        member_pages = {
            ('admins', None): {'Users': [{'Username': 'a'}], 'NextToken': 'm2'},
            ('admins', 'm2'): {'Users': [{'Username': 'b'}]},
            ('users', None): {'Users': [{'Username': 'b'}]},
        }
        mock_cognito.list_users_in_group.side_effect = (
            lambda GroupName, NextToken=None, **_kw: member_pages[(GroupName, NextToken)])

        assert self._groups_by_user(api_gateway_event, lambda_context) == {'a': ['admins'], 'b': ['admins', 'users']}
        assert mock_cognito.list_groups.call_args_list[1].kwargs['NextToken'] == 'g2'
        assert sorted(
            (c.kwargs['GroupName'], c.kwargs.get('NextToken', ''))
            for c in mock_cognito.list_users_in_group.call_args_list
        ) == [('admins', ''), ('admins', 'm2'), ('users', '')]
