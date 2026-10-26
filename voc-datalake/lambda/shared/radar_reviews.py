"""One Radar brand's reviews, newest first, filtered and paged (docs/radar.md).

``GET /radar/brands/{brand}/reviews`` reads the month partitions of ``shared.radar_store``
(``RADAR#{brand}#ITEMS#{YYYY-MM}``, sk ``{radar_day}#{feedback_id}``) from the newest
month down, filters in code (category / subcategory / sentiment and the caller's scope)
and returns at most ``limit`` reviews with an opaque ``next_cursor``.

The cursor is base64url JSON of the key of the last review returned (or of the last
review read, when the per-request read budget ran out first), so the next page starts
right after it. It is validated against the brand and the window: a forged or stale
cursor is a ``ValueError`` (the handler's 400), never a read of another partition.

Every free text leaves PII-redacted (pattern redaction, like the theme quotes) and the
author / email fields are never part of a review view.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.conditions import Key

from shared import category_access
from shared.api import validate_int
from shared.category_access import CategoryScope
from shared.dynamo_paging import iter_query
from shared.pii_redaction import redact_text
from shared.radar_store import SENTIMENT_LABELS, item_partitions, marker_key, radar_day

__all__ = [
    'ReviewFilter',
    'distinct_reviews',
    'review_detail_view',
    'reviews_page',
    'same_review_key',
    'scope_admits',
    'stored_review',
    'written_day',
]

DEFAULT_LIMIT: Final = 25
MAX_LIMIT: Final = 50
# At most this many stored reviews are read per request; a sparse filter then pages on.
MAX_READ: Final = 1000
QUERY_PAGE: Final = 200
MAX_TEXT_CHARS: Final = 5000
MAX_SHORT_CHARS: Final = 500
MAX_CURSOR_CHARS: Final = 1024
MAX_FILTER_CHARS: Final = 200
DAY_FORMAT_ERROR: Final = 'day must be a YYYY-MM-DD date'
_SK_PATTERN: Final = re.compile(r'(\d{4}-\d{2}-\d{2})#.+')
_DAY_PATTERN: Final = re.compile(r'\d{4}-\d{2}-\d{2}')


@dataclass(frozen=True)
class ReviewFilter:
    """What the caller asked for. ``subcategory``: None = any, ``''`` = only reviews without one."""

    category: str | None = None
    subcategory: str | None = None
    sentiment: str | None = None

    def __post_init__(self) -> None:
        if self.sentiment is not None and self.sentiment not in SENTIMENT_LABELS:
            raise ValueError(f"sentiment must be one of {', '.join(SENTIMENT_LABELS)}")

    def matches(self, item: Mapping[str, Any]) -> bool:
        """True when ``item`` passes every filter that is set."""
        if self.category is not None and category_access.item_category(item) != self.category:
            return False
        if self.subcategory is not None and str(item.get('subcategory') or '') != self.subcategory:
            return False
        return self.sentiment is None or item.get('sentiment_label') == self.sentiment


def encode_cursor(key: Mapping[str, Any]) -> str:
    """The opaque cursor of a stored review's key (base64url JSON, no padding)."""
    raw = json.dumps({'pk': str(key['pk']), 'sk': str(key['sk'])}, separators=(',', ':'))
    return base64.urlsafe_b64encode(raw.encode('utf-8')).decode('ascii').rstrip('=')


def _cursor_json(cursor: str) -> object:
    if not cursor or len(cursor) > MAX_CURSOR_CHARS:
        raise ValueError('cursor is not valid')
    try:
        raw = base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4))
        return json.loads(raw.decode('utf-8'))
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValueError('cursor is not valid') from exc


def decode_cursor(cursor: str, brand: str, start: date, end: date) -> dict[str, str]:
    """The ``{pk, sk}`` a cursor carries; ``ValueError`` unless it is a review key of ``brand`` in the window."""
    value = _cursor_json(cursor)
    if not isinstance(value, dict) or set(value) != {'pk', 'sk'}:
        raise ValueError('cursor is not valid')
    pk, sk = value['pk'], value['sk']
    match = _SK_PATTERN.fullmatch(sk) if isinstance(sk, str) else None
    if not isinstance(pk, str) or match is None or pk not in item_partitions(brand, start, end):
        raise ValueError('cursor is not valid')
    day = match.group(1)
    if not pk.endswith(f'#{day[:7]}') or not start.isoformat() <= day <= end.isoformat():
        raise ValueError('cursor is not valid')
    return {'pk': pk, 'sk': sk}


def _stored(table: Any, brand: str, start: date, end: date, after: Mapping[str, str] | None) -> Iterator[dict]:
    """``brand``'s reviews dated ``start``..``end``, newest first, starting after ``after``."""
    low, high = start.isoformat(), f'{end.isoformat()}#~'
    partitions = item_partitions(brand, start, end)
    if after is not None:
        partitions = partitions[partitions.index(after['pk']):]
    for pk in partitions:
        kwargs: dict[str, Any] = {
            'KeyConditionExpression': Key('pk').eq(pk) & Key('sk').between(low, high),
            'ScanIndexForward': False, 'Limit': QUERY_PAGE,
        }
        if after is not None and pk == after['pk']:
            kwargs['ExclusiveStartKey'] = dict(after)
        yield from iter_query(table, kwargs)


