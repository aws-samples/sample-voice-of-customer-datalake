"""Radar brands: which brands Radar tracks, and where their reviews come from (docs/radar.md).

THE BRAND LIST (Administration -> Sources -> Radar) is the source of truth. It is
stored in the ``voc-radar`` table at ``SETTINGS#radar`` / ``brands``::

    {brands: [{label: "Acme", domains: ["acme.com"], language?: "pl", feed_urls?: [...], search_terms?: [...],
               exclude_terms?: [...]}], updated_at, updated_by}

(a sort key apart from ``SETTINGS#radar`` / ``config``, so saving the scan
settings never clobbers it). A brand's key is ``brand_key(label)``, the table's
partition slug. The release scan searches the news of every listed brand, and a
scraper / web-review target / app connector / CSV upload naming a brand key in
its ``radar_brand`` sends its reviews to that brand (the ingestor stamps the
queue message with ``radar_brand_key``; the processor resolves it here).

LEGACY: before the list, a source profile (``SETTINGS#sources``) became a Radar
source when an admin ticked "Radar source" and named the brand::

    radar_brand:   "Acme"                    the tracked brand's display name
    radar_domains: ["acme.com", "acme.dev"]  its own sites (release search, official links)

Those profiles still work (``radar_brands``): the EFFECTIVE brands are the list,
then every profile brand merged into it by key (``effective_brands``), so a
profile brand's key stays valid whether or not it is ever listed.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final, TypeGuard

from shared.radar_brand_citations import BrandMatch
from shared.radar_brand_fields import brand_language, effective_language, feed_urls
from shared.radar_brand_terms import EXCLUDE_TERMS, SEARCH_TERMS, brand_terms

__all__ = [
    'BRAND_LIST_KEY',
    'RadarBrand',
    'brand_key',
    'brand_view',
    'effective_brands',
    'load_brand_list',
    'radar_brand_setting',
    'radar_profile_fields',
    'radar_stamp',
    'validate_brand_list',
]

MAX_BRAND_CHARS: Final = 64
MAX_BRAND_DOMAINS: Final = 10
MAX_LIST_BRANDS: Final = 25
BRAND_LIST_KEY: Final = {'pk': 'SETTINGS#radar', 'sk': 'brands'}
#: Keys no listed brand may take: ``all`` names the Radar page's "All brands" view (GET /radar/all).
RESERVED_BRAND_KEYS: Final = frozenset({'all'})
#: A brand key as a scraper / connector config and a queue message carry it (``IngestMessage.radar_brand_key``).
_BRAND_KEY_RE: Final = re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')
# Letters (any script), digits, spaces and a few name punctuation marks.
_BRAND_RE: Final = re.compile(r"^[\w][\w .&'+-]{0,63}\Z")
# Same shape as shared.web_search's filter check; kept here so source profiles never import the search client.
DOMAIN_RE: Final = re.compile(r'^(?=.{1,253}\Z)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z')
_SLUG_DROP: Final = re.compile(r'[^\w]+')
ORIGIN_LIST: Final = 'list'
ORIGIN_PROFILE: Final = 'profile'


@dataclass(frozen=True)
class RadarBrand:
    """One tracked brand: its key (partition slug), label, own domains, the profiles naming it, and its origin.

    ``origin`` is ``'list'`` for a brand on the brand list, ``'profile'`` for one only a legacy
    source profile names.
    """

    key: str
    label: str
    domains: tuple[str, ...] = ()
    sources: tuple[str, ...] = ()
    origin: str = ORIGIN_PROFILE
    #: The stored news-scan language (None = auto) and feed URLs (shared/radar_brand_fields.py).
    language: str | None = None
    feed_urls: tuple[str, ...] = ()
    #: Words added to the general news queries, and words that drop a result (shared/radar_brand_terms.py).
    search_terms: tuple[str, ...] = ()
    exclude_terms: tuple[str, ...] = ()

    @property
    def effective_language(self) -> str:
        return effective_language(self.language, self.domains)

    @property
    def citation_match(self) -> BrandMatch:
        """What a cited page must be on or name to be shown under this brand (shared/radar_brand_citations.py)."""
        return BrandMatch(label=self.label, terms=self.search_terms, domains=self.domains)


def brand_view(brand: RadarBrand) -> dict[str, Any]:
    """The API view of a brand: ``{key, label, domains, sources, origin, language, effective_language, feed_urls,
    search_terms, exclude_terms}``.

    ``sources``: the legacy profile ids naming the brand. Only a VISIBLE brand reaches the API, and a
    brand is visible only when the caller is admitted to every one of them (radar_handler._visible_brands).
    """
    return {'key': brand.key, 'label': brand.label, 'domains': list(brand.domains), 'sources': list(brand.sources),
            'origin': brand.origin, 'language': brand.language, 'effective_language': brand.effective_language,
            'feed_urls': list(brand.feed_urls), 'search_terms': list(brand.search_terms),
            'exclude_terms': list(brand.exclude_terms)}


def brand_key(name: str) -> str:
    """The brand's stable key: lower-cased, every run of non-word characters folded to one '-'."""
    return _SLUG_DROP.sub('-', name.strip().lower()).strip('-_')[:MAX_BRAND_CHARS]


