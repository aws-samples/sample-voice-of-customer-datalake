"""Outbound URL policy for scraper fetches (SSRF guard, issue #244).

ONE implementation, used by every path that turns a configured or
caller-supplied URL into an HTTP request:

- `POST /scrapers/analyze-url` (``api/scrapers_handler.py``) before its fetch,
  and again on every redirect hop and at connect time;
- `POST /scrapers` (``save_scraper``) on every URL of the saved config;
- the webscraper ingestor before EVERY request, including each redirect hop
  (``shared/http_utils.fetch_public_url``).

It lives in ``lambda/shared`` because both bundles ship that directory: the API
Lambdas copy ``/asset-input/shared`` (``createApiLambdaCode`` in api-stack.ts)
and every plugin ingestor copies ``/asset-input/lambda/shared``
(``bundlePluginCode`` in ingestion-stack.ts). Standard library only, so it
imports in either layer.

The rule: http/https only, no userinfo, a hostname is required, and the host is
RESOLVED and every address it answers must be public unicast. Numeric tricks
(``http://2130706433/``, ``http://0x7f.1/``, ``http://[::ffff:127.0.0.1]/``)
need no string matching — the resolver turns them into the address they mean,
and that address is what is judged.
"""

import ipaddress
import socket
from urllib.parse import urlparse

from shared.logging import logger

# Names refused before any lookup. Belt and braces only: every one of them
# resolves to loopback, which the address check refuses anyway. There is no
# IP-range list — `is_blocked_ip` refuses everything that is not globally
# reachable, a strict superset of the RFC 1918 / loopback / link-local / ULA
# ranges such a list would name (pinned by
# test_scrapers_ssrf.py::test_is_global_covers_the_classic_private_ranges).
BLOCKED_HOSTNAMES = frozenset({'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'})
PRIVATE_ADDRESS_ERROR = 'Access to internal/private IP addresses is not allowed'

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address  # pragma: no mutate  annotation-only alias: nothing reads it at runtime


class BlockedDestinationError(OSError):
    """A fetch would reach a non-public address; raised at resolve or connect time.

    An `OSError` so urllib's `do_open` wraps it in a `URLError` like any other
    connect failure; the analyze-url fetch unwraps it back into the route's 400.
    """

    def __init__(self) -> None:
        super().__init__(PRIVATE_ADDRESS_ERROR)


# NAT64 well-known prefix (RFC 6052): the low 32 bits ARE the IPv4 destination.
_NAT64_WELL_KNOWN = ipaddress.IPv6Network('64:ff9b::/96')
# NAT64 local-use prefix (RFC 8215): operator-chosen embedding, so the IPv4 part
# cannot be located reliably — refused outright.
_NAT64_LOCAL_USE = ipaddress.IPv6Network('64:ff9b:1::/48')
# Deprecated IPv4-compatible addresses (RFC 4291 §2.5.5.1), `::a.b.c.d`.
_IPV4_COMPATIBLE = ipaddress.IPv6Network('::/96')


def _translated_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """The IPv4 address `ip` is merely a spelling of (mapped, compatible, NAT64 /96), if any.

    These all sit inside the reserved ``::/8`` block, so the IPv6 form says
    nothing about reachability: only the IPv4 destination they translate to does.
    """
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip in _NAT64_WELL_KNOWN or ip in _IPV4_COMPATIBLE:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def _tunnelled_ipv4(ip: ipaddress.IPv6Address) -> list[ipaddress.IPv4Address]:
    """IPv4 endpoints a 6to4 (2002::/16) or Teredo (2001::/32) address embeds."""
    embedded = [ip.sixtofour] if ip.sixtofour is not None else []
    if ip.teredo is not None:
        embedded.extend(ip.teredo)
    return embedded


def _is_blocked_as_written(ip: IPAddress) -> bool:
    if not ip.is_global or ip.is_multicast or ip.is_reserved:
        return True
    return isinstance(ip, ipaddress.IPv6Address) and ip.is_site_local


def is_blocked_ip(ip: IPAddress) -> bool:
    """Whether `ip` is anything but a public unicast address.

    `is_global` is False for private, loopback, link-local (169.254/16 — the
    instance metadata endpoint — and fe80::/10), ULA (fc00::/7), shared
    (100.64/10), benchmarking and unspecified space; multicast, reserved
    (240/4, …) and deprecated IPv6 site-local (fec0::/10) are refused on top
    because `is_global` lets parts of them through.

    IPv6 spellings of an IPv4 address are judged by the IPv4 address they reach:
    IPv4-mapped (`::ffff:127.0.0.1`), IPv4-compatible (`::7f00:1`) and NAT64
    (`64:ff9b::a9fe:a9fe` is 169.254.169.254). The NAT64 local-use prefix is
    refused outright. 6to4 and Teredo addresses are refused when the IPv6 form
    OR any IPv4 endpoint they embed is non-public.
    """
    if isinstance(ip, ipaddress.IPv6Address):
        if ip in _NAT64_LOCAL_USE:
            return True
        translated = _translated_ipv4(ip)
        if translated is not None:
            return _is_blocked_as_written(translated)
        if any(_is_blocked_as_written(v4) for v4 in _tunnelled_ipv4(ip)):
            return True
    return _is_blocked_as_written(ip)


