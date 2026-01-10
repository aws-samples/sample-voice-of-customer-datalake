"""
Tests for scrapers_handler.py - /scrapers/* endpoints.
Manages web scraper configurations and runs.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestValidateUrl:
    """Tests for validate_url SSRF protection function."""

    def test_rejects_empty_url(self):
        """Rejects empty or None URL."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from scrapers_handler import validate_url
        
        is_valid, error = validate_url('')
        assert is_valid is False
        assert 'required' in error.lower()
        
        is_valid, error = validate_url(None)
        assert is_valid is False

    def test_rejects_non_http_schemes(self):
        """Rejects non-HTTP/HTTPS schemes."""
        from scrapers_handler import validate_url
        
        is_valid, error = validate_url('ftp://example.com')
        assert is_valid is False
        assert 'http' in error.lower()
        
        is_valid, error = validate_url('file:///etc/passwd')
        assert is_valid is False

    def test_rejects_localhost(self):
        """Rejects localhost URLs for SSRF protection."""
        from scrapers_handler import validate_url
        
        is_valid, error = validate_url('http://localhost/admin')
        assert is_valid is False
        assert 'localhost' in error.lower()
        
        is_valid, error = validate_url('http://localhost.localdomain/test')
        assert is_valid is False

    @patch('scrapers_handler.socket.getaddrinfo')
    def test_rejects_private_ip_addresses(self, mock_getaddrinfo):
        """Rejects URLs resolving to private IP ranges."""
        from scrapers_handler import validate_url
        
        # Mock DNS resolution to return private IP
        mock_getaddrinfo.return_value = [
            (2, 1, 6, '', ('192.168.1.1', 80))
        ]
        
        is_valid, error = validate_url('http://internal-server.com')
        assert is_valid is False
        assert 'internal' in error.lower() or 'private' in error.lower()

    @patch('scrapers_handler.socket.getaddrinfo')
    def test_rejects_aws_metadata_ip(self, mock_getaddrinfo):
        """Rejects URLs resolving to AWS metadata IP (169.254.x.x)."""
        from scrapers_handler import validate_url
        
        mock_getaddrinfo.return_value = [
            (2, 1, 6, '', ('169.254.169.254', 80))
        ]
        
        is_valid, error = validate_url('http://metadata.internal')
        assert is_valid is False

    @patch('scrapers_handler.socket.getaddrinfo')
    def test_accepts_valid_public_url(self, mock_getaddrinfo):
        """Accepts valid public URLs."""
        from scrapers_handler import validate_url
        
        mock_getaddrinfo.return_value = [
            (2, 1, 6, '', ('93.184.216.34', 80))  # example.com IP
        ]
        
        is_valid, error = validate_url('https://example.com/reviews')
        assert is_valid is True
        assert error == ''