def is_brand_key(value: object) -> TypeGuard[str]:
    """Whether ``value`` is a brand key a config or a queue message may carry."""
    return isinstance(value, str) and _BRAND_KEY_RE.fullmatch(value) is not None


def _brand_name(raw: object, what: str, field: str = 'radar_brand') -> str:
    if not isinstance(raw, str):
        raise ValueError(f'{what} {field} must be a string')
    name = ' '.join(raw.split())
    if not _BRAND_RE.match(name) or not brand_key(name):
        raise ValueError(
            f'{what} {field} must be 1-{MAX_BRAND_CHARS} characters of letters, digits, '
            "spaces or . & ' + -")
    return name


def _domain(raw: object, what: str, field: str) -> str:
    host = str(raw or '').strip().lower().removeprefix('https://').removeprefix('http://')
    host = host.split('/', 1)[0].removeprefix('www.')
    if not DOMAIN_RE.match(host):
        raise ValueError(f'{what} {field} entry is not a domain name: {str(raw)[:80]!r}')
    return host


def _domains(raw: object, what: str, field: str = 'radar_domains') -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f'{what} {field} must be a list')
    if len(raw) > MAX_BRAND_DOMAINS:
        raise ValueError(f'{what} {field} may hold at most {MAX_BRAND_DOMAINS} domains')
    out: list[str] = []
    for entry in raw:
        host = _domain(entry, what, field)
        if host not in out:
            out.append(host)
    return out


def radar_profile_fields(entry: Mapping[str, Any], what: str) -> dict[str, Any]:
    """The normalised Radar fields of one profile: ``{}`` for an ordinary source.

    A blank or absent ``radar_brand`` means "not a Radar source"; domains without
    a brand are refused (they would silently do nothing).
    """
    raw_brand = entry.get('radar_brand')
    domains = _domains(entry.get('radar_domains'), what)
    if raw_brand is None or (isinstance(raw_brand, str) and not raw_brand.strip()):
        if domains:
            raise ValueError(f'{what} radar_domains need a radar_brand')
        return {}
    return {'radar_brand': _brand_name(raw_brand, what), 'radar_domains': domains}


def radar_brands(profiles: Iterable[Mapping[str, Any]]) -> list[RadarBrand]:
    """Every brand some legacy profile tracks, in first-seen order, its domains and sources merged."""
    merged: dict[str, dict[str, Any]] = {}
    for profile in profiles:
        name = profile.get('radar_brand')
        if not isinstance(name, str) or not brand_key(name):
            continue
        entry = merged.setdefault(brand_key(name), {'label': name, 'domains': [], 'sources': []})
        entry['domains'].extend(d for d in profile.get('radar_domains') or [] if d not in entry['domains'])
        entry['sources'].append(str(profile.get('id', '')))
    return [
        RadarBrand(key=key, label=entry['label'], domains=tuple(entry['domains']), sources=tuple(entry['sources']))
        for key, entry in merged.items()
    ]


# ---------------------------------------------------------------------------
# The brand list
# ---------------------------------------------------------------------------

def _list_entry(raw: object, number: int) -> dict[str, Any]:
    what = f'Brand {number}'
    if not isinstance(raw, Mapping):
        raise ValueError(f'{what} must be an object with a label and domains')
    label = _brand_name(raw.get('label'), what, 'label')
    key = brand_key(label)
    if not is_brand_key(key):
        raise ValueError(f'{what} label needs Latin letters or digits (a-z, 0-9) to make its key')
    if key in RESERVED_BRAND_KEYS:
        raise ValueError(f'{what} label "{label}" is reserved for the Radar "All brands" view: choose another label')
    entry: dict[str, Any] = {'label': label, 'domains': _domains(raw.get('domains'), what, 'domains')}
    # Stored only when set, so a list saved before 5.42 and one saved without them look alike.
    if (language := brand_language(raw.get('language'), what)) is not None:
        entry['language'] = language
    if feeds := feed_urls(raw.get('feed_urls'), what):
        entry['feed_urls'] = feeds
    for field in (SEARCH_TERMS, EXCLUDE_TERMS):
        if terms := brand_terms(raw.get(field), what, field):
            entry[field] = terms
    return entry


