"""Which cited pages are listings, not one story (docs/radar.md → "One record per story").

A Radar release merges into a record that cites the SAME PAGE (``radar_releases._same_page``). That is
right for an article and wrong for a page that lists many stories: a news index, a blog front page, a
category or tag page, a paginated archive. Two different stories that both cite
``example.com/aktualnosci/programy.html`` must stay two records. A listing page never decides a
same-page merge (the embedding match still may). Rules, on the normalised URL (``radar_citations``):

1. **No path**: the site's home page (``/`` without a query; ``/?p=123`` is one post).
2. **A page query**: a ``page`` / ``paged`` / ``offset`` / ``start`` parameter (not ``p``: WordPress's
   ``?p=123`` is one post).
3. **A section path**: the LAST segment (its ``.html`` / ``.php`` / … extension dropped) is a
   section word (``LISTING_WORDS``: news, blog, press, aktualnosci, novinky, … in the Radar languages).
4. **A taxonomy path**: any segment is ``category`` / ``tag`` / ``topic`` / ``author`` / ``archive`` /
   ``page`` (and their plurals or local words), as in ``/category/hr/`` or ``/blog/page/2``.
5. **A date archive**: the path ends in a year or a year and month (``/2026/`` or ``/2026/10/``).
6. **No slug under a section**: the last segment is ONE plain word (no ``-``, ``_`` or digit) under a
   section word (``/aktualnosci/programy.html``, ``/news/products``). An article's slug almost always has
   several words or an id. A one-word article under a section (``/blog/loops``) loses only the
   same-page shortcut.
7. **A hub**: a page that two or more stored records of the brand already cite
   (``HUB_MIN_RECORDS``) is an index, whatever its path: a third story does not merge on it.

Rules 1-6 are ``is_listing_page``; rule 7 needs the stored records: ``radar_releases`` applies it to
a merge, and ``hub_pages`` to the records an API read returns. ``index_titles`` blanks the title of
an index citation on the way out (its stored title is whichever story headed the page that day).
Pure functions; never raises.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Collection, Iterable
from typing import Final
from urllib.parse import parse_qsl, urlsplit

from shared.radar_citations import normalise_url, page_key

__all__ = ['HUB_MIN_RECORDS', 'hub_pages', 'index_titles', 'is_listing_page']

#: A page this many stored records of one brand already cite is an index (rule 7).
HUB_MIN_RECORDS: Final = 2
# Not ``p``: WordPress's ``?p=123`` is ONE post.
_PAGE_PARAMS: Final = frozenset({'page', 'paged', 'offset', 'start'})
#: Section words (rule 3), in English and the Radar scan's languages (shared/radar_brand_fields.LANGUAGES).
LISTING_WORDS: Final = frozenset({
    'news', 'blog', 'blogs', 'press', 'pressroom', 'press-releases', 'press-release', 'newsroom', 'media',
    'articles', 'stories', 'updates', 'announcements', 'changelog', 'release-notes', 'releases', 'whats-new',
    'events', 'insights', 'resources', 'all',
    'aktualnosci', 'wiadomosci', 'komunikaty', 'prasa',  # pl
    'aktuality', 'novinky', 'zpravy', 'tiskove-zpravy', 'spravy',  # cs, sk
    'nachrichten', 'neuigkeiten', 'aktuelles', 'presse', 'pressemitteilungen',  # de
    'actualites', 'actualite', 'communiques',  # fr
    'noticias', 'novedades', 'prensa', 'sala-de-prensa',  # es
    'notizie', 'novita', 'comunicati-stampa', 'stampa',  # it
    'noticia', 'novidades', 'imprensa',  # pt
    'nieuws', 'pers',  # nl
    'nyheter', 'pressmeddelanden', 'nyheder', 'presse-meldinger',  # sv, da, no
    'uutiset', 'tiedotteet', 'ajankohtaista',  # fi
    'hirek', 'sajto', 'stiri', 'noutati', 'comunicate',  # hu, ro
})
#: Taxonomy segments (rule 4).
TAXONOMY_WORDS: Final = frozenset({
    'category', 'categories', 'tag', 'tags', 'topic', 'topics', 'author', 'authors', 'archive', 'archives', 'page',
    'kategoria', 'kategorie', 'tagi', 'archiwum', 'strona', 'stitky', 'archiv',
    'categorie', 'categoria', 'etiqueta', 'etiquette', 'thema', 'themen',
})
_EXTENSION: Final = re.compile(r'\.(?:s?html?|php|aspx?|jsp)\Z')
_YEAR: Final = re.compile(r'(?:19|20)\d{2}\Z')
_MONTH: Final = re.compile(r'(?:0?[1-9]|1[0-2])\Z')
_ONE_WORD: Final = re.compile(r'[^\W\d_]+\Z')


def _segments(path: str) -> list[str]:
    segments = [segment for segment in path.lower().split('/') if segment]
    if segments:
        segments[-1] = _EXTENSION.sub('', segments[-1])
    return segments


def _date_archive(segments: list[str]) -> bool:
    if segments and _YEAR.match(segments[-1]):
        return True
    return len(segments) >= 2 and _YEAR.match(segments[-2]) is not None and _MONTH.match(segments[-1]) is not None


def _listing_path(segments: list[str]) -> bool:
    last = segments[-1]
    no_slug = len(segments) >= 2 and segments[-2] in LISTING_WORDS and _ONE_WORD.match(last) is not None
    return (last in LISTING_WORDS or any(segment in TAXONOMY_WORDS for segment in segments)
            or _date_archive(segments) or no_slug)


def is_listing_page(url: object) -> bool:
    """True when ``url`` is a listing / index / category page (rules 1-6 of the module docstring)."""
    normalised = normalise_url(url)
    if normalised is None:
        return False
    parts = urlsplit(normalised)
    if any(name.lower() in _PAGE_PARAMS for name, _ in parse_qsl(parts.query, keep_blank_values=True)):
        return True
    segments = _segments(parts.path)
    if not segments:
        # The home page; with a query (``/?p=123``) it is a CMS's link to one post.
        return not parts.query
    return _listing_path(segments)


def hub_pages(citations: Iterable[Iterable[object]]) -> set[str]:
    """The pages (``page_key``) at least ``HUB_MIN_RECORDS`` of the given records' citation lists cite (rule 7)."""
    counts = Counter(key for urls in citations for key in {page_key(url) for url in urls} if key is not None)
    return {key for key, count in counts.items() if count >= HUB_MIN_RECORDS}


def index_titles(urls: Iterable[object], titles: Iterable[object], hubs: Collection[str] = ()) -> list[str]:
    """``titles`` (aligned with ``urls``) with ``''`` for every citation of an index page.

    An index page (a listing, rules 1-6, or a hub, rule 7: ``hubs``) has no title of its own: the
    title search stored is whatever entry headed the page that day, so every record citing a
    changelog index read "Coding sessions on mobile". ``''`` makes the page show the link's host
    and path instead. A story page keeps its title.
    """
    shown = list(titles)
    out: list[str] = []
    for index, url in enumerate(urls):
        title = shown[index] if index < len(shown) else ''
        index_page = is_listing_page(url) or page_key(url) in hubs
        out.append('' if index_page or not isinstance(title, str) else title)
    return out
