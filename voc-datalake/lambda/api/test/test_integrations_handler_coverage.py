"""
Additional coverage tests for integrations_handler.py.
Covers: _build_rule_name with account/region, get_credentials fallback,
update_credentials no-secrets, run_source, sources_status with custom sources,
enable/disable error paths.
"""
import json
from unittest.mock import MagicMock, patch


class TestBuildRuleName:
    """Cover _build_rule_name with and without account/region."""

    def test_builds_rule_name_with_account_and_region(self):
        from integrations_handler import _build_rule_name
        with patch('integrations_handler.AWS_ACCOUNT_ID', '123456789012'), \
             patch('integrations_handler.AWS_REGION', 'us-east-1'):
            name = _build_rule_name('webscraper')
            assert name == 'voc-ingest-webscraper-schedule-123456789012-us-east-1'

    def test_builds_rule_name_without_account(self):
        from integrations_handler import _build_rule_name
        with patch('integrations_handler.AWS_ACCOUNT_ID', ''), \
             patch('integrations_handler.AWS_REGION', ''):
            name = _build_rule_name('webscraper')
            assert name == 'voc-ingest-webscraper-schedule'


class TestGetCredentialsNoFallback:
    """Verify that the unprefixed fallback has been removed from get_credentials.

    The fallback was removed in issue #261: a key stored at the top level
    (without a source prefix) must NOT be returned when a caller requests it
    through a specific source's credentials endpoint.
    """

    @patch('integrations_handler.secretsmanager')
    def test_does_not_fall_back_to_unprefixed_key(self, mock_secrets, api_gateway_event, lambda_context):
        """An unprefixed key in the secret is NOT returned for a source request.

        Regression guard: reverting the fallback removal would make this test
        return {'api_key': 'fallback-value'} instead of {}.
        """
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'api_key': 'fallback-value',  # unprefixed — belongs to another feature
            })
        }
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'api_key'},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        # The prefixed key 'webscraper_api_key' is not in the secret, so the
        # result must be empty — the bare 'api_key' must NOT be returned.
        assert response['statusCode'] == 200
        assert body == {}


class TestUpdateCredentialsEdgeCases:
    """Cover update_credentials error paths."""

    @patch('integrations_handler.SECRETS_ARN', '')
    def test_raises_config_error_when_no_secrets_arn(self, api_gateway_event, lambda_context):
        from integrations_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'key': 'value'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestRunSource:
    """Cover POST /sources/<source>/run endpoint."""

    @patch('integrations_handler.boto3')
    def test_triggers_source_successfully(self, mock_boto3, api_gateway_event, lambda_context):
        mock_lambda = MagicMock()
        mock_lambda.invoke.return_value = {'StatusCode': 202}
        mock_lambda.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        mock_boto3.client.return_value = mock_lambda
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/sources/webscraper/run', path_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['success'] is True

    @patch('integrations_handler.boto3')
    def test_returns_error_on_non_202_status(self, mock_boto3, api_gateway_event, lambda_context):
        mock_lambda = MagicMock()
        mock_lambda.invoke.return_value = {'StatusCode': 500}
        mock_lambda.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        mock_boto3.client.return_value = mock_lambda
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/sources/webscraper/run', path_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('integrations_handler.boto3')
    def test_returns_error_when_lambda_not_found(self, mock_boto3, api_gateway_event, lambda_context):
        mock_lambda = MagicMock()
        ResourceNotFound = type('ResourceNotFoundException', (Exception,), {})
        mock_lambda.exceptions.ResourceNotFoundException = ResourceNotFound
        mock_lambda.invoke.side_effect = ResourceNotFound()
        mock_boto3.client.return_value = mock_lambda
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/sources/webscraper/run', path_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('integrations_handler.boto3')
    def test_returns_error_on_generic_failure(self, mock_boto3, api_gateway_event, lambda_context):
        mock_lambda = MagicMock()
        mock_lambda.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        mock_lambda.invoke.side_effect = Exception('Network error')
        mock_boto3.client.return_value = mock_lambda
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/sources/webscraper/run', path_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetSourcesStatusEdgeCases:
    """Cover sources_status with custom sources param and error paths."""

    @patch('integrations_handler.events_client')
    def test_uses_custom_sources_param(self, mock_events, api_gateway_event, lambda_context):
        mock_events.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        mock_events.describe_rule.return_value = {'State': 'ENABLED', 'ScheduleExpression': 'rate(5 minutes)'}
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/sources/status', query_params={'sources': 'custom_source'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert 'custom_source' in body['sources']

    @patch('integrations_handler.events_client')
    def test_handles_generic_describe_rule_error(self, mock_events, api_gateway_event, lambda_context):
        """Cover the generic Exception branch in get_sources_status."""
        mock_events.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        mock_events.describe_rule.side_effect = Exception('Unexpected error')
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/sources/status', query_params={'sources': 'broken'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['sources']['broken']['enabled'] is False
        assert 'error' in body['sources']['broken']


class TestDisableSourceEdgeCases:
    """Cover disable_source error path."""

    @patch('integrations_handler.events_client')
    def test_returns_error_when_disable_fails(self, mock_events, api_gateway_event, lambda_context):
        mock_events.disable_rule.side_effect = Exception('Rule not found')
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/sources/webscraper/disable', path_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetIntegrationStatusNoSecrets:
    """Cover SECRETS_ARN empty path for get_integration_status."""

    @patch('integrations_handler.SECRETS_ARN', '')
    def test_raises_config_error_when_no_secrets_arn(self, api_gateway_event, lambda_context):
        from integrations_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/integrations/status')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