def _key(item: Mapping[str, Any]) -> dict[str, str]:
    return {'pk': str(item['pk']), 'sk': str(item['sk'])}


def written_day(item: Mapping[str, Any]) -> str:
    """The day the review was WRITTEN: ``radar_day``, or (a row stored before it existed, keyed by its
    import day) the same rule computed from ``source_created_at`` and ``date``."""
    stored = item.get('radar_day')
    if isinstance(stored, str) and _DAY_PATTERN.fullmatch(stored):
        return stored
    if isinstance(item.get('date'), str) and _DAY_PATTERN.fullmatch(str(item['date'])[:10]):
        return radar_day({**item, 'date': str(item['date'])[:10]})
    return str(item['sk'])[:10]


def same_review_key(item: Mapping[str, Any]) -> tuple[str, str]:
    """Written day + whitespace/case-folded text: two stored copies of one review (a second import) share it.

    A review with no text (rating only) is keyed by its id instead, so two different
    text-less reviews written the same day are never collapsed into one.
    """
    text = ' '.join(str(item.get('original_text') or item.get('normalized_text') or '').split()).casefold()
    return written_day(item), text or f"id:{item.get('feedback_id') or item.get('sk') or ''}"


def _walk(table: Any, brand: str, admits: Callable[[Mapping[str, Any]], bool], start: date, end: date,
          after: Mapping[str, str] | None) -> Iterator[tuple[int, dict, bool]]:
    """``(read, item, listed)`` for every stored review, newest first: ``listed`` when ``admits``
    accepts it and it is not a second copy of a review already listed. THE one reading the list
    and every count share."""
    seen: set[tuple[str, str]] = set()
    for read, item in enumerate(_stored(table, brand, start, end, after), start=1):
        key = same_review_key(item)
        listed = admits(item) and key not in seen
        if listed:
            seen.add(key)
        yield read, item, listed


def list_reviews(table: Any, brand: str, *, admits: Callable[[Mapping[str, Any]], bool],
                 start: date, end: date, limit: int,
                 after: Mapping[str, str] | None = None) -> tuple[list[dict], str | None]:
    """Up to ``limit`` stored reviews that ``admits`` accepts, newest first, and the next cursor (None at the end).

    One review past ``limit`` is looked for, so a cursor is returned only when a next
    page has something in it, or when ``MAX_READ`` reviews were read first. The same review
    stored twice (same text, same written day: a file imported twice) is listed once per page;
    the stored copies are kept (the list collapses them, nothing is deleted).
    """
    found: list[dict] = []
    for read, item, listed in _walk(table, brand, admits, start, end, after):
        if listed:
            if len(found) == limit:
                return found, encode_cursor(_key(found[-1]))
            found.append(item)
        if read >= MAX_READ:
            return found, encode_cursor(_key(item))
    return found, None


def distinct_reviews(table: Any, brand: str, *, admits: Callable[[Mapping[str, Any]], bool],
                     start: date, end: date, cap: int) -> tuple[list[dict], bool]:
    """Every distinct review ``admits`` accepts in the window, newest first, and whether the walk finished.

    The SAME walk as ``list_reviews``, so a count built from these agrees with the list
    (``shared.radar_counts``). ``False`` once ``cap`` stored reviews were read without
    reaching the end.
    """
    found: list[dict] = []
    for read, item, listed in _walk(table, brand, admits, start, end, None):
        if read > cap:
            return found, False
        if listed:
            found.append(item)
    return found, True


def scope_admits(scope: CategoryScope, wanted: ReviewFilter) -> Callable[[Mapping[str, Any]], bool]:
    """The item test for one request: the caller's scope, then the filters."""
    return lambda item: category_access.admits_item(scope, item) and wanted.matches(item)


def _redacted(value: object, limit: int) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return redact_text(value).text[:limit]


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    return float(value)


def _web_url(value: object) -> str | None:
    return value if isinstance(value, str) and value.startswith(('https://', 'http://')) else None


def _param(params: Mapping[str, str], name: str) -> str | None:
    """A filter value: None when absent or blank; ``ValueError`` past ``MAX_FILTER_CHARS``."""
    value = (params.get(name) or '').strip()
    if len(value) > MAX_FILTER_CHARS:
        raise ValueError(f'{name} is too long')
    return value or None


def _subcategory(params: Mapping[str, str]) -> str | None:
    """None = any; present but blank = only reviews without a subcategory."""
    if 'subcategory' not in params:
        return None
    return _param(params, 'subcategory') or ''


@dataclass(frozen=True)
class _ReadRange:
    """The stored-key days to read and, for a ``day`` request, the one WRITTEN day to keep."""

    start: date
    end: date
    written: str | None = None

    def admits(self, item: Mapping[str, Any]) -> bool:
        """True for every review over the window, or only for those written on the asked ``day``."""
        return self.written is None or written_day(item) == self.written


