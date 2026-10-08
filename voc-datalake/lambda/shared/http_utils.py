"""
Shared HTTP utilities with retry logic for external API calls.
Uses tenacity for exponential backoff on transient failures.
"""

import socket
from typing import TYPE_CHECKING, cast
from urllib.parse import urljoin, urlparse

import requests
import urllib3
from requests.adapters import HTTPAdapter
from tenacity import (
    before_sleep_log,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.exceptions import ConnectTimeoutError, NameResolutionError, NewConnectionError

from shared.logging import logger
from shared.url_policy import (
    PRIVATE_ADDRESS_ERROR,
    BlockedDestinationError,
    connect_to_validated_address,
    validate_url,
)

if TYPE_CHECKING:
    from urllib3._base_connection import BaseHTTPConnection, BaseHTTPSConnection

# Exceptions that should trigger a retry (transient network issues only)
RETRYABLE_EXCEPTIONS = (
    requests.exceptions.Timeout,
    requests.exceptions.ConnectionError,
)


class RetryableHTTPError(requests.exceptions.HTTPError):
    """HTTPError subclass for server errors (429, 5xx) that should be retried."""


class _TenacityLogger:
    """Hand the Powertools logger to tenacity's ``LoggerProtocol``.

    Powertools' ``Logger`` serves ``log`` through ``__getattr__`` (delegating to
    its stdlib logger), which a structural protocol check cannot see. This
    forwards the call unchanged; ``stacklevel=2`` keeps the record attributed to
    tenacity's caller frame rather than this shim.
    """

    def __init__(self, target) -> None:
        self._target = target

    def log(self, level: int, msg: str, /, *args, **kwargs) -> None:
        kwargs.setdefault('stacklevel', 2)
        self._target.log(level, msg, *args, **kwargs)


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
        before_sleep=before_sleep_log(_TenacityLogger(logger), log_level=20),  # INFO level
        reraise=True,
    )


# Default retry decorator for API calls
retry_on_transient_error = create_retry_decorator()


@retry_on_transient_error
def fetch_with_retry(
    url: str,
    headers: dict | None = None,
    params: dict | None = None,
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
    _raise_if_retryable(response)
    return response


def _raise_if_retryable(response: requests.Response) -> None:
    """Only 429 (rate limit) and 5xx server errors are retried."""
    if response.status_code == 429 or response.status_code >= 500:
        raise RetryableHTTPError(
            f"{response.status_code} Server Error: {response.reason}",
            response=response,
        )


# --- Policy-checked fetch for user-configured URLs (SSRF, issue #244) ---------

MAX_REDIRECT_HOPS = 5
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
# Dropped when a redirect leaves the original origin, as requests itself would.
_CROSS_ORIGIN_SENSITIVE_HEADERS = frozenset({'authorization', 'cookie', 'proxy-authorization'})
_DEFAULT_PORTS = {'http': 80, 'https': 443}


class UnsafeURLError(ValueError):
    """A URL (the configured one or a redirect hop) failed `shared.url_policy`.

    Deliberately NOT a `requests.RequestException`: a policy refusal is not a
    network failure, is never retried, and callers that swallow fetch errors
    must not swallow it silently. Raised from inside urllib3's connect too
    (`_PinnedConnectionMixin`), where a `ValueError` passes through urllib3 and
    requests unwrapped.
    """

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"URL blocked by policy ({url}): {reason}")
        self.url = url
        self.reason = reason


def _require_policy(url: str) -> None:
    is_valid, reason = validate_url(url)
    if not is_valid:
        raise UnsafeURLError(url, reason)


def _pinned_new_conn(conn: HTTPConnection) -> socket.socket:
    """urllib3 `_new_conn` through `shared.url_policy.connect_to_validated_address`.

    The socket goes only to an address the policy vetted AT CONNECT (and its
    actual peer is re-checked), so a name that rebinds to 127.0.0.1:9001 (the
    Lambda Runtime API) or 169.254.x after `validate_url` is refused. `conn.host`
    stays the original name, so the Host header and — for HTTPS — SNI plus
    certificate/hostname verification still use it. Error mapping mirrors
    urllib3's own `_new_conn`, so timeouts and refusals still retry; a policy
    refusal becomes `UnsafeURLError`, which is never retried.
    """
    try:
        # `conn.timeout` is already resolved (urllib3 `Timeout.resolve_default_timeout`).
        sock = connect_to_validated_address((conn._dns_host, conn.port), conn.timeout, conn.source_address)
    except BlockedDestinationError as e:
        raise UnsafeURLError(f"{conn.host}:{conn.port}", PRIVATE_ADDRESS_ERROR) from e
    except socket.gaierror as e:
        raise NameResolutionError(conn.host, conn, e) from e
    except TimeoutError as e:
        raise ConnectTimeoutError(conn, f"Connection to {conn.host} timed out.") from e
    except OSError as e:
        raise NewConnectionError(conn, f"Failed to establish a new connection: {e}") from e
    for option in conn.socket_options or ():
        sock.setsockopt(*option)
    return sock


