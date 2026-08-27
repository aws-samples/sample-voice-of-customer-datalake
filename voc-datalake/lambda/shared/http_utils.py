"""
Shared HTTP utilities with retry logic for external API calls.
Uses tenacity for exponential backoff on transient failures.

Also home to the single outbound-URL policy (issue #244): every caller that
fetches a user-supplied URL — the scrapers API on write and on preview, and the
scheduled webscraper ingestor on every hop — resolves it through
`assert_outbound_url_allowed` here. It lives in this module, rather than in a new
one, because this is the ONLY shared module both deployment bundles already
import: the API bundle copies all of `lambda/shared`, and the plugin ingestor
bundle copies `lambda/shared` next to `plugins/_shared`, whose `base_ingestor`
imports `fetch_with_retry` from here. A second module would need no packaging
change either, but a second *implementation* is what issue #244 asks us to
prevent, and keeping the policy beside the fetch it guards is what stops the two
drifting apart again.

RESIDUAL RISK — this is not a sandbox
-------------------------------------
The check resolves the hostname, then `requests` resolves it AGAIN when it opens
the connection. A record with a short TTL that answers publicly for the first
lookup and internally for the second (DNS rebinding) still reaches an internal
address; re-checking every redirect hop narrows that window to one request but
does not close it. Closing it means pinning the validated address — connecting to
the IP with an explicit `Host` header via a custom `HTTPAdapter` — which is a
larger change than this module makes today. Read the guarantee as "a configured
or redirected-to destination cannot be internal at check time", not as "no
request can ever reach an internal address".
"""

import ipaddress
import socket
import time
from urllib.parse import urljoin, urlparse

import requests
from tenacity import (
    before_sleep_log,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from shared.logging import logger

# Exceptions that should trigger a retry (transient network issues only)
RETRYABLE_EXCEPTIONS = (
    requests.exceptions.Timeout,
    requests.exceptions.ConnectionError,
)

# ---------------------------------------------------------------------------
# Outbound URL policy (SSRF, issue #244)
# ---------------------------------------------------------------------------

# Schemes the scrapers actually support. Anything else (file:, gopher:, ftp:,
# data:) is refused rather than handed to an HTTP client.
ALLOWED_OUTBOUND_SCHEMES = frozenset({'http', 'https'})

# Names refused without asking the resolver at all, so the error stays specific
# ("localhost is not allowed") and a resolver that answers oddly cannot make the
# decision. Resolution below is what actually closes the hole; this is only for
# a clearer message on the obvious case.
BLOCKED_OUTBOUND_HOSTNAMES = frozenset({
    'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
})

# Redirect statuses followed by `fetch_checked_with_retry`, spelled out rather
# than read from `requests.Response.is_redirect`: that property also consults
# `allow_redirects`, and this helper always sends with redirects DISABLED.
REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})

# Hops allowed before giving up. Bounded because each hop is a fresh
# resolve-and-check, and an unbounded chain is a free request amplifier.
MAX_REDIRECT_HOPS = 5

# Headers dropped when a redirect leaves the origin (scheme+host+port) they were
# addressed to, matching what `requests.SessionRedirectMixin.rebuild_auth` does
# for `Authorization`. The policy guarantees the next hop is a PUBLIC address,
# which is what makes this necessary rather than academic: without it, a
# credential meant for one site is handed to whatever third party that site's
# `Location` names. Matched case-insensitively — a caller's plain dict is not a
# `CaseInsensitiveDict`.
CROSS_ORIGIN_SENSITIVE_HEADERS = frozenset({
    'authorization', 'cookie', 'proxy-authorization',
})

# Headers describing a request body, dropped with the body when a hop downgrades
# to GET (below). Leaving a Content-Type on a body-less GET describes something
# that is no longer being sent.
BODY_HEADERS = frozenset({'content-length', 'content-type', 'transfer-encoding'})

# Body kwargs dropped alongside those headers, for the same reason.
BODY_KWARGS = ('data', 'json', 'files')


class OutboundUrlBlocked(ValueError):
    """
    Raised when a URL is not a permitted outbound target.

    Deliberately NOT a `requests.RequestException`: the webscraper ingestor
    treats a RequestException as "this page did not load", logs it at warning
    and moves on. A blocked destination is a configuration/security event that
    must reach the run's `errors` list, so it has to escape that handler.
    """


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """Return the IPv4 address tunnelled inside an IPv6 address, if any.

    `::ffff:10.0.0.1` (v4-mapped), `2002:0a00:0001::` (6to4) and Teredo all
    carry an IPv4 destination. Modern CPython classifies most of these
    correctly on the IPv6 object itself, but which forms it unwraps has changed
    between releases, so the embedded address is checked explicitly instead of
    trusting one interpreter's answer.
    """
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip.teredo is not None:
        # teredo == (server, client); the client is the tunnelled destination.
        return ip.teredo[1]
    return None