def _narrowed(params: Mapping[str, str], start: date, end: date) -> _ReadRange:
    """The whole window, or the one ``day`` asked for (a ``YYYY-MM-DD`` inside the window).

    A ``day`` keeps the reviews WRITTEN that day (``written_day``, the day the list and the
    trend show), not the reviews whose key carries it: a row stored before ``radar_day``
    is keyed by its IMPORT day, which is the written day or later. So the read runs from
    ``day`` to the window's end and filters on the written day. Keying by the stored day
    made the newest day (the import day) return every legacy review (verify4 V5).
    """
    raw = _param(params, 'day')
    if raw is None:
        return _ReadRange(start, end)
    if _DAY_PATTERN.fullmatch(raw) is None:
        raise ValueError(DAY_FORMAT_ERROR)
    try:
        day = date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(DAY_FORMAT_ERROR) from exc
    if not start <= day <= end:
        raise ValueError('day must be inside the days window')
    return _ReadRange(day, end, raw)


def reviews_page(table: Any, brand: str, scope: CategoryScope, params: Mapping[str, str],
                 window: tuple[date, date]) -> dict[str, Any]:
    """``{reviews, next_cursor, limit}`` for one ``GET /radar/brands/{brand}/reviews`` (``ValueError`` = 400).

    A category the caller may not see is an empty page, never its reviews.
    """
    wanted = ReviewFilter(_param(params, 'category'), _subcategory(params), _param(params, 'sentiment'))
    read = _narrowed(params, *window)
    cursor = _param(params, 'cursor')
    after = decode_cursor(cursor, brand, read.start, read.end) if cursor else None
    limit = validate_int(params.get('limit'), default=DEFAULT_LIMIT, min_val=1, max_val=MAX_LIMIT)
    if wanted.category is not None and not category_access.admits(scope, wanted.category):
        return {'reviews': [], 'next_cursor': None, 'limit': limit}
    in_scope = scope_admits(scope, wanted)
    items, next_cursor = list_reviews(table, brand, admits=lambda item: read.admits(item) and in_scope(item),
                                      start=read.start, end=read.end, limit=limit, after=after)
    return {'reviews': [review_view(item) for item in items], 'next_cursor': next_cursor, 'limit': limit}


def review_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """One review as the page reads it: redacted texts, no author or email, optional fields only when set."""
    optional = {
        'title': _redacted(item.get('title'), MAX_SHORT_CHARS),
        'quote': _redacted(item.get('direct_customer_quote'), MAX_SHORT_CHARS),
        'rating': _number(item.get('rating')),
        'urgency': item.get('urgency') if isinstance(item.get('urgency'), str) else None,
        'problem_summary': _redacted(item.get('problem_summary'), MAX_SHORT_CHARS),
        'source_url': _web_url(item.get('source_url')),
    }
    return {
        'feedback_id': str(item.get('feedback_id') or ''),
        'day': written_day(item),
        'text': _redacted(item.get('original_text') or item.get('normalized_text'), MAX_TEXT_CHARS) or '',
        'sentiment_label': str(item.get('sentiment_label') or 'neutral'),
        'sentiment_score': _number(item.get('sentiment_score')),
        'category': category_access.item_category(item),
        'subcategory': item.get('subcategory') or None,
        'source_platform': str(item.get('source_platform') or ''),
        **{key: value for key, value in optional.items() if value is not None},
    }


# The enrichment a single review shows on top of its list view (``GET /radar/brands/{brand}/reviews/{id}``).
_DETAIL_TEXT_FIELDS: Final = ('persona_name', 'persona_type', 'journey_stage', 'impact_area',
                              'problem_root_cause_hypothesis')
_DETAIL_PLAIN_FIELDS: Final = ('source_created_at', 'source_channel')
MAX_FEEDBACK_ID_CHARS: Final = 256


def stored_review(table: Any, brand: str, feedback_id: str) -> dict[str, Any] | None:
    """One stored review of ``brand`` by id (through its dedupe marker), or None when absent."""
    if not feedback_id or len(feedback_id) > MAX_FEEDBACK_ID_CHARS:
        return None
    marker = table.get_item(Key=marker_key(brand, feedback_id)).get('Item')
    if not marker or not marker.get('item_pk') or not marker.get('item_sk'):
        return None
    return table.get_item(Key={'pk': str(marker['item_pk']), 'sk': str(marker['item_sk'])}).get('Item')


def review_detail_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """``review_view`` plus the persona / journey / impact / root-cause enrichment, redacted like the rest."""
    extra: dict[str, Any] = {key: _redacted(item.get(key), MAX_SHORT_CHARS) for key in _DETAIL_TEXT_FIELDS}
    extra.update({key: str(item[key])[:MAX_SHORT_CHARS] for key in _DETAIL_PLAIN_FIELDS
                  if isinstance(item.get(key), str) and item[key]})
    # A stored review carries the processor's `original_language` (build_feedback_item); the wire calls it `language`.
    language = item.get('original_language') or item.get('language')
    if isinstance(language, str) and language:
        extra['language'] = language[:MAX_SHORT_CHARS]
    return {**review_view(item), **{key: value for key, value in extra.items() if value is not None}}