class TestListScrapers:
    """Tests for GET /scrapers endpoint."""

    @patch('scrapers_handler.secretsmanager')
    def test_returns_scraper_configurations(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns list of scraper configurations from Secrets Manager."""
        # Arrange
        scrapers = [
            {'id': 'scraper-1', 'name': 'Test Scraper', 'url': 'https://example.com'},
            {'id': 'scraper-2', 'name': 'Another Scraper', 'url': 'https://test.com'}
        ]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(scrapers)})
        }
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['scrapers']) == 2
        assert body['scrapers'][0]['id'] == 'scraper-1'

    @patch('scrapers_handler.secretsmanager')
    def test_returns_empty_list_when_no_scrapers(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns empty array when no scrapers configured."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['scrapers'] == []


class TestSaveScraper:
    """Tests for POST /scrapers endpoint."""

    @patch('scrapers_handler.secretsmanager')
    def test_saves_new_scraper_configuration(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Saves new scraper configuration to Secrets Manager."""
        # Arrange
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': '[]'})
        }
        mock_secrets.put_secret_value.return_value = {}
        
        new_scraper = {
            'id': 'new-scraper',
            'name': 'New Scraper',
            'url': 'https://newsite.com',
            'extraction_method': 'css'
        }
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers',
            body={'scraper': new_scraper}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['scraper']['id'] == 'new-scraper'

    @patch('scrapers_handler.secretsmanager')
    def test_updates_existing_scraper(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Updates existing scraper configuration."""
        # Arrange
        existing_scrapers = [{'id': 'existing', 'name': 'Old Name', 'url': 'https://old.com'}]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(existing_scrapers)})
        }
        mock_secrets.put_secret_value.return_value = {}
        
        updated_scraper = {'id': 'existing', 'name': 'New Name', 'url': 'https://new.com'}
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers',
            body={'scraper': updated_scraper}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['scraper']['name'] == 'New Name'

    @patch('scrapers_handler.secretsmanager')
    def test_returns_error_when_no_scraper_provided(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Returns error when scraper config not provided."""
        # Arrange
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/scrapers', body={'scraper': None})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False


class TestDeleteScraper:
    """Tests for DELETE /scrapers/<scraper_id> endpoint."""

    @patch('scrapers_handler.secretsmanager')
    def test_deletes_scraper_successfully(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Deletes scraper configuration from Secrets Manager."""
        # Arrange
        existing_scrapers = [
            {'id': 'keep-this', 'name': 'Keep'},
            {'id': 'delete-this', 'name': 'Delete'}
        ]
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_configs': json.dumps(existing_scrapers)})
        }
        mock_secrets.put_secret_value.return_value = {}
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/scrapers/delete-this',
            path_params={'scraper_id': 'delete-this'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        
        # Verify only one scraper remains
        assert mock_secrets.put_secret_value.called
        call_args = mock_secrets.put_secret_value.call_args
        saved_secrets = json.loads(call_args[1]['SecretString'])
        saved_scrapers = json.loads(saved_secrets['webscraper_configs'])
        assert len(saved_scrapers) == 1
        assert saved_scrapers[0]['id'] == 'keep-this'


class TestGetTemplates:
    """Tests for GET /scrapers/templates endpoint."""

    def test_returns_available_templates(
        self, api_gateway_event, lambda_context
    ):
        """Returns list of scraper templates."""
        # Arrange
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers/templates')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'templates' in body
        assert len(body['templates']) >= 2
        
        template_ids = [t['id'] for t in body['templates']]
        assert 'review_jsonld' in template_ids
        assert 'custom_css' in template_ids


class TestRunScraper:
    """Tests for POST /scrapers/<scraper_id>/run endpoint."""

    @patch('scrapers_handler.require_webscraper_function')
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler.get_aggregates_table')
    def test_triggers_scraper_run_successfully(
        self, mock_get_table, mock_lambda, mock_require_fn, api_gateway_event, lambda_context
    ):
        """Triggers async scraper Lambda invocation."""
        # Arrange
        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_get_table.return_value = mock_table
        mock_lambda.invoke.return_value = {}
        mock_require_fn.return_value = 'test-webscraper-function'
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/test-scraper/run',
            path_params={'scraper_id': 'test-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['status'] == 'running'
        assert 'execution_id' in body
        mock_lambda.invoke.assert_called_once()

    @patch('scrapers_handler.require_webscraper_function')
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler.get_aggregates_table')
    def test_stores_run_status_in_dynamodb(
        self, mock_get_table, mock_lambda, mock_require_fn, api_gateway_event, lambda_context
    ):
        """Stores scraper run status in DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_get_table.return_value = mock_table
        mock_lambda.invoke.return_value = {}
        mock_require_fn.return_value = 'test-webscraper-function'
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/my-scraper/run',
            path_params={'scraper_id': 'my-scraper'}
        )
        
        # Act
        lambda_handler(event, lambda_context)
        
        # Assert
        mock_table.put_item.assert_called_once()
        call_args = mock_table.put_item.call_args
        item = call_args.kwargs['Item']
        assert item['pk'] == 'SCRAPER_RUN#my-scraper'
        assert item['status'] == 'running'


class TestGetScraperStatus:
    """Tests for GET /scrapers/<scraper_id>/status endpoint."""

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_latest_run_status(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Returns latest scraper run status from DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [{
                'pk': 'SCRAPER_RUN#test-scraper',
                'sk': 'run_test-scraper_20250101120000',
                'status': 'completed',
                'started_at': '2025-01-01T12:00:00Z',
                'completed_at': '2025-01-01T12:05:00Z',
                'pages_scraped': 5,
                'items_found': 25,
                'errors': []
            }]
        }
        mock_get_table.return_value = mock_table
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/scrapers/test-scraper/status',
            path_params={'scraper_id': 'test-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['status'] == 'completed'
        assert body['pages_scraped'] == 5
        assert body['items_found'] == 25

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_never_run_when_no_history(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Returns never_run status when no run history exists."""
        # Arrange
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        mock_get_table.return_value = mock_table
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/scrapers/new-scraper/status',
            path_params={'scraper_id': 'new-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['status'] == 'never_run'


class TestGetScraperRuns:
    """Tests for GET /scrapers/<scraper_id>/runs endpoint."""

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_run_history(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Returns scraper run history from DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {'sk': 'run_1', 'status': 'completed', 'items_found': 10},
                {'sk': 'run_2', 'status': 'completed', 'items_found': 15},
            ]
        }
        mock_get_table.return_value = mock_table
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/scrapers/test-scraper/runs',
            path_params={'scraper_id': 'test-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['runs']) == 2


class TestAnalyzeUrl:
    """Tests for POST /scrapers/analyze-url endpoint."""

    @patch('shared.converse.converse')
    @patch('scrapers_handler.urllib.request.urlopen')
    @patch('scrapers_handler.socket.getaddrinfo')
    def test_analyzes_url_and_returns_selectors(
        self, mock_getaddrinfo, mock_urlopen, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Analyzes URL and returns CSS selectors using Bedrock."""
        # Arrange
        mock_getaddrinfo.return_value = [(2, 1, 6, '', ('93.184.216.34', 80))]
        
        mock_response = MagicMock()
        mock_response.read.return_value = b'<html><div class="review">Test</div></html>'
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response
        
        # Mock the converse function to return JSON with selectors
        mock_converse.return_value = '{"container_selector": ".review", "text_selector": ".review-text", "confidence": "high"}'
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/analyze-url',
            body={'url': 'https://example.com/reviews'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert 'selectors' in body
        assert body['selectors']['container_selector'] == '.review'

    @patch('scrapers_handler.socket.getaddrinfo')
    def test_rejects_invalid_url(
        self, mock_getaddrinfo, api_gateway_event, lambda_context
    ):
        """Rejects invalid or dangerous URLs."""
        # Arrange - localhost should be blocked
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/analyze-url',
            body={'url': 'http://localhost/admin'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
        assert 'localhost' in body['message'].lower()

    @patch('shared.converse.converse')
    @patch('scrapers_handler.urllib.request.urlopen')
    @patch('scrapers_handler.socket.getaddrinfo')
    def test_handles_bedrock_failure_gracefully(
        self, mock_getaddrinfo, mock_urlopen, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Returns error when Bedrock analysis fails."""
        # Arrange
        mock_getaddrinfo.return_value = [(2, 1, 6, '', ('93.184.216.34', 80))]
        
        mock_response = MagicMock()
        mock_response.read.return_value = b'<html></html>'
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response
        
        # Mock converse to raise an exception
        mock_converse.side_effect = Exception('Bedrock error')
        
        from scrapers_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/scrapers/analyze-url',
            body={'url': 'https://example.com'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