def is_global_outbound_address(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """
    True only for addresses that are safe to send a scraper request to.

    `is_global` alone is not enough in either direction: it is True for
    multicast (224.0.0.1), and the remaining predicates are named individually
    so the policy reads as the denylist the acceptance criteria describe rather
    than as one opaque flag.
    """
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None and not is_global_outbound_address(embedded):
            return False
        # IPv6 site-local (fec0::/10) is the one internal family none of the
        # predicates below catch: CPython reports is_global=True, is_private=
        # False, is_reserved=False and models it only as `is_site_local`.
        # Deprecated by RFC 3879 in favour of fc00::/7 (which `is_private` does
        # catch), but appliances still answer on it. IPv4Address has no such
        # property, which is why this stays inside the IPv6 branch.
        if ip.is_site_local:
            return False
    return (
        ip.is_global
        and not ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_multicast
        and not ip.is_unspecified
        and not ip.is_reserved
    )


def resolve_host_addresses(hostname: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """
    Every address `hostname` resolves to, as ipaddress objects.

    A literal address is parsed directly and never handed to the resolver, so a
    direct `http://127.0.0.1/` or `http://[::1]/` target is decided locally.

    Raises:
        OutboundUrlBlocked: resolution failed, or produced nothing usable.
    """
    try:
        return [ipaddress.ip_address(hostname)]
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except (OSError, UnicodeError) as e:
        # socket.gaierror is an OSError; so is a resolver timeout. Both mean we
        # cannot know where the request would land, so it does not go out.
        #
        # UnicodeError covers what getaddrinfo raises BEFORE resolving: the IDNA
        # codec raises UnicodeEncodeError (a ValueError, NOT an OSError) for a
        # label longer than 63 bytes or an empty label ('a'*64 + '.example.com',
        # 'a..b.com'). Catching only OSError let that escape the policy entirely,
        # so POST /scrapers answered with an unhandled invocation error instead
        # of the 400 the route is designed to return — the removed `validate_url`
        # had a catch-all that turned the same input into a refusal.
        raise OutboundUrlBlocked('Could not resolve hostname') from e

    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for info in infos:
        sockaddr = info[4]
        try:
            addresses.append(ipaddress.ip_address(sockaddr[0]))
        except (ValueError, IndexError, TypeError):
            # An answer we cannot classify is not an answer we can clear.
            raise OutboundUrlBlocked('Could not resolve hostname') from None

    if not addresses:
        raise OutboundUrlBlocked('Could not resolve hostname')
    return addresses


def assert_outbound_url_allowed(url: str) -> None:
    """
    The one outbound-URL policy for scraper traffic (issue #244).

    Rejects anything but http/https, URLs carrying credentials, URLs with no
    hostname, hosts that cannot be resolved, and any host where *at least one*
    resolved address is non-global — loopback, private, link-local (including
    the instance metadata endpoint), multicast, unspecified or reserved, in
    either IPv4 or IPv6 form. A mixed public/private answer set fails: the
    client picks the address, not us.

    Raises:
        OutboundUrlBlocked: with a message safe to hand back to an API caller.
    """
    if not url or not isinstance(url, str):
        raise OutboundUrlBlocked('URL is required')

    try:
        parsed = urlparse(url)
    except Exception as e:
        raise OutboundUrlBlocked('Invalid URL format') from e

    if parsed.scheme not in ALLOWED_OUTBOUND_SCHEMES:
        raise OutboundUrlBlocked('Only http and https URLs are allowed')

    try:
        hostname = parsed.hostname
        # A bracketed-IPv6 or port that will not parse raises here, not above:
        # urlparse defers those to attribute access.
        has_credentials = bool(parsed.username or parsed.password)
    except ValueError as e:
        raise OutboundUrlBlocked('Invalid URL format') from e

    if not hostname:
        raise OutboundUrlBlocked('URL must have a valid hostname')

    if has_credentials:
        # Credentials in a scraper target are never needed here, and they are a
        # standard way to make a URL's real host hard to read.
        raise OutboundUrlBlocked('URLs with embedded credentials are not allowed')

    if hostname.lower().rstrip('.') in BLOCKED_OUTBOUND_HOSTNAMES:
        raise OutboundUrlBlocked('Access to localhost is not allowed')

    for ip in resolve_host_addresses(hostname):
        if not is_global_outbound_address(ip):
            raise OutboundUrlBlocked(
                'Access to internal/private IP addresses is not allowed'
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

    This is the UNCHECKED fetch: it applies no outbound-URL policy and lets
    `requests` follow redirects itself, so the address the connection lands on is
    one this module never saw. Any caller whose URL comes from a stored
    configuration or a request body must use `fetch_checked_with_retry` instead
    (issue #244). This one remains correct for code-constructed URLs — the
    app-review and synthetic ingestors' fixed API endpoints.

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


def _request_origin(url: str) -> tuple:
    """Scheme, host and port a URL addresses — what "same origin" means here."""
    parsed = urlparse(url)
    try:
        port = parsed.port
    except ValueError:
        port = None
    return (parsed.scheme, (parsed.hostname or '').lower(), port)


def _without_headers(headers: dict | None, drop: frozenset) -> dict | None:
    """`headers` minus `drop`, matched case-insensitively. None stays None."""
    if not headers:
        return headers
    return {k: v for k, v in headers.items() if k.lower() not in drop}


def _method_after_redirect(method: str, status_code: int) -> str:
    """
    What `requests.SessionRedirectMixin.rebuild_method` would do.

    Reimplemented because this function owns the redirect walk: 303 and 302
    become GET (except on HEAD), and a 301 on a POST becomes GET. Without this a
    POST that receives a 303 was re-sent as a POST, with the original body, to a
    destination that asked to be read instead.
    """
    upper = method.upper()
    if status_code in (302, 303) and upper != 'HEAD':
        return 'GET'
    if status_code == 301 and upper == 'POST':
        return 'GET'
    return method


def fetch_checked_with_retry(
    url: str,
    # `dict | None` rather than the sibling functions' bare `dict = None`: those
    # predate the explicit-Optional rule and are left alone, but a new signature
    # here would be a new lint finding, and the tree's invariant is "no NEW
    # findings" (ruff.toml's header).
    headers: dict | None = None,
    params: dict | None = None,
    timeout: int = 30,
    method: str = "GET",
    max_redirects: int = MAX_REDIRECT_HOPS,
    total_timeout: float | None = None,
    **kwargs,
) -> requests.Response:
    """
    `fetch_with_retry` with the outbound-URL policy applied to EVERY hop.

    Redirects are followed here, one hop at a time, instead of by requests:
    `allow_redirects=False` is forced so the client cannot land on an address
    this function never saw. Each `Location` is resolved against the URL that
    produced it (a relative or scheme-relative `Location` is legal) and pushed
    back through `assert_outbound_url_allowed` before the next request goes out.
    That ordering is the whole point of issue #244 — checking a string once and
    then letting a client chase redirects is not a check.

    Owning the walk means owning the rest of `requests`' redirect semantics too,
    and the two that matter are implemented here rather than left to a reader's
    assumption: the method is downgraded to GET where `rebuild_method` would
    downgrade it (with the request body and its headers dropped with it), and
    `Authorization`/`Cookie` are dropped when a hop leaves the origin they were
    addressed to, as `rebuild_auth` does. Neither is exercised by today's two
    GET-only, unauthenticated callers — they are here because this is the
    recommended fetch for any config-supplied URL, so the next caller inherits
    them.

    The retry/error contract is unchanged: each hop is one `fetch_with_retry`
    call, so 429/5xx still retry with backoff and a 4xx still comes back as a
    response for the caller to inspect.

    Args:
        max_redirects: Hops allowed after the first request. Exhausting it
            raises rather than returning the last redirect, so a caller cannot
            mistake a 302 body for the page.
        total_timeout: Optional wall-clock budget for the WHOLE chain, in
            seconds. Without it, a chain of slow-but-valid hops costs up to
            `(max_redirects + 1) * timeout` plus retries, which overruns API
            Gateway's 29 s integration limit and surfaces as a 504 instead of the
            intended 4xx/5xx — so any caller inside a synchronous request should
            set it. Checked between hops and used to shorten each hop's own
            timeout, so a single hop's tenacity retries can still overshoot it;
            it bounds the chain, not one request.

    Raises:
        OutboundUrlBlocked: the initial URL, or any redirect target, is not a
            permitted destination — or the chain exceeded `max_redirects`.
        requests.exceptions.Timeout: `total_timeout` elapsed mid-chain. A
            transport failure, not a refusal, so callers that already treat a
            `RequestException` as "this page did not load" keep behaving that way.
    """
    # An explicit allow_redirects from a caller is dropped, not honoured:
    # following redirects inside requests is exactly the unchecked hop this
    # function exists to remove.
    kwargs.pop('allow_redirects', None)

    deadline = time.monotonic() + total_timeout if total_timeout else None
    origin = _request_origin(url)
    current_url = url
    for _ in range(max_redirects + 1):
        assert_outbound_url_allowed(current_url)

        hop_timeout = timeout
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise requests.exceptions.Timeout(
                    f'Exceeded the {total_timeout}s budget for {url}'
                )
            hop_timeout = min(timeout, remaining)

        response = fetch_with_retry(
            current_url,
            headers=headers,
            params=params,
            timeout=hop_timeout,
            method=method,
            allow_redirects=False,
            **kwargs,
        )

        location = response.headers.get('Location') if response.headers else None
        if response.status_code not in REDIRECT_STATUS_CODES or not location:
            return response

        # Only the FIRST request carries the caller's params; re-appending them
        # to a Location that already has its own query would corrupt the target.
        params = None
        next_url = urljoin(current_url, location)

        next_origin = _request_origin(next_url)
        if next_origin != origin:
            headers = _without_headers(headers, CROSS_ORIGIN_SENSITIVE_HEADERS)
            origin = next_origin

        next_method = _method_after_redirect(method, response.status_code)
        if next_method != method:
            # The body does not survive the downgrade, and neither do the headers
            # that described it.
            method = next_method
            headers = _without_headers(headers, BODY_HEADERS)
            for key in BODY_KWARGS:
                kwargs.pop(key, None)

        current_url = next_url
        logger.info(f"Following checked redirect to {current_url}")

    raise OutboundUrlBlocked(f'Too many redirects (limit {max_redirects})')


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
