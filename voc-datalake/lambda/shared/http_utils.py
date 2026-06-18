"""
Shared HTTP utilities with retry logic for external API calls.
Uses tenacity for exponential backoff on transient failures.
"""

import requests
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)
from shared.logging import logger

# Exceptions that should trigger a retry (transient network issues only)
RETRYABLE_EXCEPTIONS = (
    requests.exceptions.Timeout,
    requests.exceptions.ConnectionError,
)


class RetryableHTTPError(requests.exceptions.HTTPError):
    """HTTPError subclass for server errors (429, 5xx) that should be retried."""
    pass


def create_retry_decorator(
    max_attempts: int = 3, min_wait: int = 2, max_wait: int = 30
):
    """
    Create a retry decorator with exponential backoff for external API calls.

    Args:
        max_attempts: Maximum number of retry attempts (default: 3)
        min_wait: Minimum wait time in seconds between retries (default: 2)
        max_wait: Maximum wait time in seconds between retries (default: 30)

    Returns:
        A tenacity retry decorator
    """
    return retry(
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(multiplier=1, min=min_wait, max=max_wait),
        retry=retry_if_exception_type((*RETRYABLE_EXCEPTIONS, RetryableHTTPError)),
        before_sleep=before_sleep_log(logger, log_level=20),  # INFO level
        reraise=True,
    )


# Default retry decorator for API calls
retry_on_transient_error = create_retry_decorator()


@retry_on_transient_error
def fetch_with_retry(
    url: str,
    headers: dict = None,
    params: dict = None,
    timeout: int = 30,
    method: str = "GET",
    **kwargs,
) -> requests.Response:
    """
    Make HTTP request with automatic retry on transient failures.

    Retries on:
    - Connection errors
    - Timeouts
    - Rate limits (429)
    - Server errors (5xx)

    Does NOT retry on:
    - Client errors (4xx except 429)

    Args:
        url: The URL to fetch
        headers: Optional request headers
        params: Optional query parameters
        timeout: Request timeout in seconds (default 30)
        method: HTTP method (GET, POST, etc.)
        **kwargs: Additional arguments passed to requests (json, data, auth, etc.)

    Returns:
        requests.Response object

    Raises:
        requests.exceptions.HTTPError: On non-retryable HTTP errors
        requests.exceptions.Timeout: After max retries on timeout
        requests.exceptions.ConnectionError: After max retries on connection errors
    """
    response = requests.request(
        method=method,
        url=url,
        headers=headers,
        params=params,
        timeout=timeout,
        **kwargs,
    )

    # Only retry on 429 (rate limit) and 5xx server errors
    if response.status_code == 429 or response.status_code >= 500:
        raise RetryableHTTPError(
            f"{response.status_code} Server Error: {response.reason}",
            response=response,
        )

    return response


def fetch_json_with_retry(
    url: str,
    headers: dict = None,
    params: dict = None,
    timeout: int = 30,
    method: str = "GET",
    **kwargs,
) -> dict:
    """
    Make HTTP request and return JSON response with automatic retry.

    Same retry behavior as fetch_with_retry but automatically parses JSON.

    Args:
        url: The URL to fetch
        headers: Optional request headers
        params: Optional query parameters
        timeout: Request timeout in seconds (default 30)
        method: HTTP method (GET, POST, etc.)
        **kwargs: Additional arguments passed to requests

    Returns:
        Parsed JSON response as dict

    Raises:
        requests.exceptions.HTTPError: On HTTP errors
        json.JSONDecodeError: If response is not valid JSON
    """
    response = fetch_with_retry(
        url=url,
        headers=headers,
        params=params,
        timeout=timeout,
        method=method,
        **kwargs,
    )
    response.raise_for_status()
    return response.json()
