"""
Tests for integrations_handler.py - /integrations/*, /sources/* endpoints.
Manages API credentials and data source schedules.
"""
import json
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

from integrations_handler import lambda_handler


class TestGetIntegrationStatus:
    """Tests for GET /integrations/status endpoint."""

    @patch('integrations_handler.secretsmanager')
    @pytest.mark.usefixtures("plugin_secret_defaults")
    def test_returns_integration_status_for_all_sources(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns configuration status for all integrations.

        The stored value is `webscraper_configs`, the key the webscraper manifest
        declares and CDK actually seeds, set here to something a human would have
        entered. This test previously used `webscraper_api_key` — a key no
        manifest declares and nothing writes — so it asserted a status the
        deployed system could never report.
        """
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'webscraper_configs': '[{"id": "s1", "url": "https://example.test"}]',
            })
        }

        import os
        import sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/integrations/status',
        )

        # Assert
        assert response['statusCode'] == 200
        assert 'webscraper' in body
        assert body['webscraper']['configured'] is True

    @patch('integrations_handler.secretsmanager')
    @pytest.mark.usefixtures("plugin_secret_defaults")
    def test_returns_unconfigured_when_no_credentials(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns unconfigured status when no credentials set."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/integrations/status',
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['webscraper']['configured'] is False



class TestGetCredentials:
    """Tests for GET /integrations/<source>/credentials endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_returns_matching_credentials(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns only key-value pairs matching the requested keys."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_android_app_name': 'my-app',
                'app_reviews_android_package_name': 'com.example.app',
                'unrelated_key': 'should-not-appear',
            })
        }

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET',
            path='/integrations/app_reviews_android/credentials',
            path_params={'source': 'app_reviews_android'},
            query_params={'keys': 'app_name,package_name'},
        )

        # Assert
        assert response['statusCode'] == 200
        assert body == {'app_name': 'my-app', 'package_name': 'com.example.app'}

    @patch('integrations_handler.secretsmanager')
    def test_returns_empty_object_when_no_saved_credentials(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns empty object when source has no saved credentials."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET',
            path='/integrations/app_reviews_ios/credentials',
            path_params={'source': 'app_reviews_ios'},
            query_params={'keys': 'app_id,app_name'},
        )

        # Assert
        assert response['statusCode'] == 200
        assert body == {}





class TestUpdateCredentials:
    """Tests for PUT /integrations/<source>/credentials endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_updates_credentials_successfully(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Updates integration credentials in Secrets Manager."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'existing_key': 'existing_value'})
        }
        mock_secrets.put_secret_value.return_value = {}

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={
                'webscraper_api_key': 'new_key',
            },
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_secrets.put_secret_value.assert_called_once()

    @patch('integrations_handler.secretsmanager')
    def test_preserves_existing_credentials(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Preserves existing credentials when updating."""
        # Arrange
        existing_secrets = {'webscraper_api_key': 'existing_key'}
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps(existing_secrets)
        }
        mock_secrets.put_secret_value.return_value = {}

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'webscraper_configs': '[]'}
        )

        # Act
        lambda_handler(event, lambda_context)

        # Assert
        assert mock_secrets.put_secret_value.called
        call_args = mock_secrets.put_secret_value.call_args
        saved_secrets = json.loads(call_args[1]['SecretString'])
        assert saved_secrets['webscraper_api_key'] == 'existing_key'
        assert saved_secrets['webscraper_webscraper_configs'] == '[]'



class TestGetSourcesStatus:
    """Tests for GET /sources/status endpoint."""

    @pytest.fixture(autouse=True)
    def _enabled_sources(self, monkeypatch):
        """The ENABLED_SOURCES CDK renders from `pluginStatus` (issue #256)."""
        monkeypatch.setenv('ENABLED_SOURCES', json.dumps(['webscraper', 'app_reviews_ios', 'synthetic_reviews']))

    @patch('integrations_handler.events_client')
    def test_the_default_list_is_the_enabled_plugins_plus_manual_import(
        self, mock_events, api_gateway_event, lambda_context
    ):
        """Issue #256: every enabled plugin is reported, none hardcoded."""
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.side_effect = mock_events.exceptions.ResourceNotFoundException()

        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/sources/status',
        )

        assert list(body['sources']) == ['webscraper', 'app_reviews_ios', 'synthetic_reviews', 'manual_import']

    @patch('integrations_handler.events_client')
    def test_returns_status_for_all_sources(
        self, mock_events, api_gateway_event, lambda_context
    ):
        """Returns schedule status for all data sources."""
        # Arrange
        def describe_rule_side_effect(Name):
            if 'webscraper' in Name:
                return {'State': 'ENABLED', 'ScheduleExpression': 'rate(1 hour)'}
            raise mock_events.exceptions.ResourceNotFoundException({}, 'describe_rule')

        mock_events.describe_rule.side_effect = describe_rule_side_effect
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/sources/status',
        )

        # Assert
        assert response['statusCode'] == 200
        assert 'sources' in body
        assert body['sources']['webscraper']['enabled'] is True

    @patch('integrations_handler.events_client')
    def test_handles_missing_rules_gracefully(
        self, mock_events, api_gateway_event, lambda_context
    ):
        """Returns exists=False for non-existent rules."""
        # Arrange
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.side_effect = mock_events.exceptions.ResourceNotFoundException()

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/sources/status',
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['sources']['webscraper']['exists'] is False


