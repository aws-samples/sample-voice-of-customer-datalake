"""Remembers what each review page looked like, so an unchanged page costs no model call.

One watermark per page: ``{prefix}_page_{sha256(normalised page URL)[:16]}`` holding
the sha256 of the page's JSON-LD blocks and visible text. An incremental read treats
an unchanged page as having no new review (and so stops there, as it does on any
page without one) without extracting it. The check applies to every page alike: a
JSON-LD page costs no model call anyway, so skipping it only saves parsing.

The hash is written only after the page's reviews were taken (``remember``), and
only when it changed: at most one watermark write per page, none for a page read
again unchanged.
"""

import hashlib
from collections.abc import Callable
from typing import Final
from urllib.parse import urlparse, urlunparse

from page_reader import PageSnapshot

#: Hex characters of the URL hash in the watermark name.
URL_HASH_CHARS: Final = 16
#: Separates the hashed parts so ``['a', 'b']`` + ``'c'`` never hashes like ``['ab']`` + ``'c'``.
_SEPARATOR: Final = '\x00'


def normalised_url(url: str) -> str:
    """*url* with its scheme and host lower-cased and its fragment dropped (the path and query decide the page)."""
    parts = urlparse(url)
    return urlunparse(parts._replace(scheme=parts.scheme.lower(), netloc=parts.netloc.lower(), fragment=''))


def page_digest(snapshot: PageSnapshot) -> str:
    material = _SEPARATOR.join((*snapshot.jsonld, snapshot.text))
    return hashlib.sha256(material.encode()).hexdigest()


class PageCache:
    """The page hashes of one target, read through *get* and written through *put* (the watermarks)."""

    def __init__(self, prefix: str, get: Callable[[str], str | None], put: Callable[[str, str], None]):
        self._prefix = prefix
        self._get = get
        self._put = put
        self._stored: dict[str, str | None] = {}

    def key(self, url: str) -> str:
        digest = hashlib.sha256(normalised_url(url).encode()).hexdigest()[:URL_HASH_CHARS]
        return f'{self._prefix}_page_{digest}'

    def _stored_digest(self, key: str) -> str | None:
        if key not in self._stored:
            self._stored[key] = self._get(key)
        return self._stored[key]

    def unchanged(self, snapshot: PageSnapshot) -> bool:
        """Whether *snapshot* is exactly the page last remembered at its URL."""
        return self._stored_digest(self.key(snapshot.url)) == page_digest(snapshot)

    def remember(self, snapshot: PageSnapshot) -> None:
        """Record *snapshot* as read (its reviews were taken); no write when it is unchanged."""
        key = self.key(snapshot.url)
        digest = page_digest(snapshot)
        if self._stored_digest(key) != digest:
            self._put(key, digest)
            self._stored[key] = digest
