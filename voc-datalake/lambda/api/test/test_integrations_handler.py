"""
Tests for integrations_handler.py - /integrations/*, /sources/* endpoints.
Manages API credentials and data source schedules.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestGetIntegrationStatus:
    """Tests for GET /integrations/status endpoint."""

    @patch('integrations_handler.secretsmanager')
    def test_returns_integration_status_for_all_sources(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns configuration status for all integrations."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'webscraper_api_key': 'key123',
            })
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from integrations_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/integrations/status')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'webscraper' in body
        assert body['webscraper']['configured'] is True

    @patch('integrations_handler.secretsmanager')
    def test_returns_unconfigured_when_no_credentials(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns unconfigured status when no credentials set."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/integrations/status')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['webscraper']['configured'] is False

    @patch('integrations_handler.secretsmanager')
    def test_returns_error_when_secrets_unavailable(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns error when Secrets Manager fails."""
        # Arrange
        mock_secrets.get_secret_value.side_effect = Exception('Access denied')
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/integrations/status')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'error' in body


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
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={
                'webscraper_api_key': 'new_key',
            }
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
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
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'webscraper_configs': '[]'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert
        assert mock_secrets.put_secret_value.called
        call_args = mock_secrets.put_secret_value.call_args
        saved_secrets = json.loads(call_args[1]['SecretString'])
        assert saved_secrets['webscraper_api_key'] == 'existing_key'
        assert saved_secrets['webscraper_configs'] == '[]'

    @patch('integrations_handler.secretsmanager')
    def test_returns_error_when_update_fails(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns error when Secrets Manager update fails."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        mock_secrets.put_secret_value.side_effect = Exception('Update failed')
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'webscraper_api_key': 'key'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False


class TestTestIntegration:
    """Tests for POST /integrations/<source>/test endpoint."""

    def test_returns_not_implemented_message(
        self, api_gateway_event, lambda_context
    ):
        """Returns not implemented message for test endpoint."""
        # Arrange
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/integrations/webscraper/test',
            path_params={'source': 'webscraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert 'not implemented' in body['message'].lower()


class TestGetSourcesStatus:
    """Tests for GET /sources/status endpoint."""

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
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/sources/status')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
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
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/sources/status')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
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
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/sources/webscraper/enable',
            path_params={'source': 'webscraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['enabled'] is True
        mock_events.enable_rule.assert_called_once_with(Name='voc-ingest-webscraper-schedule')

    @patch('integrations_handler.events_client')
    def test_returns_error_when_enable_fails(
        self, mock_events, api_gateway_event, lambda_context
    ):
        """Returns error when EventBridge enable fails."""
        # Arrange
        mock_events.enable_rule.side_effect = Exception('Rule not found')
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/sources/webscraper/enable',
            path_params={'source': 'webscraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False


class TestDisableSource:
    """Tests for PUT /sources/<source>/disable endpoint."""

    @patch('integrations_handler.events_client')
    def test_disables_source_successfully(
        self, mock_events, api_gateway_event, lambda_context
    ):
        """Disables EventBridge rule for data source."""
        # Arrange
        mock_events.disable_rule.return_value = {}
        
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/sources/webscraper/disable',
            path_params={'source': 'webscraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['enabled'] is False
        mock_events.disable_rule.assert_called_once_with(Name='voc-ingest-webscraper-schedule')
