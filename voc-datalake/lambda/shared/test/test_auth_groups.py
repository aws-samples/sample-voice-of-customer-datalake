"""
Tests for shared/api.py caller-group extraction and admin enforcement.

The REST API Gateway Cognito authorizer serializes the ``cognito:groups``
array claim in several shapes depending on group count and integration —
including a bracket-wrapped string. Missing one format 403s real admins in
deployment (review feedback on #154).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from shared.api import get_caller_groups, require_admin  # noqa: E402
from shared.exceptions import AuthorizationError  # noqa: E402


def _event(groups):
    claims = {'sub': 'u1'}
    if groups is not None:
        claims['cognito:groups'] = groups
    return {'requestContext': {'authorizer': {'claims': claims}}}


class TestGetCallerGroups:
    @pytest.mark.parametrize('raw,expected', [
        ('admins', ['admins']),
        ('admins users', ['admins', 'users']),
        ('admins, users', ['admins', 'users']),
        ('admins,users', ['admins', 'users']),
        (['admins', 'users'], ['admins', 'users']),
        # REST authorizer serialization of the array claim:
        ('[admins]', ['admins']),
        ('[admins, users]', ['admins', 'users']),
        ('[admins users]', ['admins', 'users']),
        ('[]', []),
        ('', []),
        (None, []),
    ])
    def test_parses_every_api_gateway_claim_format(self, raw, expected):
        assert get_caller_groups(_event(raw)) == expected

    def test_missing_request_context_returns_empty(self):
        assert get_caller_groups({}) == []


class TestRequireAdmin:
    @pytest.mark.parametrize('raw', ['admins', '[admins]', '[admins, users]', ['admins']])
    def test_accepts_admins_in_every_format(self, raw):
        require_admin(_event(raw))  # must not raise

    @pytest.mark.parametrize('raw', ['users', '[users]', '', None, '[]'])
    def test_rejects_non_admins(self, raw):
        with pytest.raises(AuthorizationError):
            require_admin(_event(raw))
