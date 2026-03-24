"""Tests for shared.http module - HTTP utilities with retry logic."""

import pytest
from unittest.mock import patch, MagicMock
import requests


class TestCreateRetryDecorator:
    """Tests for create_retry_decorator function."""

    def test_creates_decorator_with_defaults(self):
        """Creates a retry decorator with default parameters."""
        from shared.http import create_retry_decorator

        decorator = create_retry_decorator()
        assert callable(decorator)

    def test_creates_decorator_with_custom_params(self):
        """Creates a retry decorator with custom parameters."""
        from shared.http import create_retry_decorator

        decorator = create_retry_decorator(max_attempts=5, min_wait=1, max_wait=60)
        assert callable(decorator)

    def test_decorated_function_is_callable(self):
        """Decorated function remains callable."""
        from shared.http import create_retry_decorator

        decorator = create_retry_decorator(max_attempts=1)

        @decorator
        def my_func():
            return 'ok'

        assert my_func() == 'ok'


class TestFetchWithRetry:
    """Tests for fetch_with_retry function."""

    @patch('shared.http.requests.request')
    def test_successful_get_request(self, mock_request):
        """Returns response on successful GET request."""
        from shared.http import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_request.return_value = mock_response

        result = fetch_with_retry('https://example.com/api')

        assert result == mock_response
        mock_request.assert_called_once_with(
            method='GET',
            url='https://example.com/api',
            headers=None,
            params=None,
            timeout=30,
        )

    @patch('shared.http.requests.request')
    def test_successful_post_request(self, mock_request):
        """Returns response on successful POST request."""
        from shared.http import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 201
        mock_request.return_value = mock_response

        result = fetch_with_retry(
            'https://example.com/api',
            method='POST',
            json={'key': 'value'},
            headers={'Authorization': 'Bearer token'},
        )

        assert result == mock_response
        mock_request.assert_called_once_with(
            method='POST',
            url='https://example.com/api',
            headers={'Authorization': 'Bearer token'},
            params=None,
            timeout=30,
            json={'key': 'value'},
        )

    @patch('shared.http.requests.request')
    def test_passes_custom_timeout(self, mock_request):
        """Passes custom timeout to requests."""
        from shared.http import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_request.return_value = mock_response

        fetch_with_retry('https://example.com', timeout=60)

        assert mock_request.call_args.kwargs['timeout'] == 60

    @patch('shared.http.requests.request')
    def test_raises_on_server_error(self, mock_request):
        """Raises HTTPError on 500 status (after retries)."""
        from shared.http import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError("500 Server Error")
        mock_request.return_value = mock_response

        with pytest.raises(requests.exceptions.HTTPError):
            fetch_with_retry('https://example.com')

    @patch('shared.http.requests.request')
    def test_raises_on_rate_limit(self, mock_request):
        """Raises HTTPError on 429 status (after retries)."""
        from shared.http import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError("429 Too Many Requests")
        mock_request.return_value = mock_response

        with pytest.raises(requests.exceptions.HTTPError):
            fetch_with_retry('https://example.com')

    @patch('shared.http.requests.request')
    def test_returns_4xx_without_raising(self, mock_request):
        """Returns response for 4xx errors (except 429) without raising."""
        from shared.http import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_request.return_value = mock_response

        result = fetch_with_retry('https://example.com/missing')
        assert result.status_code == 404

    @patch('shared.http.requests.request')
    def test_raises_on_timeout(self, mock_request):
        """Raises Timeout after retries on timeout errors."""
        from shared.http import fetch_with_retry

        mock_request.side_effect = requests.exceptions.Timeout("Connection timed out")

        with pytest.raises(requests.exceptions.Timeout):
            fetch_with_retry('https://example.com')

    @patch('shared.http.requests.request')
    def test_raises_on_connection_error(self, mock_request):
        """Raises ConnectionError after retries on connection errors."""
        from shared.http import fetch_with_retry

        mock_request.side_effect = requests.exceptions.ConnectionError("Connection refused")

        with pytest.raises(requests.exceptions.ConnectionError):
            fetch_with_retry('https://example.com')

    @patch('shared.http.requests.request')
    def test_passes_params(self, mock_request):
        """Passes query parameters to requests."""
        from shared.http import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_request.return_value = mock_response

        fetch_with_retry('https://example.com', params={'q': 'test'})

        assert mock_request.call_args.kwargs['params'] == {'q': 'test'}


class TestFetchJsonWithRetry:
    """Tests for fetch_json_with_retry function."""

    @patch('shared.http.fetch_with_retry')
    def test_returns_parsed_json(self, mock_fetch):
        """Returns parsed JSON from response."""
        from shared.http import fetch_json_with_retry

        mock_response = MagicMock()
        mock_response.json.return_value = {'data': 'test'}
        mock_response.raise_for_status.return_value = None
        mock_fetch.return_value = mock_response

        result = fetch_json_with_retry('https://example.com/api')

        assert result == {'data': 'test'}

    @patch('shared.http.fetch_with_retry')
    def test_raises_on_http_error(self, mock_fetch):
        """Raises HTTPError when response has error status."""
        from shared.http import fetch_json_with_retry

        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError("404")
        mock_fetch.return_value = mock_response

        with pytest.raises(requests.exceptions.HTTPError):
            fetch_json_with_retry('https://example.com/missing')

    @patch('shared.http.fetch_with_retry')
    def test_passes_all_params(self, mock_fetch):
        """Passes all parameters through to fetch_with_retry."""
        from shared.http import fetch_json_with_retry

        mock_response = MagicMock()
        mock_response.json.return_value = {}
        mock_response.raise_for_status.return_value = None
        mock_fetch.return_value = mock_response

        fetch_json_with_retry(
            'https://example.com',
            headers={'X-Custom': 'header'},
            params={'key': 'val'},
            timeout=15,
            method='POST',
            json={'body': 'data'},
        )

        mock_fetch.assert_called_once_with(
            url='https://example.com',
            headers={'X-Custom': 'header'},
            params={'key': 'val'},
            timeout=15,
            method='POST',
            json={'body': 'data'},
        )

    @patch('shared.http.fetch_with_retry')
    def test_raises_on_invalid_json(self, mock_fetch):
        """Raises JSONDecodeError when response is not valid JSON."""
        from shared.http import fetch_json_with_retry

        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.side_effect = ValueError("No JSON")
        mock_fetch.return_value = mock_response

        with pytest.raises(ValueError):
            fetch_json_with_retry('https://example.com')