class _PinnedHTTPConnection(HTTPConnection):
    def _new_conn(self) -> socket.socket:
        return _pinned_new_conn(self)


class _PinnedHTTPSConnection(HTTPSConnection):
    def _new_conn(self) -> socket.socket:
        return _pinned_new_conn(self)


# `cast`, not a runtime conversion: urllib3 declares `ConnectionCls` as its own
# BaseHTTP(S)Connection protocols, which its concrete HTTP(S)Connection classes
# do not structurally satisfy for a type checker (`default_socket_options` is
# `Final` there and a mutable ClassVar in the protocol) although urllib3 itself
# assigns exactly those classes. The subclasses below change only `_new_conn`.
class _PinnedHTTPPool(urllib3.HTTPConnectionPool):
    ConnectionCls = cast('type[BaseHTTPConnection]', _PinnedHTTPConnection)


class _PinnedHTTPSPool(urllib3.HTTPSConnectionPool):
    ConnectionCls = cast('type[BaseHTTPSConnection]', _PinnedHTTPSConnection)


class _PinnedAdapter(HTTPAdapter):
    """An adapter whose every new connection is pinned, and which never proxies."""

    def init_poolmanager(self, *args, **kwargs) -> None:
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = {'http': _PinnedHTTPPool, 'https': _PinnedHTTPSPool}

    def proxy_manager_for(self, proxy, **_proxy_kwargs):
        # Through a proxy the pinned socket would be the proxy's, and the policy
        # would no longer judge the real target.
        raise UnsafeURLError(proxy, 'Proxies are not allowed for policy-checked fetches')


def pinned_session() -> requests.Session:
    """A `requests.Session` for user-configured URLs.

    `trust_env=False`: no *_PROXY / NO_PROXY env vars, no `.netrc` credentials,
    no REQUESTS_CA_BUNDLE override. Both schemes mount `_PinnedAdapter`.
    """
    session = requests.Session()
    session.trust_env = False
    adapter = _PinnedAdapter()
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    return session


@retry_on_transient_error
def _fetch_policy_checked_hop(
    session: requests.Session, url: str, headers: dict | None, timeout: int,
) -> requests.Response:
    """One hop, retried on transient failures; the policy is re-run on EVERY attempt."""
    _require_policy(url)
    response = session.request(
        method='GET', url=url, headers=headers, timeout=timeout, allow_redirects=False,
    )
    _raise_if_retryable(response)
    return response


def _origin(url: str) -> tuple[str, str | None, int | None]:
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    return scheme, parsed.hostname, parsed.port or _DEFAULT_PORTS.get(scheme)


def _headers_for_hop(headers: dict | None, previous_url: str, next_url: str) -> dict | None:
    """`headers` for the next hop: credentials kept only on the SAME origin (scheme, host, port)."""
    if not headers or _origin(previous_url) == _origin(next_url):
        return headers
    return {k: v for k, v in headers.items() if k.lower() not in _CROSS_ORIGIN_SENSITIVE_HEADERS}


def _refuse_downgrade(previous_url: str, next_url: str) -> None:
    if _origin(previous_url)[0] == 'https' and _origin(next_url)[0] != 'https':
        raise UnsafeURLError(next_url, 'Redirect from https to http is not allowed')


def fetch_public_url(
    url: str,
    headers: dict | None = None,
    timeout: int = 30,
    max_redirects: int = MAX_REDIRECT_HOPS,
) -> requests.Response:
    """GET a user-configured `url`, enforcing the outbound URL policy on every hop.

    `url` and every redirect `Location` are checked by
    `shared.url_policy.validate_url` BEFORE a request is sent to them, on every
    retry attempt too, and every socket is pinned at connect time to an address
    the policy vetted (`pinned_session`), so DNS rebinding between the check and
    the connect is refused. Redirects are never followed by requests
    (`allow_redirects=False`); they are followed here, at most `max_redirects`
    hops, never from https down to http. Credentials are dropped when a hop
    changes origin.

    Raises:
        UnsafeURLError: `url`, a redirect hop or a connect target is refused.
        requests.exceptions.TooManyRedirects: more than `max_redirects` hops.
        Anything `fetch_with_retry` raises.
    """
    current = url
    hop_headers = headers
    with pinned_session() as session:
        for _hop in range(max_redirects + 1):
            response = _fetch_policy_checked_hop(session, current, hop_headers, timeout)
            location = response.headers.get('Location')
            if response.status_code not in REDIRECT_STATUSES or not location:
                return response
            response.close()
            next_url = urljoin(current, location)
            _refuse_downgrade(current, next_url)
            hop_headers = _headers_for_hop(hop_headers, current, next_url)
            current = next_url
    raise requests.exceptions.TooManyRedirects(f"Exceeded {max_redirects} redirects fetching {url}")
