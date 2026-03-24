"""
Additional coverage tests for scrapers_handler.py.
Covers: validate_url edge cases, no-secrets paths, save/delete errors,
run_scraper errors, status/runs errors, analyze-url edge cases.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestValidateUrlEdgeCases:
    """Cover remaining validate_url branches."""

    def test_rejects_non_string_url(self):
        from scrapers_handler import validate_url
        is_valid, error = validate_url(123)
        assert is_valid is False

    def test_rejects_url_without_hostname(self):
        from scrapers_handler import validate_url
        is_valid, error = validate_url('http://')
        assert is_valid is False
        assert 'hostname' in error.lower()

    @patch('scrapers_handler.socket.getaddrinfo')
    def test_rejects_loopback_ipv4(self, mock_getaddrinfo):
        from scrapers_handler import validate_url
        mock_getaddrinfo.return_value = [(2, 1, 6, '', ('127.0.0.1', 80))]
        is_valid, error = validate_url('http://evil.com')
        assert is_valid is False

    @patch('scrapers_handler.socket.getaddrinfo', side_effect=Exception('unexpected'))
    def test_handles_unexpected_dns_error(self, mock_getaddrinfo):
        from scrapers_handler import validate_url
        is_valid, error = validate_url('http://example.com')
        assert is_valid is False
        assert 'validation failed' in error.lower()

    @patch('scrapers_handler.socket.getaddrinfo')
    def test_handles_dns_resolution_failure(self, mock_getaddrinfo):
        import socket
        mock_getaddrinfo.side_effect = socket.gaierror('Name resolution failed')
        from scrapers_handler import validate_url
        is_valid, error = validate_url('http://nonexistent.invalid')
        assert is_valid is False
        assert 'resolve' in error.lower()


class TestListScrapersNoSecrets:
    """Cover SECRETS_ARN empty path."""

    @patch('scrapers_handler.SECRETS_ARN', '')
    def test_returns_empty_when_no_secrets_arn(self, api_gateway_event, lambda_context):
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['scrapers'] == []

    @patch('scrapers_handler.secretsmanager')
    def test_returns_empty_on_exception(self, mock_secrets, api_gateway_event, lambda_context):
        mock_secrets.get_secret_value.side_effect = Exception('Access denied')
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['scrapers'] == []


class TestSaveScraperEdgeCases:
    """Cover save scraper error paths."""

    @patch('scrapers_handler.SECRETS_ARN', '')
    def test_raises_config_error_when_no_secrets(self, api_gateway_event, lambda_context):
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/scrapers', body={'scraper': {'id': 'x'}})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('scrapers_handler.secretsmanager')
    def test_returns_error_when_save_fails(self, mock_secrets, api_gateway_event, lambda_context):
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps({'webscraper_configs': '[]'})}
        mock_secrets.put_secret_value.side_effect = Exception('Write failed')
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/scrapers', body={'scraper': {'id': 'x', 'name': 'Test'}})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestDeleteScraperEdgeCases:
    """Cover delete scraper error paths."""

    @patch('scrapers_handler.SECRETS_ARN', '')
    def test_raises_config_error_when_no_secrets(self, api_gateway_event, lambda_context):
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/scrapers/x', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('scrapers_handler.secretsmanager')
    def test_returns_error_when_delete_fails(self, mock_secrets, api_gateway_event, lambda_context):
        mock_secrets.get_secret_value.side_effect = Exception('Read failed')
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/scrapers/x', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestRunScraperEdgeCases:
    """Cover run_scraper error paths."""

    @patch('scrapers_handler.require_webscraper_function')
    @patch('scrapers_handler.lambda_client')
    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_error_when_lambda_invoke_fails(self, mock_get_table, mock_lambda, mock_require_fn, api_gateway_event, lambda_context):
        mock_get_table.return_value = MagicMock()
        mock_require_fn.return_value = 'test-fn'
        mock_lambda.invoke.side_effect = Exception('Invoke failed')
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/scrapers/x/run', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('scrapers_handler.get_aggregates_table')
    def test_runs_without_aggregates_table(self, mock_get_table, api_gateway_event, lambda_context):
        """Cover table=None path in run_scraper."""
        mock_get_table.return_value = None
        with patch('scrapers_handler.require_webscraper_function', return_value='test-fn'), \
             patch('scrapers_handler.lambda_client') as mock_lambda:
            mock_lambda.invoke.return_value = {}
            from scrapers_handler import lambda_handler
            event = api_gateway_event(method='POST', path='/scrapers/x/run', path_params={'scraper_id': 'x'})
            response = lambda_handler(event, lambda_context)
            body = json.loads(response['body'])
            assert response['statusCode'] == 200
            assert body['success'] is True


class TestGetScraperStatusEdgeCases:
    """Cover scraper status error paths."""

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_unknown_when_no_table(self, mock_get_table, api_gateway_event, lambda_context):
        mock_get_table.return_value = None
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers/x/status', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['status'] == 'unknown'

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_unknown_on_query_error(self, mock_get_table, api_gateway_event, lambda_context):
        mock_table = MagicMock()
        mock_table.query.side_effect = Exception('Query failed')
        mock_get_table.return_value = mock_table
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers/x/status', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['status'] == 'unknown'
        assert 'error' in body


class TestGetScraperRunsEdgeCases:
    """Cover scraper runs error paths."""

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_empty_when_no_table(self, mock_get_table, api_gateway_event, lambda_context):
        mock_get_table.return_value = None
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers/x/runs', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['runs'] == []

    @patch('scrapers_handler.get_aggregates_table')
    def test_returns_empty_on_query_error(self, mock_get_table, api_gateway_event, lambda_context):
        mock_table = MagicMock()
        mock_table.query.side_effect = Exception('Query failed')
        mock_get_table.return_value = mock_table
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/scrapers/x/runs', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['runs'] == []
        assert 'error' in body


class TestAnalyzeUrlEdgeCases:
    """Cover analyze-url edge cases."""

    @patch('shared.converse.converse')
    @patch('scrapers_handler.urllib.request.urlopen')
    @patch('scrapers_handler.socket.getaddrinfo')
    def test_returns_error_when_no_json_in_response(self, mock_getaddrinfo, mock_urlopen, mock_converse, api_gateway_event, lambda_context):
        mock_getaddrinfo.return_value = [(2, 1, 6, '', ('93.184.216.34', 80))]
        mock_response = MagicMock()
        mock_response.read.return_value = b'<html></html>'
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response
        mock_converse.return_value = 'No JSON here at all'
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/scrapers/analyze-url', body={'url': 'https://example.com'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('scrapers_handler.urllib.request.urlopen')
    @patch('scrapers_handler.socket.getaddrinfo')
    def test_returns_error_when_fetch_fails(self, mock_getaddrinfo, mock_urlopen, api_gateway_event, lambda_context):
        mock_getaddrinfo.return_value = [(2, 1, 6, '', ('93.184.216.34', 80))]
        mock_urlopen.side_effect = Exception('Connection refused')
        from scrapers_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/scrapers/analyze-url', body={'url': 'https://example.com'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestRequireWebscraperFunction:
    """Cover require_webscraper_function."""

    def test_raises_when_not_configured(self):
        from scrapers_handler import require_webscraper_function
        with patch('scrapers_handler.WEBSCRAPER_FUNCTION_NAME', ''):
            with pytest.raises(ValueError, match='WEBSCRAPER_FUNCTION_NAME'):
                require_webscraper_function()

    def test_returns_function_name_when_configured(self):
        from scrapers_handler import require_webscraper_function
        with patch('scrapers_handler.WEBSCRAPER_FUNCTION_NAME', 'my-function'):
            assert require_webscraper_function() == 'my-function'


class TestValidateUrlParseError:
    """Cover the urlparse exception branch."""

    def test_rejects_url_that_causes_parse_error(self):
        from scrapers_handler import validate_url
        with patch('scrapers_handler.urlparse', side_effect=Exception('Parse error')):
            is_valid, error = validate_url('http://example.com')
            assert is_valid is False
            assert 'Invalid URL format' in error


class TestValidateUrlIpValueError:
    """Cover the ValueError continue branch in IP validation."""

    @patch('scrapers_handler.socket.getaddrinfo')
    def test_continues_on_invalid_ip_address(self, mock_getaddrinfo):
        """Cover except ValueError: continue when ip_address() fails."""
        from scrapers_handler import validate_url
        # Return an address that will cause ip_address() to raise ValueError
        # followed by a valid public IP
        mock_getaddrinfo.return_value = [
            (2, 1, 6, '', ('not-an-ip', 80)),
            (2, 1, 6, '', ('93.184.216.34', 80)),
        ]
        is_valid, error = validate_url('http://example.com')
        assert is_valid is True
