"""One Radar release per feature NAME, at store time and on the way out (docs/radar.md → "One record per story").

The date-window + same-page + embedding match (``radar_releases.store_candidate``) missed records
that carry the very same name: an undated "Agent" found in October and the dated "Agent" of March
were more than ``MERGE_WINDOW_DAYS`` apart, and their summaries embedded differently. Two names
that are equal after ``feature_key`` (case-folded, whitespace collapsed, punctuation stripped at
the ends) are one feature:

- **store time**: a candidate merges into the brand's stored record of that name at ANY date
  (``same_name``), before the window / cosine match;
- **read time**: ``collapse`` folds the API views of one name into one, so rows stored before
  this rule read as one record too (nothing is rewritten). The primary view (``_rank``: official,
  then dated, then the newest release date) gives the feature, date, summary, id and source kind;
  citations are unioned (primary first) and cleaned again; ``mentions`` are summed; ``kind`` is
  the earliest-filed view's (a merge keeps the earlier kind) and ``found_via`` the union.

Pure functions; never raises.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Callable, Iterable, Mapping
from typing import Any, Final

from shared.radar_citations import clean_citations

__all__ = ['OFFICIAL', 'collapse', 'feature_key', 'padded_titles', 'same_name']

#: ``source_kind`` of a record cited on one of the brand's own domains (``radar_releases`` re-uses it).
OFFICIAL: Final = 'official'


def _edge(char: str) -> bool:
    """Punctuation, a symbol or whitespace: stripped from the ends of a name."""
    return char.isspace() or unicodedata.category(char)[0] in ('P', 'S')


def feature_key(feature: object) -> str:
    """``feature`` case-folded, whitespace collapsed, punctuation and symbols stripped at both ends ('' when none)."""
    text = ' '.join(str(feature or '').casefold().split())
    start, end = 0, len(text)
    while start < end and _edge(text[start]):
        start += 1
    while end > start and _edge(text[end - 1]):
        end -= 1
    return text[start:end]


def _rank(view: Mapping[str, Any]) -> tuple[bool, bool, str, str]:
    """Higher is the better primary: official, dated (not approximate), newest release date, newest seen."""
    return (view.get('source_kind') == OFFICIAL, not view.get('date_approximate'),
            str(view.get('release_date') or ''), str(view.get('last_seen') or ''))


def same_name(rows: Iterable[Mapping[str, Any]], feature: str) -> Mapping[str, Any] | None:
    """The best stored record (``_rank``) whose feature is ``feature`` by ``feature_key``, or None."""
    key = feature_key(feature)
    if not key:
        return None
    named = [row for row in rows if feature_key(row.get('feature')) == key]
    return max(named, key=_rank, default=None)


def padded_titles(urls: list[object], titles: Iterable[object]) -> list[object]:
    """``titles`` cut or padded with ``''`` to ``len(urls)``, so a list appended after them stays aligned."""
    shown = list(titles)[:len(urls)]
    return [*shown, *([''] * (len(urls) - len(shown)))]


def _union_citations(group: list[dict[str, Any]]) -> dict[str, list[str]]:
    urls: list[object] = []
    titles: list[object] = []
    for view in group:
        own_urls = list(view.get('urls') or [])
        urls.extend(own_urls)
        titles.extend(padded_titles(own_urls, view.get('titles') or []))
    clean_urls, clean_titles = clean_citations(urls, titles)
    return {'urls': clean_urls, 'titles': clean_titles}


def _folded(group: list[dict[str, Any]], found_via: Callable[..., list[str]]) -> dict[str, Any]:
    primary = max(group, key=_rank)
    earliest = min(group, key=lambda view: str(view.get('first_seen') or ''))
    merged = {
        **primary, **_union_citations(group),
        'mentions': sum(int(view.get('mentions') or 1) for view in group),
        'kind': earliest.get('kind', primary.get('kind')),
        'found_via': found_via(*(view.get('found_via') for view in group)),
    }
    seen = {field: [str(view[field]) for view in group if view.get(field)] for field in ('first_seen', 'last_seen')}
    if seen['first_seen']:
        merged['first_seen'] = min(seen['first_seen'])
    if seen['last_seen']:
        merged['last_seen'] = max(seen['last_seen'])
    return merged


def collapse(views: Iterable[dict[str, Any]], found_via: Callable[..., list[str]]) -> list[dict[str, Any]]:
    """``views`` with every group of one ``feature_key`` folded into one (module docstring), first-seen order kept.

    ``found_via`` unions the groups' ``found_via`` lists (``radar_releases._found_via``, passed in to
    keep the source order in one place). A view without a feature name is never folded.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for position, view in enumerate(views):
        groups.setdefault(feature_key(view.get('feature')) or f'\x00{position}', []).append(view)
    return [group[0] if len(group) == 1 else _folded(group, found_via) for group in groups.values()]
