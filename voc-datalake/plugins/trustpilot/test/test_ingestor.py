"""Tests for Trustpilot ingestor handler."""
import os
import json
import pytest
import importlib
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta


# Force reload of base_ingestor with correct SOURCE_PLATFORM
# This is needed because the module caches SOURCE_PLATFORM at import time
@pytest.fixture(autouse=True)
def reload_base_ingestor_with_trustpilot():
    """Reload base_ingestor module with SOURCE_PLATFORM=trustpilot before each test."""
    original_platform = os.environ.get('SOURCE_PLATFORM')
    os.environ['SOURCE_PLATFORM'] = 'trustpilot'
    
    # Reload the module to pick up the new SOURCE_PLATFORM
    import _shared.base_ingestor as base_ingestor_module
    importlib.reload(base_ingestor_module)
    
    # Also need to reload the handler module since it imports from base_ingestor
    if 'trustpilot.ingestor.handler' in importlib.sys.modules:
        del importlib.sys.modules['trustpilot.ingestor.handler']
    
    yield
    
    # Restore original value
    if original_platform is not None:
        os.environ['SOURCE_PLATFORM'] = original_platform
    elif 'SOURCE_PLATFORM' in os.environ:
        del os.environ['SOURCE_PLATFORM']


class TestTrustpilotIngestorInit:
    """Tests for TrustpilotIngestor initialization."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_loads_api_credentials_from_secrets(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo, mock_trustpilot_secrets
    ):
        """Loads API key, secret, and business unit ID from Secrets Manager."""
        mock_get_secret.return_value = mock_trustpilot_secrets
        mock_dynamo.return_value.Table.return_value = MagicMock()
        
        from trustpilot.ingestor.handler import TrustpilotIngestor
        
        ingestor = TrustpilotIngestor()
        
        assert ingestor.source_platform == 'trustpilot'
        assert ingestor.api_key == 'tp-api-key-123'
        assert ingestor.api_secret == 'tp-api-secret-456'
        assert ingestor.business_unit_id == 'tp-buid-789'


class TestTrustpilotIngestorGetAccessToken:
    """Tests for _get_access_token() method."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('trustpilot.ingestor.handler.fetch_with_retry')
    def test_fetches_oauth_token_from_trustpilot(
        self, mock_fetch, mock_get_secret, mock_sqs, mock_s3, mock_dynamo, mock_trustpilot_secrets
    ):
        """Requests OAuth access token from Trustpilot API."""
        mock_get_secret.return_value = mock_trustpilot_secrets
        mock_dynamo.return_value.Table.return_value = MagicMock()
        
        mock_response = MagicMock()
        mock_response.json.return_value = {'access_token': 'oauth-token-xyz'}
        mock_fetch.return_value = mock_response
        
        from trustpilot.ingestor.handler import TrustpilotIngestor
        
        ingestor = TrustpilotIngestor()
        token = ingestor._get_access_token()
        
        assert token == 'oauth-token-xyz'
        mock_fetch.assert_called_once()
        # Check the URL contains 'oauth'
        call_args = mock_fetch.call_args
        url = call_args[1].get('url') if call_args[1] else call_args[0][0] if call_args[0] else ''
        assert 'oauth' in url

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('trustpilot.ingestor.handler.fetch_with_retry')
    def test_caches_access_token(
        self, mock_fetch, mock_get_secret, mock_sqs, mock_s3, mock_dynamo, mock_trustpilot_secrets
    ):
        """Reuses cached token on subsequent calls."""
        mock_get_secret.return_value = mock_trustpilot_secrets
        mock_dynamo.return_value.Table.return_value = MagicMock()
        
        mock_response = MagicMock()
        mock_response.json.return_value = {'access_token': 'cached-token'}
        mock_fetch.return_value = mock_response
        
        from trustpilot.ingestor.handler import TrustpilotIngestor
        
        ingestor = TrustpilotIngestor()
        
        token1 = ingestor._get_access_token()
        token2 = ingestor._get_access_token()
        
        assert token1 == token2
        assert mock_fetch.call_count == 1  # Only called once