def validate_brand_list(body: object) -> list[dict[str, Any]]:
    """The normalised ``[{label, domains, language?, feed_urls?, search_terms?, exclude_terms?}]`` of a ``{brands: [...]}`` body, or ValueError.

    At most ``MAX_LIST_BRANDS`` brands, each key once, at most ``MAX_BRAND_DOMAINS`` domains each.
    """
    if not isinstance(body, Mapping):
        raise ValueError('Request body must be a JSON object')
    raw = body.get('brands')
    if not isinstance(raw, list):
        raise ValueError('brands must be a list')
    if len(raw) > MAX_LIST_BRANDS:
        raise ValueError(f'Radar may track at most {MAX_LIST_BRANDS} brands')
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for number, entry in enumerate(raw, start=1):
        cleaned = _list_entry(entry, number)
        key = brand_key(cleaned['label'])
        if key in seen:
            raise ValueError(f'Brand {number} ({cleaned["label"]}) is already in the list')
        seen.add(key)
        out.append(cleaned)
    return out


def load_brand_list(table: Any) -> list[dict[str, Any]]:
    """The stored brand list (``[]`` when none is saved); ValueError when the stored row is malformed."""
    item = table.get_item(Key=BRAND_LIST_KEY).get('Item')
    if not item:
        return []
    return validate_brand_list({'brands': item.get('brands', [])})


def effective_brands(listed: Iterable[Mapping[str, Any]],
                     profiles: Iterable[Mapping[str, Any]]) -> list[RadarBrand]:
    """The list's brands in list order, then every legacy profile brand, merged by key.

    A listed brand that a profile also names keeps the list's label and gains the
    profile's domains and sources (so a restricted profile still hides it).
    """
    merged: dict[str, dict[str, Any]] = {}
    for entry in listed:
        merged[brand_key(entry['label'])] = {'label': entry['label'], 'domains': list(entry.get('domains') or []),
                                             'sources': [], 'origin': ORIGIN_LIST, 'language': entry.get('language'),
                                             'feed_urls': tuple(entry.get('feed_urls') or ()),
                                             SEARCH_TERMS: tuple(entry.get(SEARCH_TERMS) or ()),
                                             EXCLUDE_TERMS: tuple(entry.get(EXCLUDE_TERMS) or ())}
    for brand in radar_brands(profiles):
        entry = merged.setdefault(brand.key, {'label': brand.label, 'domains': [], 'sources': [],
                                              'origin': ORIGIN_PROFILE})
        entry['domains'].extend(d for d in brand.domains if d not in entry['domains'])
        entry['sources'].extend(brand.sources)
    return [
        RadarBrand(key=key, label=entry['label'], domains=tuple(entry['domains']),
                   sources=tuple(entry['sources']), origin=entry['origin'], language=entry.get('language'),
                   feed_urls=entry.get('feed_urls', ()), search_terms=entry.get(SEARCH_TERMS, ()),
                   exclude_terms=entry.get(EXCLUDE_TERMS, ()))
        for key, entry in merged.items()
    ]


# ---------------------------------------------------------------------------
# ``radar_brand`` on a scraper / web-review target / app connector / CSV upload
# ---------------------------------------------------------------------------

def radar_brand_setting(raw: object, what: str = 'radar_brand') -> str:
    """Save side: the brand key a config names (``''`` = an ordinary source), or ValueError (client-safe)."""
    if raw is None:
        return ''
    if not isinstance(raw, str):
        raise ValueError(f'{what} must be a Radar brand key')
    value = raw.strip()
    if value and not is_brand_key(value):
        raise ValueError(f'{what} must be a Radar brand key: 1-64 lower-case letters, digits, "_" or "-"')
    return value


def radar_stamp(raw: object) -> dict[str, str]:
    """Ingest side: ``{'radar_brand_key': key}`` for a config naming a brand, ``{}`` for an ordinary source.

    The value goes out as stored, never dropped: a hand-edited config with a malformed
    key fails the queue schema (SQS retries, then the DLQ) instead of sending another
    brand's reviews into our own feedback.
    """
    if raw is None or raw is False:
        return {}
    value = raw.strip() if isinstance(raw, str) else str(raw)
    return {'radar_brand_key': value} if value else {}
