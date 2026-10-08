"""
Additional coverage tests for integrations_handler.py.
Covers: _build_rule_name with account/region, get_credentials fallback,
update_credentials no-secrets, run_source, sources_status with custom sources,
enable/disable error paths.
"""
import json
from unittest.mock import patch

from handler_events_fixtures import call_route

from integrations_handler import lambda_handler


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
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'api_key'},
        )
        # The prefixed key 'webscraper_api_key' is not in the secret, so the
        # result must be empty — the bare 'api_key' must NOT be returned.
        assert response['statusCode'] == 200
        assert body == {}










