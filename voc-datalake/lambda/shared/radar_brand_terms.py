"""A Radar brand's search terms and exclude terms (docs/radar.md → "Search terms").

Stored on a brand-list entry beside ``label`` and ``domains`` (absent = none)::

    {label: "Example Air", domains: ["example-air.example"], search_terms: ["Example Air Ltd"], exclude_terms: ["air quality"]}

``search_terms`` are words or phrases (a legal name, product names) the news scan adds to its
general web / Exa queries, so a brand whose name holds a common word ("Example Air":
"air") is searched as the company. ``exclude_terms`` drop a search result whose title or
snippet contains one, before any model call; they are also sent to the search provider where it
supports exclusion (the web-search query as ``-"term"``, Exa's ``excludeText``).

At most ``MAX_TERMS`` of each, each 1-``MAX_TERM_CHARS`` characters after whitespace is folded,
de-duplicated without regard to case. A double quote is refused (the scan quotes each term), and so
is a leading ``-`` (a search operator).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

__all__ = [
    'EXCLUDE_TERMS',
    'SEARCH_TERMS',
    'brand_terms',
    'is_excluded',
]

MAX_TERMS: Final = 8
MAX_TERM_CHARS: Final = 60
SEARCH_TERMS: Final = 'search_terms'
EXCLUDE_TERMS: Final = 'exclude_terms'


def _term_problem(term: str) -> str | None:
    if not term:
        return 'is empty'
    if len(term) > MAX_TERM_CHARS:
        return f'is longer than {MAX_TERM_CHARS} characters'
    if any(ord(char) < 32 for char in term):
        return 'contains control characters'
    if '"' in term:
        return 'must not contain double quotes'
    if term.startswith('-'):
        return 'must not start with "-"'
    return None


def brand_terms(raw: object, what: str, field: str) -> list[str]:
    """The cleaned ``field`` list of a brand-list entry (``[]`` when absent), or ValueError (client-safe)."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f'{what} {field} must be a list of words or phrases')
    out: list[str] = []
    seen: set[str] = set()
    for number, entry in enumerate(raw, start=1):
        term = ' '.join(entry.split()) if isinstance(entry, str) else ''
        if (problem := _term_problem(term)) is not None:
            raise ValueError(f'{what} {field} entry {number} {problem}')
        folded = term.casefold()
        if folded not in seen:
            seen.add(folded)
            out.append(term)
    if len(out) > MAX_TERMS:
        raise ValueError(f'{what} may have at most {MAX_TERMS} {field.replace("_", " ")}')
    return out


def is_excluded(result: Mapping[str, Any], terms: Iterable[str]) -> bool:
    """Whether a search result's title or snippet contains one of ``terms`` (case-insensitive)."""
    haystack = f'{result.get("title") or ""}\n{result.get("text") or ""}'.casefold()
    return any(term.casefold() in haystack for term in terms)