class TestEnableSource:
    """Tests for PUT /sources/<source>/enable endpoint."""

    @patch('integrations_handler.events_client')
    def test_enables_source_successfully(
        self, mock_events, api_gateway_event, lambda_context
    ):
        """Enables EventBridge rule for data source."""
        # Arrange
        mock_events.enable_rule.return_value = {}

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='PUT',
            path='/sources/webscraper/enable',
            path_params={'source': 'webscraper'},
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['enabled'] is True
        mock_events.enable_rule.assert_called_once_with(Name='voc-ingest-webscraper-schedule')



class TestDisableSource:
    """Tests for PUT /sources/<source>/disable endpoint."""

    @patch('integrations_handler.events_client')
    def test_disables_source_successfully(
        self, mock_events, api_gateway_event, lambda_context
    ):
        """Disables EventBridge rule for data source."""
        # Arrange
        mock_events.disable_rule.return_value = {}

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='PUT',
            path='/sources/webscraper/disable',
            path_params={'source': 'webscraper'},
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['enabled'] is False
        mock_events.disable_rule.assert_called_once_with(Name='voc-ingest-webscraper-schedule')




class TestSourcesStatusDescribesRulesInParallel:
    """GET /sources/status describes its rules concurrently (E2E F10).

    The loop was serial: the response waited for each DescribeRule in turn. The
    barrier below only releases when all three calls are in flight at once, so a
    serial loop times out on the first call and reports an error entry for every
    source instead of its schedule.
    """

    SOURCES = ('webscraper', 'app_reviews_ios', 'synthetic_reviews')

    @patch('integrations_handler.events_client')
    def test_all_rules_are_in_flight_together(self, mock_events, api_gateway_event, lambda_context):
        import threading
        barrier = threading.Barrier(len(self.SOURCES), timeout=5)
        mock_events.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})

        def describe_rule(**_kwargs):
            barrier.wait()
            return {'State': 'ENABLED', 'ScheduleExpression': 'rate(30 minutes)'}

        mock_events.describe_rule.side_effect = describe_rule

        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/sources/status',
            query_params={'sources': ','.join(self.SOURCES)},
        )

        assert list(body['sources']) == list(self.SOURCES)
        assert all(entry == {
            'enabled': True, 'schedule': 'rate(30 minutes)', 'exists': True,
            'rule_name': entry['rule_name'],
        } for entry in body['sources'].values())

    @patch('integrations_handler.events_client')
    def test_order_and_per_source_outcomes_are_unchanged(self, mock_events, api_gateway_event, lambda_context):
        not_found = type('ResourceNotFoundException', (Exception,), {})
        mock_events.exceptions.ResourceNotFoundException = not_found

        def describe_rule(Name):
            if 'webscraper' in Name:
                return {'State': 'DISABLED', 'ScheduleExpression': 'rate(1 hour)'}
            if 'synthetic' in Name:
                raise RuntimeError('throttled')
            raise not_found()

        mock_events.describe_rule.side_effect = describe_rule

        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/sources/status',
            query_params={'sources': 'synthetic_reviews,manual_import,webscraper,app_reviews_ios'},
        )

        assert list(body['sources']) == ['synthetic_reviews', 'manual_import', 'webscraper', 'app_reviews_ios']
        assert body['sources']['synthetic_reviews'] == {'enabled': False, 'error': 'Failed to retrieve status'}
        assert body['sources']['manual_import'] == {'enabled': False, 'exists': False}
        assert body['sources']['webscraper']['enabled'] is False
        assert body['sources']['webscraper']['exists'] is True
        assert body['sources']['app_reviews_ios'] == {'enabled': False, 'exists': False}
