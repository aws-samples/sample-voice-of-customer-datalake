"""A Radar brand's news-scan fields: its language and its feed URLs (docs/radar.md).

Stored on a brand-list entry beside ``label`` and ``domains`` (absent = not set)::

    {label: "Acme", domains: ["acme.pl"], language: "pl", feed_urls: ["https://acme.pl/feed"]}

``language`` is an ISO 639-1 code from ``LANGUAGES`` (absent / null / "" / "auto" = auto). The
EFFECTIVE language is the stored one, else the one the brand's FIRST domain's TLD implies
(``TLD_LANGUAGES``), else English: the scan searches in it and in English.

``feed_urls`` are at most ``MAX_FEED_URLS`` RSS / Atom feeds the scan reads. Here only their
SHAPE is checked (https, a dotted host name, no credentials, no fragment, ``MAX_FEED_URL_CHARS``),
with no DNS lookup; the scan fetches them only through ``shared.http_utils.fetch_public_url``,
the SSRF guard, which judges every hop and pins the connection.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable
from typing import Final
from urllib.parse import urlparse

from shared.url_policy import BLOCKED_HOSTNAMES

__all__ = [
    'DEFAULT_LANGUAGE',
    'brand_language',
    'effective_language',
    'feed_urls',
]

#: The languages a brand may name (ISO 639-1); the scan has query words for each (jobs/radar_scan/queries.py).
LANGUAGES: Final = ('en', 'pl', 'cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'fi', 'no', 'hu', 'ro')
DEFAULT_LANGUAGE: Final = 'en'
AUTO_LANGUAGE: Final = 'auto'
#: A first domain's top-level domain -> the language its brand most likely publishes in.
TLD_LANGUAGES: Final = {
    'pl': 'pl', 'cz': 'cs', 'sk': 'sk', 'de': 'de', 'at': 'de', 'ch': 'de', 'fr': 'fr', 'es': 'es', 'it': 'it',
    'pt': 'pt', 'br': 'pt', 'nl': 'nl', 'se': 'sv', 'dk': 'da', 'fi': 'fi', 'no': 'no', 'hu': 'hu', 'ro': 'ro',
}
MAX_FEED_URLS: Final = 3
MAX_FEED_URL_CHARS: Final = 500


def brand_language(raw: object, what: str) -> str | None:
    """The stored language of a brand-list entry (None = auto), or ValueError (client-safe)."""
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError(f'{what} language must be a two-letter language code or empty for auto')
    code = raw.strip().lower()
    if code in ('', AUTO_LANGUAGE):
        return None
    if code not in LANGUAGES:
        raise ValueError(f'{what} language must be one of {", ".join(LANGUAGES)} (or empty for auto)')
    return code


def effective_language(language: str | None, domains: Iterable[str]) -> str:
    """The language the scan searches in: the stored one, else the first domain's TLD's, else English."""
    if language in LANGUAGES:
        return str(language)
    first = next(iter(domains), '')
    return TLD_LANGUAGES.get(first.rsplit('.', 1)[-1], DEFAULT_LANGUAGE) if first else DEFAULT_LANGUAGE


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _feed_url_problem(url: str) -> str | None:
    """Why ``url`` is not an acceptable feed URL (shape only, no DNS), or None."""
    if len(url) > MAX_FEED_URL_CHARS:
        return f'is longer than {MAX_FEED_URL_CHARS} characters'
    if any(char.isspace() or ord(char) < 32 for char in url):
        return 'contains spaces or control characters'
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or '').rstrip('.')
        _ = parsed.port
    except ValueError:
        return 'is not a valid URL'
    problems = (
        (parsed.scheme != 'https', 'must start with https://'),
        ('@' in parsed.netloc, 'must not hold credentials'),
        ('#' in url, 'must not have a #fragment'),
        (not host or '.' not in host or host in BLOCKED_HOSTNAMES or _is_ip_literal(host),
         'needs a public host name like example.com'),
    )
    return next((message for failed, message in problems if failed), None)


def feed_urls(raw: object, what: str) -> list[str]:
    """The de-duplicated feed URLs of a brand-list entry, or ValueError (client-safe)."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f'{what} feed_urls must be a list of https URLs')
    out: list[str] = []
    for number, entry in enumerate(raw, start=1):
        url = entry.strip() if isinstance(entry, str) else ''
        problem = _feed_url_problem(url) if url else 'is empty'
        if problem:
            raise ValueError(f'{what} feed URL {number} {problem}')
        if url not in out:
            out.append(url)
    if len(out) > MAX_FEED_URLS:
        raise ValueError(f'{what} may have at most {MAX_FEED_URLS} feed URLs')
    return out
