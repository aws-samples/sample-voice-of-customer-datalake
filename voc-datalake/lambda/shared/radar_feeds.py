"""A Radar brand's RSS / Atom feeds, read by the news scan (docs/radar.md → "Feeds").

Each feed URL (at most 3 per brand, checked for shape when the brand list is saved) is fetched
ONLY through ``shared.http_utils.fetch_public_url``, the SSRF guard: https, at most
``MAX_FEED_BYTES``, ``FEED_TIMEOUT_SECONDS``, ``MAX_FEED_REDIRECTS`` hops, every hop judged by the
URL policy and the connection pinned to the vetted address.

The document is parsed safely: one that declares a DOCTYPE or an ENTITY is refused BEFORE parsing
(entity expansion "billion laughs" and external entities), as is one that is not ASCII-compatible
(a UTF-16 document could hide the declaration from that check). RSS 2.0 (``<rss><channel><item>``)
and Atom 1.0 (``<feed><entry>``) are read; anything else is not a feed.

Items dated within the window (``pubDate`` / ``published`` / ``updated``) become search-shaped
results ``{title, url, text, published_date}`` for the extractor: the item's own https link (never
the feed URL, which is never a citation), its description with the tags stripped (at most
``MAX_TEXT_CHARS``), at most ``MAX_FEED_ITEMS``, newest first. A feed that fails is logged with its
host only, and the scan goes on.
"""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import date, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Final
from urllib.parse import urlparse

import requests

from shared.http_utils import UnsafeURLError
from shared.logging import logger

__all__ = ['feed_results']

MAX_FEED_BYTES: Final = 2_000_000
FEED_TIMEOUT_SECONDS: Final = 15
MAX_FEED_REDIRECTS: Final = 3
MAX_FEED_ITEMS: Final = 30
MAX_TEXT_CHARS: Final = 1200
_UNSAFE_DECLARATION: Final = re.compile(rb'<!\s*(DOCTYPE|ENTITY)', re.IGNORECASE)
_TAG: Final = re.compile(r'<[^>]{0,2000}>')
_ATOM: Final = '{http://www.w3.org/2005/Atom}'


class FeedError(ValueError):
    """The document is not a feed this reader accepts (unsafe, malformed, or neither RSS nor Atom)."""


def _plain(raw: str | None) -> str:
    """Text without tags or entities, whitespace collapsed, clipped."""
    text = html.unescape(_TAG.sub(' ', html.unescape(raw or '')))
    return ' '.join(text.split())[:MAX_TEXT_CHARS]


def _day(raw: str | None) -> date | None:
    text = (raw or '').strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace('Z', '+00:00')).date()
    except ValueError:
        pass
    try:
        return parsedate_to_datetime(text).date()
    except (TypeError, ValueError, IndexError):
        return None


def _https(url: str | None) -> str:
    link = (url or '').strip()
    parsed = urlparse(link)
    return link if parsed.scheme == 'https' and parsed.hostname else ''


def _rss_items(root: ET.Element) -> list[dict[str, Any]]:
    return [{
        'title': _plain(item.findtext('title')), 'url': _https(item.findtext('link')),
        'text': _plain(item.findtext('description')), 'day': _day(item.findtext('pubDate')),
    } for item in root.iter('item')]


def _atom_link(entry: ET.Element) -> str:
    links = entry.findall(f'{_ATOM}link')
    preferred = [link for link in links if link.get('rel', 'alternate') == 'alternate'] or links
    return _https(preferred[0].get('href')) if preferred else ''


def _atom_items(root: ET.Element) -> list[dict[str, Any]]:
    return [{
        'title': _plain(entry.findtext(f'{_ATOM}title')), 'url': _atom_link(entry),
        'text': _plain(entry.findtext(f'{_ATOM}summary') or entry.findtext(f'{_ATOM}content')),
        'day': _day(entry.findtext(f'{_ATOM}published') or entry.findtext(f'{_ATOM}updated')),
    } for entry in root.iter(f'{_ATOM}entry')]


def parse_feed(body: bytes, since: date, today: date) -> list[dict[str, str]]:
    """The feed's items dated ``since`` .. ``today`` with an https link, newest first, as search results."""
    if b'\x00' in body:
        raise FeedError('not an ASCII-compatible document')
    if _UNSAFE_DECLARATION.search(body):
        raise FeedError('declares a DOCTYPE or an ENTITY')
    try:
        root = ET.fromstring(body)  # noqa: S314 - DOCTYPE / ENTITY refused above
    except ET.ParseError:
        raise FeedError('malformed XML') from None
    if root.tag == 'rss':
        items = _rss_items(root)
    elif root.tag == f'{_ATOM}feed':
        items = _atom_items(root)
    else:
        raise FeedError('neither RSS 2.0 nor Atom 1.0')
    dated = [item for item in items if item['url'] and item['day'] and since <= item['day'] <= today]
    dated.sort(key=lambda item: item['day'], reverse=True)
    return [{'title': item['title'], 'url': item['url'], 'text': item['text'] or item['title'],
             'published_date': item['day'].isoformat()} for item in dated[:MAX_FEED_ITEMS]]


def feed_results(url: str, since: date, today: date, fetch: Callable[..., Any]) -> list[dict[str, str]]:
    """One feed's in-window items as search results; ``[]`` (logged with the host only) when it fails."""
    parsed = urlparse(url)
    host = parsed.hostname or '?'
    if parsed.scheme != 'https':
        logger.warning('Radar: a feed URL is not https; skipped', extra={'feed_host': host})
        return []
    try:
        response = fetch(url, timeout=FEED_TIMEOUT_SECONDS, max_redirects=MAX_FEED_REDIRECTS,
                         max_bytes=MAX_FEED_BYTES)
        if response.status_code != 200:
            logger.warning('Radar: a feed answered an error; skipped',
                           extra={'feed_host': host, 'status': response.status_code})
            return []
        return parse_feed(response.content[:MAX_FEED_BYTES], since, today)
    except (requests.RequestException, UnsafeURLError, OSError):
        logger.warning('Radar: a feed could not be fetched; skipped', extra={'feed_host': host})
    except FeedError as error:
        logger.warning(f'Radar: a feed was not read ({error}); skipped', extra={'feed_host': host})
    return []
