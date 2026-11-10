"""Which citations of a Radar release are about the brand at all (docs/radar.md → "Citations").

The extractor model is asked for ONE company's news, but a search for a common word returns
pages about something else, and the model sometimes cites one of them under a real release (an
article about another company's AI controls filed as a source of the brand's "Loops"). A citation
is kept only when:

- it is **official**: its host is one of the brand's own domains (or a subdomain of one); or
- it **names the brand**: its title, or its URL's host and path, contains the brand label or one
  of its configured ``search_terms`` (``shared.radar_brand_terms``) as whole words.

"Whole words" is checked on folded text: case-folded, accents dropped (``Café`` = ``cafe``) and
every run of characters that is not a letter or a digit (``-``, ``_``, ``.``, ``/``, ``&``,
spaces) read as ONE space. So ``Example Air`` matches ``example-air.example/blog/...`` and the
title "EXAMPLE AIR adds routes", and ``Globex`` does NOT match ``globexia.example`` (another
name). A multi-word name also matches written as one word (``exampleair.example``).

A brand whose label and terms fold to nothing (punctuation only) keeps every citation: no rule
can tell its pages apart. The scan applies the rule before a candidate is filed (a candidate left
with no citation is not filed) and the API applies it again on the way out (rows stored before the
rule keep their record, with only the citations that pass). Pure functions; never raises.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from typing import Final
from urllib.parse import urlsplit

__all__ = ['BrandMatch', 'brand_citations', 'keeps_citation', 'on_domains']

_NOT_WORD: Final = re.compile(r'[\W_]+')


@dataclass(frozen=True)
class BrandMatch:
    """What tells a brand's pages apart: its label, its search terms and its own domains."""

    label: str
    terms: tuple[str, ...] = ()
    domains: tuple[str, ...] = ()


def _folded(text: str) -> str:
    """``text`` case-folded, accents dropped, every non-alphanumeric run one space, padded with spaces."""
    decomposed = unicodedata.normalize('NFKD', text.casefold())
    plain = ''.join(char for char in decomposed if not unicodedata.combining(char))
    return f' {_NOT_WORD.sub(" ", plain).strip()} '


@lru_cache(maxsize=64)
def _names(match: BrandMatch) -> tuple[str, ...]:
    """The folded whole-word forms to look for (each padded): the label, its terms, and multi-word ones joined.

    Cached per brand: a page view folds the same names for every citation of every record.
    """
    forms: list[str] = []
    for name in (match.label, *match.terms):
        folded = _folded(name)
        if folded.strip():
            forms.append(folded)
            if ' ' in folded.strip():
                forms.append(f' {folded.replace(" ", "")} ')
    return tuple(forms)


def _host(url: str) -> str:
    try:
        host = urlsplit(url.strip()).hostname or ''
    except ValueError:
        return ''
    return host.lower().removeprefix('www.')


def on_domains(url: object, domains: Iterable[str]) -> bool:
    """True when ``url``'s host is one of ``domains`` or a subdomain of one (an official page)."""
    host = _host(url) if isinstance(url, str) else ''
    return bool(host) and any(host == domain or host.endswith(f'.{domain}') for domain in domains)


def _url_text(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return ''
    return f'{parts.hostname or ""} {parts.path}'


def names_brand(text: object, match: BrandMatch) -> bool:
    """True when ``text`` contains the brand label or one of its terms as whole words (module docstring)."""
    if not isinstance(text, str) or not text.strip():
        return False
    haystack = _folded(text)
    return any(name in haystack for name in _names(match))


def keeps_citation(url: object, title: object, match: BrandMatch) -> bool:
    """Whether a citation stays: official, or its title or URL (host + path) names the brand."""
    if not isinstance(url, str):
        return False
    if not _names(match) or on_domains(url, match.domains):
        return True
    return names_brand(title, match) or names_brand(_url_text(url), match)


def brand_citations(urls: Iterable[object], titles: Iterable[object],
                    match: BrandMatch) -> tuple[list[str], list[str]]:
    """``(urls, titles)`` (aligned by index) without the citations ``keeps_citation`` drops, order kept."""
    shown = list(titles)
    kept_urls: list[str] = []
    kept_titles: list[str] = []
    for index, url in enumerate(urls):
        title = shown[index] if index < len(shown) else ''
        if isinstance(url, str) and keeps_citation(url, title, match):
            kept_urls.append(url)
            kept_titles.append(title if isinstance(title, str) else '')
    return kept_urls, kept_titles
