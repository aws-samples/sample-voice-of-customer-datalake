"""
Tests for settings_handler.py - /settings/* endpoints.
Manages brand configuration and categories.
"""
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

from settings_handler import lambda_handler


class TestGetBrandSettings:
    """Tests for GET /settings/brand endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_returns_brand_settings_when_exists(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns brand configuration from DynamoDB."""
        # Arrange
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'SETTINGS#brand',
                'sk': 'config',
                'brand_name': 'TestBrand',
                'brand_handles': ['@testbrand', '@test'],
                'hashtags': ['#testbrand', '#test'],
                'urls_to_track': ['https://example.com']
            }
        }


        # Act
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/brand',
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['brand_name'] == 'TestBrand'
        assert body['brand_handles'] == ['@testbrand', '@test']
        assert body['hashtags'] == ['#testbrand', '#test']
        assert body['urls_to_track'] == ['https://example.com']

    @patch('settings_handler.aggregates_table')
    def test_returns_empty_defaults_when_no_settings_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty defaults when no brand settings configured."""
        # Arrange
        mock_table.get_item.return_value = {}

        # Act
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/brand',
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['brand_name'] == ''
        assert body['brand_handles'] == []
        assert body['hashtags'] == []
        assert body['urls_to_track'] == []

class TestResolvedProblems:
    """Tests for GET/PUT /settings/resolved-problems (issue #66)."""

    @patch('settings_handler.aggregates_table')
    def test_get_returns_resolved_map(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'SETTINGS#resolved_problems',
                'sk': 'config',
                'resolved': {'delivery|general|late orders': {'resolved_at': '2026-07-01T00:00:00+00:00'}},
            }
        }

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/resolved-problems',
        )

        assert response['statusCode'] == 200
        assert 'delivery|general|late orders' in body['resolved']

    @patch('settings_handler.aggregates_table')
    def test_get_returns_empty_map_when_unset(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {}

        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/resolved-problems',
        )

        assert body['resolved'] == {}