def _unscoped_address(address: object) -> IPAddress:
    """Parse a socket address string, dropping any IPv6 scope id ('fe80::1%eth0')."""
    return ipaddress.ip_address(str(address).partition('%')[0])


def public_addresses(hostname: str, port: int | None) -> list[IPAddress]:
    """Resolve `hostname` ONCE; every address it answers, provided all are public.

    Raises `BlockedDestinationError` when any answer is non-public (one bad
    record refuses the name — a client may fall back to it), and lets the
    resolver's own `OSError` / IDNA `ValueError` propagate.
    """
    answers = socket.getaddrinfo(hostname, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    addresses: list[IPAddress] = []
    for _family, _, _, _, sockaddr in answers:
        try:
            ip = _unscoped_address(sockaddr[0])
        except ValueError:
            continue
        if is_blocked_ip(ip):
            raise BlockedDestinationError
        addresses.append(ip)
    if not addresses:
        # Nothing parseable came back: fail closed rather than "no bad answer".
        raise BlockedDestinationError
    return list(dict.fromkeys(addresses))


def _require_validated_peer(sock: socket.socket, expected: IPAddress) -> None:
    """Close `sock` and refuse unless it is connected to `expected`, a public address."""
    try:
        peer = _unscoped_address(sock.getpeername()[0])
    except (OSError, ValueError):
        sock.close()
        raise BlockedDestinationError from None
    if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped is not None:
        peer = peer.ipv4_mapped
    if peer != expected or is_blocked_ip(peer):
        sock.close()
        raise BlockedDestinationError


def connect_to_validated_address(
    address: tuple[str, int],
    timeout: float | None,
    source_address: tuple[str, int] | None = None,
) -> socket.socket:
    """`socket.create_connection` with the destination policy enforced AT CONNECT.

    THE connect-time pin, shared by both outbound transports: analyze-url's
    urllib opener (``api/scrapers_handler.py``) and the ingestor's requests
    session (``shared/http_utils.pinned_session``).

    Resolves the name once, refuses it if any answer is non-public, then connects
    to those vetted IP literals only (no second lookup a rebinding DNS server
    could answer differently) and checks the socket's actual peer. Fallback
    across the vetted addresses is kept, and every one of them was vetted.
    `timeout` is passed through untouched (http.client may hand over its
    "use the global default" sentinel at runtime; typeshed types that hook's
    timeout as `float | None`, so that is the annotation here too).
    """
    host, port = address
    # public_addresses never returns an empty list, so `errors` is non-empty below.
    errors: list[OSError] = []
    for ip in public_addresses(host.strip('[]'), port):
        try:
            sock = socket.create_connection((str(ip), port), timeout, source_address)
        except OSError as e:
            errors.append(e)
            continue
        _require_validated_peer(sock, ip)
        return sock
    raise errors[-1]


def _blocked_address_error(hostname: str) -> str | None:
    """Why `hostname` must not be fetched, or None when every address it resolves to is public."""
    try:
        # An IP literal is judged as written: no resolver gets a say in it.
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        return PRIVATE_ADDRESS_ERROR if is_blocked_ip(literal) else None
    try:
        public_addresses(hostname, None)
    except BlockedDestinationError:
        return PRIVATE_ADDRESS_ERROR
    except socket.gaierror:
        return 'Could not resolve hostname'
    except (OSError, ValueError) as e:
        # OSError: any other resolver failure; ValueError covers the IDNA
        # UnicodeError a malformed international hostname raises.
        logger.warning(f"URL validation error: {e}")
        return 'URL validation failed'
    return None


def validate_url(url: object) -> tuple[bool, str]:
    """Check `url` against the outbound policy. Returns ``(is_valid, error_message)``."""
    if not url or not isinstance(url, str):
        return False, 'URL is required'

    # urlparse and .hostname/.port raise ValueError on e.g. a bad IPv6 literal
    # or a non-numeric port.
    try:
        # Not stripped: what is judged must be exactly what gets fetched.
        parsed = urlparse(url)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError:
        return False, 'Invalid URL format'

    if parsed.scheme not in ('http', 'https'):
        return False, 'Only http and https URLs are allowed'

    # `http://public.example@10.0.0.1/` — the part a reader sees is not the host.
    if '@' in parsed.netloc:
        return False, 'URLs with embedded credentials are not allowed'

    if not hostname:
        return False, 'URL must have a valid hostname'

    # `.hostname` is already lower-cased by urlparse, so no 'X' is ever stripped.
    name = hostname.rstrip('.')  # pragma: no mutate  the strip-set mutant only adds 'X'
    if name in BLOCKED_HOSTNAMES:
        return False, 'Access to localhost is not allowed'

    error = _blocked_address_error(hostname)
    if error is not None:
        return False, error
    return True, ''
