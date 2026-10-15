"""
Tests for shared/http_utils.py - HTTP utilities with retry logic.
"""

import pytest
from unittest.mock import patch, MagicMock
import requests


class TestRetryableHTTPError:
    """Tests for RetryableHTTPError exception class."""

    def test_is_subclass_of_http_error(self):
        """RetryableHTTPError inherits from HTTPError."""
        from shared.http_utils import RetryableHTTPError

        assert issubclass(RetryableHTTPError, requests.exceptions.HTTPError)

    def test_can_be_caught_as_http_error(self):
        """Can be caught by except HTTPError."""
        from shared.http_utils import RetryableHTTPError

        with pytest.raises(requests.exceptions.HTTPError):
            raise RetryableHTTPError("500 Server Error")


class TestFetchWithRetry:
    """Tests for fetch_with_retry function."""

    @patch("shared.http_utils.requests.request")
    def test_returns_response_on_success(self, mock_request):
        """Returns response for successful 200 request."""
        from shared.http_utils import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_request.return_value = mock_response

        result = fetch_with_retry("https://example.com")

        assert result == mock_response

    @patch("shared.http_utils.requests.request")
    def test_returns_403_without_retrying(self, mock_request):
        """Returns 403 response without retrying — client errors are not transient."""
        from shared.http_utils import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 403
        mock_response.reason = "Forbidden"
        mock_request.return_value = mock_response

        result = fetch_with_retry("https://example.com")

        assert result.status_code == 403
        assert mock_request.call_count == 1

    @patch("shared.http_utils.requests.request")
    def test_returns_404_without_retrying(self, mock_request):
        """Returns 404 response without retrying."""
        from shared.http_utils import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.reason = "Not Found"
        mock_request.return_value = mock_response

        result = fetch_with_retry("https://example.com")

        assert result.status_code == 404
        assert mock_request.call_count == 1

    @patch("shared.http_utils.requests.request")
    def test_retries_on_500_server_error(self, mock_request):
        """Retries on 500 server errors up to max attempts."""
        from shared.http_utils import RetryableHTTPError

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.reason = "Internal Server Error"
        mock_request.return_value = mock_response

        # Use a fresh decorator with no wait to speed up test
        from shared.http_utils import fetch_with_retry

        with pytest.raises(RetryableHTTPError):
            fetch_with_retry("https://example.com")

        assert mock_request.call_count == 3  # 3 attempts (default)

    @patch("shared.http_utils.requests.request")
    def test_retries_on_429_rate_limit(self, mock_request):
        """Retries on 429 rate limit responses."""
        from shared.http_utils import RetryableHTTPError

        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_response.reason = "Too Many Requests"
        mock_request.return_value = mock_response

        from shared.http_utils import fetch_with_retry

        with pytest.raises(RetryableHTTPError):
            fetch_with_retry("https://example.com")

        assert mock_request.call_count == 3

    @patch("shared.http_utils.requests.request")
    def test_retries_on_timeout(self, mock_request):
        """Retries on request timeout."""
        mock_request.side_effect = requests.exceptions.Timeout("Connection timed out")

        from shared.http_utils import fetch_with_retry

        with pytest.raises(requests.exceptions.Timeout):
            fetch_with_retry("https://example.com")

        assert mock_request.call_count == 3

    @patch("shared.http_utils.requests.request")
    def test_retries_on_connection_error(self, mock_request):
        """Retries on connection errors."""
        mock_request.side_effect = requests.exceptions.ConnectionError("Connection refused")

        from shared.http_utils import fetch_with_retry

        with pytest.raises(requests.exceptions.ConnectionError):
            fetch_with_retry("https://example.com")

        assert mock_request.call_count == 3

    @patch("shared.http_utils.requests.request")
    def test_recovers_after_transient_failure(self, mock_request):
        """Succeeds after transient failure on retry."""
        from shared.http_utils import fetch_with_retry

        success_response = MagicMock()
        success_response.status_code = 200

        mock_request.side_effect = [
            requests.exceptions.ConnectionError("Temporary failure"),
            success_response,
        ]

        result = fetch_with_retry("https://example.com")

        assert result.status_code == 200
        assert mock_request.call_count == 2

    @patch("shared.http_utils.requests.request")
    def test_passes_headers_and_params(self, mock_request):
        """Passes headers, params, and timeout to requests."""
        from shared.http_utils import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_request.return_value = mock_response

        fetch_with_retry(
            "https://example.com",
            headers={"Authorization": "Bearer token"},
            params={"q": "test"},
            timeout=15,
        )

        mock_request.assert_called_once_with(
            method="GET",
            url="https://example.com",
            headers={"Authorization": "Bearer token"},
            params={"q": "test"},
            timeout=15,
        )

    @patch("shared.http_utils.requests.request")
    def test_retryable_http_error_includes_response(self, mock_request):
        """RetryableHTTPError raised for 5xx includes the response object."""
        from shared.http_utils import RetryableHTTPError

        mock_response = MagicMock()
        mock_response.status_code = 502
        mock_response.reason = "Bad Gateway"
        mock_request.return_value = mock_response

        from shared.http_utils import fetch_with_retry

        with pytest.raises(RetryableHTTPError) as exc_info:
            fetch_with_retry("https://example.com")

        assert exc_info.value.response == mock_response


class TestFetchJsonWithRetry:
    """Tests for fetch_json_with_retry function."""

    @patch("shared.http_utils.requests.request")
    def test_returns_parsed_json(self, mock_request):
        """Returns parsed JSON from successful response."""
        from shared.http_utils import fetch_json_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"key": "value"}
        mock_response.raise_for_status = MagicMock()
        mock_request.return_value = mock_response

        result = fetch_json_with_retry("https://api.example.com/data")

        assert result == {"key": "value"}

    @patch("shared.http_utils.requests.request")
    def test_raises_on_403_client_error(self, mock_request):
        """Raises HTTPError for 403 without retrying."""
        from shared.http_utils import fetch_json_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 403
        mock_response.reason = "Forbidden"
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError(
            "403 Forbidden"
        )
        mock_request.return_value = mock_response

        with pytest.raises(requests.exceptions.HTTPError):
            fetch_json_with_retry("https://api.example.com/data")

        assert mock_request.call_count == 1
