"""The citations a Radar release shows: clean, one per page, https first (docs/radar.md).

A release keeps the web pages it was found on (``urls[]`` with ``titles[]`` at the same
index). Search results repeat the same page under several spellings and also return
machine feeds, so a citation list is cleaned before it is stored AND on the way out
(rows stored before this cleaning render clean too):

- **normalised**: the host is lower-cased, the fragment and tracking parameters
  (``utm_*``, ``gclid``, ``fbclid``, …) are dropped; anything that is not an
  ``http``/``https`` URL is not a citation;
- **one per page**: two URLs are the same page when they differ only by scheme, a
  leading ``www.``, a trailing slash or the order of their query parameters — the
  first one is kept (the ``https`` spelling when both exist; its title, or the other
  spelling's when it had none);
- **https first**: whether a host serves https is not known, so an ``http`` link is
  kept but listed after every ``https`` one;
- **no feeds**: a URL whose path ends in ``.json`` / ``.xml`` / ``.rss`` / ``.atom``,
  or has a ``rss`` / ``feed`` / ``feeds`` / ``atom`` path segment
  (``example-air.example/rss/changelog.json``), is a machine feed: it can still date a release or
  mark it official, but a person cannot read it, so it is never a citation. ``/feedback``
  is a word, not a feed segment, and stays.

A citation with no title reads as its host. Pure functions; never raises.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Final
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

__all__ = ['clean_citations']

MAX_CITATIONS: Final = 20
_SCHEMES: Final = frozenset({'http', 'https'})
_DEFAULT_PORTS: Final = {'http': 80, 'https': 443}
_TRACKING_PARAMS: Final = frozenset({'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', '_hsenc', '_hsmi'})
_FEED_SUFFIXES: Final = ('.json', '.xml', '.rss', '.atom')
_FEED_SEGMENTS: Final = frozenset({'rss', 'feed', 'feeds', 'atom'})


def _tracking(name: str) -> bool:
    lowered = name.lower()
    return lowered.startswith('utm_') or lowered in _TRACKING_PARAMS


def _netloc(scheme: str, host: str, port: int | None) -> str:
    shown = f'[{host}]' if ':' in host else host
    return shown if port is None or port == _DEFAULT_PORTS[scheme] else f'{shown}:{port}'


def normalise_url(url: object) -> str | None:
    """``url`` with a lower-case host, no fragment and no tracking parameters; None when it is not a web URL."""
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url.strip())
        host, port = (parts.hostname or '').lower(), parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in _SCHEMES or not host:
        return None
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _tracking(k)])
    return urlunsplit((scheme, _netloc(scheme, host, port), parts.path or '/', query, ''))


def is_feed_url(url: str) -> bool:
    """True when ``url`` is a machine feed (JSON / XML / RSS / Atom) rather than a page a person reads."""
    try:
        path = urlsplit(url).path.lower()
    except ValueError:
        return False
    segments = [segment for segment in path.split('/') if segment]
    return path.endswith(_FEED_SUFFIXES) or any(segment in _FEED_SEGMENTS for segment in segments)


def _page_key(url: str) -> str:
    """What makes two normalised URLs the same page: host without ``www.``, path without a trailing slash, query."""
    parts = urlsplit(url)
    host = parts.netloc.removeprefix('www.')
    query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    return f'{host}{parts.path.rstrip("/")}?{query}'


def _host(url: str) -> str:
    return urlsplit(url).netloc.removeprefix('www.')


def _pairs(urls: Iterable[object], titles: Iterable[object]) -> list[tuple[str, str]]:
    shown = list(titles)
    out: list[tuple[str, str]] = []
    for index, raw in enumerate(urls):
        url = normalise_url(raw)
        if url is None or is_feed_url(url):
            continue
        title = shown[index] if index < len(shown) else ''
        out.append((url, ' '.join(title.split()) if isinstance(title, str) else ''))
    return out


def _deduped(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    kept: dict[str, tuple[str, str]] = {}
    for url, title in pairs:
        key = _page_key(url)
        held = kept.get(key)
        if held is None:
            kept[key] = (url, title)
            continue
        better_url = url if held[0].startswith('http:') and url.startswith('https:') else held[0]
        kept[key] = (better_url, held[1] or title)
    return list(kept.values())


def clean_citations(urls: Iterable[object], titles: Iterable[object] = ()) -> tuple[list[str], list[str]]:
    """``(urls, titles)`` cleaned (module docstring): aligned by index, https first, at most ``MAX_CITATIONS``."""
    pairs = _deduped(_pairs(urls, titles))
    ranked = sorted(pairs, key=lambda pair: not pair[0].startswith('https:'))[:MAX_CITATIONS]
    return [url for url, _ in ranked], [title or _host(url) for url, title in ranked]