class TestResolvedProblemsCap:
    """The entry cap never applies to an unresolve (review feedback on #153)."""

    @patch('settings_handler.aggregates_table')
    def test_unresolve_is_never_capped_and_tolerates_missing_map(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Missing parent map surfaces as a FAILED CONDITION (stable error
        code), not as message-text sniffing on ValidationException."""
        from botocore.exceptions import ClientError

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'no map'}},
            'UpdateItem',
        )

        response, _ = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem 3', 'resolved': False},
        )

        # Missing parent map == nothing to remove == success.
        assert response['statusCode'] == 200
        assert mock_table.update_item.call_args.kwargs['ConditionExpression'] == 'attribute_exists(#r)'


class TestResolvedProblemsExpiry:
    """Entry expiry on GET (issue #159).

    Resolution keys are client-derived from similarity groups, so a key can
    be orphaned forever when its group re-forms differently. Entries expire
    after RESOLVED_PROBLEMS_TTL_DAYS and GET filters them from responses (the
    cap-pressure prune is pinned in test_settings_handler_mutation.py).
    """

    @staticmethod
    def _entry(days_old: int) -> dict:
        return {'resolved_at': (datetime.now(UTC) - timedelta(days=days_old)).isoformat()}

    @patch('settings_handler.aggregates_table')
    def test_get_filters_expired_entries(self, mock_table, api_gateway_event, lambda_context):

        mock_table.get_item.return_value = {
            'Item': {'resolved': {
                'cat|sub|fresh': self._entry(days_old=1),
                'cat|sub|ancient': self._entry(days_old=181),
            }}
        }

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/resolved-problems',
        )

        assert response['statusCode'] == 200
        assert 'cat|sub|fresh' in body['resolved']
        assert 'cat|sub|ancient' not in body['resolved']

    @patch('settings_handler.RESOLVED_PROBLEMS_TTL_DAYS', 0)
    @patch('settings_handler.aggregates_table')
    def test_ttl_zero_disables_expiry(self, mock_table, api_gateway_event, lambda_context):

        mock_table.get_item.return_value = {
            'Item': {'resolved': {'cat|sub|ancient': self._entry(days_old=5000)}}
        }

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/resolved-problems',
        )

        assert response['statusCode'] == 200
        assert 'cat|sub|ancient' in body['resolved']

    @patch('settings_handler.aggregates_table')
    def test_malformed_entries_count_as_expired(self, mock_table, api_gateway_event, lambda_context):
        """Entries without a comparable resolved_at can never be displayed or
        aged out normally — they must not hold cap slots forever."""

        mock_table.get_item.return_value = {
            'Item': {'resolved': {
                'cat|sub|no-date': {},
                'cat|sub|wrong-type': {'resolved_at': 12345},
                'cat|sub|fresh': self._entry(days_old=1),
            }}
        }

        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/resolved-problems',
        )

        assert list(body['resolved']) == ['cat|sub|fresh']

    @patch('settings_handler.aggregates_table')
    def test_get_tolerates_malformed_resolved_attribute(self, mock_table, api_gateway_event, lambda_context):
        """Non-dict storage under 'resolved' degrades to an empty map, not a 500
        (symmetry with the prune path's guard)."""

        mock_table.get_item.return_value = {'Item': {'resolved': 'corrupted'}}

        response, _ = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/resolved-problems',
        )

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['resolved'] == {}

    def test_ttl_env_parse_falls_back_on_garbage(self):
        """A console typo in RESOLVED_PROBLEMS_TTL_DAYS must not crash the
        whole settings Lambda at import — boundary validation."""
        from settings_handler import _parse_ttl_days

        assert _parse_ttl_days('180d') == 180
        assert _parse_ttl_days('') == 180
        assert _parse_ttl_days(None) == 180
        assert _parse_ttl_days('30') == 30
        assert _parse_ttl_days('0') == 0

class TestGetModelSettings:
    """Tests for GET /settings/model (per-surface AI model picker, issue #96)."""

    @staticmethod
    def _read_stored(mock_table, api_gateway_event, lambda_context, **stored) -> tuple[dict, dict]:
        """GET /settings/model over a stored model-settings row; (body, surfaces by key)."""
        mock_table.get_item.return_value = {'Item': {'pk': 'SETTINGS#model', 'sk': 'config', **stored}}
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/model',
        )
        return body, {s['key']: s for s in body['surfaces']}

    @patch('settings_handler.aggregates_table')
    def test_returns_allowlist_and_surfaces_when_unset(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """With nothing configured every surface is Automatic (selected=null)
        and carries its built-in default."""
        mock_table.get_item.return_value = {}

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/model',
        )

        assert response['statusCode'] == 200
        model_ids = {m['id'] for m in body['available_models']}
        assert model_ids == {
            'global.anthropic.claude-opus-5-5',
            'global.anthropic.claude-sonnet-5-5',
            'global.anthropic.claude-sonnet-5',
            'global.anthropic.claude-sonnet-4-6',
            'global.anthropic.claude-opus-5',
            'global.anthropic.claude-opus-4-8',
            'global.anthropic.claude-haiku-5-5',
            'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        }
        surfaces = {s['key']: s for s in body['surfaces']}
        assert set(surfaces) == {
            'chat', 'documents', 'prototype', 'enrichment', 'utility',
            'memory', 'agent_orchestrator', 'agent_worker', 'agent_reviewer', 'agent_persona',
        }
        assert all(s['selected'] is None for s in body['surfaces'])
        assert surfaces['memory']['default_id'] == 'global.anthropic.claude-haiku-5-5'
        assert surfaces['agent_orchestrator']['default_id'] == 'global.anthropic.claude-opus-5-5'
        assert surfaces['chat']['default_id'] == 'global.anthropic.claude-sonnet-5-5'
        assert surfaces['documents']['default_id'] == 'global.anthropic.claude-sonnet-5-5'
        assert surfaces['prototype']['default_id'] == 'global.anthropic.claude-opus-5-5'
        assert surfaces['enrichment']['default_id'] == 'global.anthropic.claude-haiku-5-5'
        assert body['model_id'] is None

    @patch('settings_handler.aggregates_table')
    def test_returns_configured_surface_overrides(
        self, mock_table, api_gateway_event, lambda_context
    ):
        _, surfaces = self._read_stored(
            mock_table, api_gateway_event, lambda_context,
            surfaces={'chat': 'global.anthropic.claude-haiku-4-5-20251001-v1:0'},
        )

        assert surfaces['chat']['selected'] == 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
        assert surfaces['documents']['selected'] is None

    @patch('settings_handler.aggregates_table')
    def test_hides_non_allowlisted_stored_values(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """A stale/tampered stored id (e.g. delisted Sonnet 4.5) reads back
        as Automatic, never as a selectable value."""
        body, surfaces = self._read_stored(
            mock_table, api_gateway_event, lambda_context,
            surfaces={'chat': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'},
            model_id='anthropic.evil-model-v9',
        )

        assert surfaces['chat']['selected'] is None
        assert body['model_id'] is None

    @patch('settings_handler.aggregates_table')
    def test_non_admin_can_read_model_settings(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """GET stays open to all authenticated users (read-only)."""
        mock_table.get_item.return_value = {}

        event = api_gateway_event(method='GET', path='/settings/model')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200


class TestSaveModelSettings:
    """Tests for PUT /settings/model (admin-gated, per-surface)."""

    HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

    @patch('settings_handler.aggregates_table')
    def test_clearing_a_surface_preserves_other_surfaces(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """{'surface': X, 'model_id': null} returns X to Automatic without
        touching other pinned surfaces."""
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'SETTINGS#model', 'sk': 'config',
                'surfaces': {
                    'chat': self.HAIKU,
                    'prototype': 'global.anthropic.claude-opus-5',
                },
            }
        }

        response, _ = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='PUT', path='/settings/model',
            body={'surface': 'chat', 'model_id': None},
        )

        assert response['statusCode'] == 200
        item = mock_table.put_item.call_args.kwargs['Item']
        assert item['surfaces'] == {'prototype': 'global.anthropic.claude-opus-5'}

    @patch('settings_handler.aggregates_table')
    def test_non_admin_put_is_403(self, mock_table, api_gateway_event, lambda_context):
        """The Cognito authorizer only proves authentication; changing the
        org-wide model mix requires the admins group server-side."""
        event = api_gateway_event(
            method='PUT', path='/settings/model',
            body={'surface': 'chat', 'model_id': self.HAIKU},
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        mock_table.put_item.assert_not_called()

    @patch('settings_handler.aggregates_table')
    def test_missing_groups_put_is_403(self, mock_table, api_gateway_event, lambda_context):
        event = api_gateway_event(
            method='PUT', path='/settings/model',
            body={'surface': 'chat', 'model_id': self.HAIKU},
        )
        del event['requestContext']['authorizer']['claims']['cognito:groups']
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        mock_table.put_item.assert_not_called()


class TestModelTestAndCapacityRoutes:
    """POST /settings/model/test and GET /settings/model/capacity (admin-only)."""

    OPUS55 = 'global.anthropic.claude-opus-5-5'

    @staticmethod
    def _as_user(event: dict) -> dict:
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
        return event

    @patch('settings_handler.model_capacity.probe_model')
    def test_admin_test_probes_exactly_the_named_model(self, probe, api_gateway_event, lambda_context):
        probe.return_value = {'model_id': self.OPUS55, 'status': 'available', 'ok': True}

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='POST', path='/settings/model/test', body={'model_id': self.OPUS55},
        )

        assert (response['statusCode'], body['status']) == (200, 'available')
        probe.assert_called_once_with(self.OPUS55)

    @pytest.mark.parametrize('body', [{'model_id': 'anthropic.evil-model-v9'}, {'model_id': None}, {}])
    @patch('settings_handler.model_capacity.probe_model')
    def test_unknown_or_missing_model_is_400(self, probe, body, api_gateway_event, lambda_context):
        response, _ = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='POST', path='/settings/model/test', body=body,
        )

        assert response['statusCode'] == 400
        probe.assert_not_called()

    @patch('settings_handler.model_capacity.probe_model')
    def test_non_admin_test_is_403(self, probe, api_gateway_event, lambda_context):
        event = self._as_user(api_gateway_event(
            method='POST', path='/settings/model/test', body={'model_id': self.OPUS55}))

        assert lambda_handler(event, lambda_context)['statusCode'] == 403
        probe.assert_not_called()

    @patch('settings_handler.model_capacity.capacity_overview')
    def test_admin_capacity_returns_the_overview(self, overview, api_gateway_event, lambda_context):
        overview.return_value = [{'model_id': self.OPUS55, 'label': 'Claude Opus 5.5', 'quota': None}]

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/settings/model/capacity',
        )

        assert response['statusCode'] == 200
        assert body == {'models': [{'model_id': self.OPUS55, 'label': 'Claude Opus 5.5', 'quota': None}]}

    @patch('settings_handler.model_capacity.capacity_overview')
    def test_non_admin_capacity_is_403(self, overview, api_gateway_event, lambda_context):
        event = self._as_user(api_gateway_event(method='GET', path='/settings/model/capacity'))

        assert lambda_handler(event, lambda_context)['statusCode'] == 403
        overview.assert_not_called()