class TestTrustpilotIngestorFetchNewItems:
    """Tests for fetch_new_items() method."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('trustpilot.ingestor.handler.fetch_with_retry')
    def test_fetches_reviews_from_api(
        self, mock_fetch, mock_get_secret, mock_sqs, mock_s3, mock_dynamo,
        mock_trustpilot_secrets, mock_trustpilot_api_response
    ):
        """Fetches reviews from Trustpilot Business API."""
        mock_get_secret.return_value = mock_trustpilot_secrets
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No watermark
        mock_dynamo.return_value.Table.return_value = mock_table
        
        # First call for OAuth, second for reviews
        mock_oauth_response = MagicMock()
        mock_oauth_response.json.return_value = {'access_token': 'token'}
        mock_oauth_response.raise_for_status = MagicMock()
        
        mock_reviews_response = MagicMock()
        mock_reviews_response.json.return_value = mock_trustpilot_api_response
        mock_reviews_response.raise_for_status = MagicMock()
        
        mock_fetch.side_effect = [mock_oauth_response, mock_reviews_response]
        
        from trustpilot.ingestor.handler import TrustpilotIngestor
        
        ingestor = TrustpilotIngestor()
        items = list(ingestor.fetch_new_items())
        
        assert len(items) == 1
        assert items[0]['id'] == 'review-abc123'
        assert items[0]['rating'] == 5
        assert items[0]['text'] == 'Really happy with the product and customer service!'

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_yields_nothing_when_no_business_unit_id(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Returns empty when business_unit_id not configured."""
        mock_get_secret.return_value = {
            'trustpilot_api_key': 'key',
            'trustpilot_api_secret': 'secret',
            # No business_unit_id
        }
        mock_dynamo.return_value.Table.return_value = MagicMock()
        
        from trustpilot.ingestor.handler import TrustpilotIngestor
        
        ingestor = TrustpilotIngestor()
        items = list(ingestor.fetch_new_items())
        
        assert items == []

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_yields_nothing_when_no_api_credentials(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Returns empty when API credentials not configured."""
        mock_get_secret.return_value = {
            'trustpilot_business_unit_id': 'buid',
            # No api_key or api_secret
        }
        mock_dynamo.return_value.Table.return_value = MagicMock()
        
        from trustpilot.ingestor.handler import TrustpilotIngestor
        
        ingestor = TrustpilotIngestor()
        items = list(ingestor.fetch_new_items())
        
        assert items == []

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('trustpilot.ingestor.handler.fetch_with_retry')
    def test_respects_watermark_timestamp(
        self, mock_fetch, mock_get_secret, mock_sqs, mock_s3, mock_dynamo, mock_trustpilot_secrets
    ):
        """Stops fetching when reaching watermark timestamp."""
        mock_get_secret.return_value = mock_trustpilot_secrets
        mock_table = MagicMock()
        # Watermark is after the review's created_at
        mock_table.get_item.return_value = {
            'Item': {'value': '2025-01-20T00:00:00Z'}
        }
        mock_dynamo.return_value.Table.return_value = mock_table
        
        mock_oauth_response = MagicMock()
        mock_oauth_response.json.return_value = {'access_token': 'token'}
        
        mock_reviews_response = MagicMock()
        mock_reviews_response.json.return_value = {
            'reviews': [{
                'id': 'old-review',
                'createdAt': '2025-01-15T00:00:00Z',  # Before watermark
                'stars': 3,
                'text': 'Old review',
                'consumer': {'displayName': 'User'},
                'links': [],
            }]
        }
        
        mock_fetch.side_effect = [mock_oauth_response, mock_reviews_response]
        
        from trustpilot.ingestor.handler import TrustpilotIngestor
        
        ingestor = TrustpilotIngestor()
        items = list(ingestor.fetch_new_items())
        
        # Should not yield the old review
        assert items == []


class TestTrustpilotLambdaHandler:
    """Tests for lambda_handler entry point."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.emit_audit_event')
    @patch('trustpilot.ingestor.handler.fetch_with_retry')
    def test_handler_returns_success_result(
        self, mock_fetch, mock_audit, mock_get_secret, mock_sqs, mock_s3, mock_dynamo,
        mock_trustpilot_secrets, mock_trustpilot_api_response, lambda_context
    ):
        """Lambda handler returns success with items processed count."""
        mock_get_secret.return_value = mock_trustpilot_secrets
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_dynamo.return_value.Table.return_value = mock_table
        mock_sqs.return_value = MagicMock()
        
        mock_oauth_response = MagicMock()
        mock_oauth_response.json.return_value = {'access_token': 'token'}
        
        mock_reviews_response = MagicMock()
        mock_reviews_response.json.return_value = mock_trustpilot_api_response
        
        mock_fetch.side_effect = [mock_oauth_response, mock_reviews_response]
        
        from trustpilot.ingestor.handler import lambda_handler
        
        result = lambda_handler({}, lambda_context)
        
        assert result['status'] == 'success'
        assert result['items_processed'] >= 0
