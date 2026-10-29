"""What happened, counted in code, for exactly the reader group's scope.

Two ways to count, chosen by the scope (the same rule ``/metrics/categories`` uses):

- **Counters** (every source visible): the aggregator's per-category daily partitions
  ``METRIC#daily_category#{c}`` and ``METRIC#category_sentiment#{c}#negative``, read
  only for the categories the scope admits — a hidden category is never read.
- **Items** (a source rule hides something): the counters count every source, so the
  reviews of the window are walked on the date index (bounded by ``MAX_ITEMS``) and
  filtered with ``category_access.admits_item``.

Urgent reviews always come from the urgency index, filtered the same way. Quotes come
from the newest reviews of a category on the date index, admitted item by item and
PII-redacted before they leave this module.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, Key

from shared import category_access
from shared.api import get_raw_categories_config
from shared.category_access import CategoryScope
from shared.dynamo_values import as_count
from shared.indexes import FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_URGENCY_INDEX
from shared.metric_keys import CATEGORY_PREFIX
from shared.pii_redaction import redact_text

WINDOW_DAYS: Final = 7
MAX_ITEMS: Final = 3_000
MAX_URGENT: Final = 200
MAX_QUOTE_CHARS: Final = 240
QUOTES_PER_CATEGORY: Final = 3
#: Reviews read per day when looking for a category's quotes (the filter runs after the read).
QUOTE_PAGE: Final = 200
CATEGORY_SENTIMENT_PREFIX: Final = 'METRIC#category_sentiment#'
_ITEM_FIELDS: Final = 'feedback_id, category, source_platform, sentiment_label, urgency, #date'
_QUOTE_FIELDS: Final = ('direct_customer_quote', 'normalized_text', 'original_text')


@dataclass
class CategoryCounts:
    current: int = 0
    previous: int = 0
    negative_current: int = 0
    negative_previous: int = 0
    #: reviews per day over both windows, ``{YYYY-MM-DD: n}``.
    daily: dict[str, int] = field(default_factory=dict)


@dataclass
class Signals:
    """Counts for the current window (the last ``WINDOW_DAYS`` days, today included) and the one before."""

    today: str
    categories: dict[str, CategoryCounts] = field(default_factory=dict)
    urgent_current: list[dict] = field(default_factory=list)
    urgent_previous: int = 0
    partial: bool = False

    def totals(self) -> CategoryCounts:
        """Every visible category's counts summed (``daily`` left empty)."""
        counts = list(self.categories.values())
        return CategoryCounts(
            current=sum(c.current for c in counts), previous=sum(c.previous for c in counts),
            negative_current=sum(c.negative_current for c in counts),
            negative_previous=sum(c.negative_previous for c in counts),
        )


def _days(now: datetime, count: int, offset: int = 0) -> list[str]:
    """``count`` day strings ending ``offset`` days before ``now``, oldest first."""
    return [(now - timedelta(days=offset + i)).strftime('%Y-%m-%d') for i in reversed(range(count))]


def _partition(table: Any, pk: str, first: str, last: str) -> dict[str, int]:
    page = table.query(KeyConditionExpression=Key('pk').eq(pk) & Key('sk').between(first, last),
                       FilterExpression=Attr('count').exists())
    return {str(item['sk']): as_count(item.get('count')) for item in page.get('Items', [])}


def visible_category_names(aggregates_table: Any, scope: CategoryScope) -> list[str]:
    """The configured categories (plus the ``other`` fallback) the scope admits."""
    names = [str(c['name']) for c in get_raw_categories_config(aggregates_table) if isinstance(c.get('name'), str)]
    if category_access.FALLBACK_CATEGORY not in names:
        names.append(category_access.FALLBACK_CATEGORY)
    return category_access.visible_categories(scope, names)


def _split(daily: Mapping[str, int], current_days: Iterable[str]) -> tuple[int, int]:
    current = set(current_days)
    now_total = sum(n for day, n in daily.items() if day in current)
    return now_total, sum(daily.values()) - now_total


def _from_counters(aggregates_table: Any, names: list[str], days: list[str]) -> dict[str, CategoryCounts]:
    first, last, current = days[0], days[-1], days[WINDOW_DAYS:]
    out: dict[str, CategoryCounts] = {}
    for name in names:
        daily = _partition(aggregates_table, f'{CATEGORY_PREFIX}{name}', first, last)
        negative = _partition(aggregates_table, f'{CATEGORY_SENTIMENT_PREFIX}{name}#negative', first, last)
        cur, prev = _split(daily, current)
        neg_cur, neg_prev = _split(negative, current)
        out[name] = CategoryCounts(cur, prev, neg_cur, neg_prev, daily)
    return out


def _day_items(feedback_table: Any, day: str, limit: int) -> tuple[list[dict], bool]:
    """Up to ``limit`` reviews processed on ``day`` (newest first); True when more exist."""
    kwargs: dict[str, Any] = {
        'IndexName': FEEDBACK_BY_DATE_INDEX, 'KeyConditionExpression': Key('gsi1pk').eq(f'DATE#{day}'),
        'ScanIndexForward': False, 'ProjectionExpression': _ITEM_FIELDS,
        'ExpressionAttributeNames': {'#date': 'date'},
    }
    items: list[dict] = []
    while len(items) < limit:
        page = feedback_table.query(**kwargs, Limit=limit - len(items))
        items.extend(i for i in page.get('Items', []) if isinstance(i, dict))
        if not page.get('LastEvaluatedKey'):
            return items, False
        kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
    return items, True


def _tally(counts: CategoryCounts, day: str, in_current: bool, negative: bool) -> None:
    counts.daily[day] = counts.daily.get(day, 0) + 1
    if in_current:
        counts.current += 1
        counts.negative_current += int(negative)
    else:
        counts.previous += 1
        counts.negative_previous += int(negative)


def _from_items(feedback_table: Any, scope: CategoryScope, names: list[str],
                days: list[str]) -> tuple[dict[str, CategoryCounts], bool]:
    out = {name: CategoryCounts() for name in names}
    current = set(days[WINDOW_DAYS:])
    budget, partial = MAX_ITEMS, False
    for day in reversed(days):
        items, more = _day_items(feedback_table, day, budget)
        budget -= len(items)
        partial = partial or more
        for item in category_access.filter_items(scope, items):
            counts = out.get(category_access.item_category(item))
            if counts is not None:
                _tally(counts, day, day in current, item.get('sentiment_label') == 'negative')
        if budget <= 0:
            return out, True
    return out, partial


#: Attributes ``gsi3-by-urgency`` projects that this read needs: the base-table keys (always
#: projected) and the review date (``gsi3sk`` starts with it). Anything else (category,
#: sentiment, source) is NOT in that index's INCLUDE list — asking for it is a
#: ValidationException — so the full fields come from the base table by key.
_URGENT_INDEX_FIELDS: Final = 'pk, sk'
BATCH_GET_MAX_KEYS: Final = 100
BATCH_GET_ATTEMPTS: Final = 3


def _batch_get(feedback_table: Any, keys: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The base-table items for ``keys`` (fields ``_ITEM_FIELDS``), in key order; unread keys skipped."""
    client = feedback_table.meta.client
    found: dict[tuple[Any, Any], dict[str, Any]] = {}
    for start in range(0, len(keys), BATCH_GET_MAX_KEYS):
        request: dict[str, Any] = {feedback_table.name: {
            'Keys': keys[start:start + BATCH_GET_MAX_KEYS],
            'ProjectionExpression': f'pk, sk, {_ITEM_FIELDS}',
            'ExpressionAttributeNames': {'#date': 'date'},
        }}
        for _ in range(BATCH_GET_ATTEMPTS):
            response = client.batch_get_item(RequestItems=request)
            for item in response.get('Responses', {}).get(feedback_table.name, []):
                found[(item.get('pk'), item.get('sk'))] = item
            request = response.get('UnprocessedKeys') or {}
            if not request:
                break
    return [found[(k['pk'], k['sk'])] for k in keys if (k['pk'], k['sk']) in found]


def _urgent(feedback_table: Any, scope: CategoryScope, since: str) -> list[dict]:
    page = feedback_table.query(
        IndexName=FEEDBACK_BY_URGENCY_INDEX,
        KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high') & Key('gsi3sk').gte(since),
        ScanIndexForward=False, Limit=MAX_URGENT, ProjectionExpression=_URGENT_INDEX_FIELDS,
    )
    keys = list({(row['pk'], row['sk']): {'pk': row['pk'], 'sk': row['sk']}
                 for row in page.get('Items', []) if row.get('pk') and row.get('sk')}.values())
    return category_access.filter_items(scope, _batch_get(feedback_table, keys))


def read_signals(feedback_table: Any, aggregates_table: Any, scope: CategoryScope, now: datetime) -> Signals:
    """Both windows for every category ``scope`` admits, and the urgent reviews it may see."""
    days = _days(now, WINDOW_DAYS * 2)
    names = visible_category_names(aggregates_table, scope)
    signals = Signals(today=days[-1])
    if scope.sources_all:
        signals.categories = _from_counters(aggregates_table, names, days)
    else:
        signals.categories, signals.partial = _from_items(feedback_table, scope, names, days)
    urgent = _urgent(feedback_table, scope, f'{days[0]}T')
    current_days = set(days[WINDOW_DAYS:])
    signals.urgent_current = [i for i in urgent if str(i.get('date')) in current_days]
    signals.urgent_previous = len(urgent) - len(signals.urgent_current)
    return signals


def _quote_text(item: Mapping[str, Any]) -> str | None:
    for name in _QUOTE_FIELDS:
        value = item.get(name)
        if isinstance(value, str) and value.strip():
            text = redact_text(value.strip(), item.get('language') if isinstance(item.get('language'), str) else None)
            clipped = text.text[:MAX_QUOTE_CHARS]
            return clipped if len(text.text) <= MAX_QUOTE_CHARS else f'{clipped.rstrip()}...'
    return None


def recent_quotes(feedback_table: Any, scope: CategoryScope, category: str, now: datetime) -> list[dict]:
    """Up to ``QUOTES_PER_CATEGORY`` PII-redacted quotes ``{feedback_id, text}`` from the newest reviews of
    ``category`` the scope admits (today, then yesterday)."""
    if not category_access.admits(scope, category):
        return []
    quotes: list[dict] = []
    for day in _days(now, 2)[::-1]:
        page = feedback_table.query(
            IndexName=FEEDBACK_BY_DATE_INDEX, KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{day}'),
            ScanIndexForward=False, Limit=QUOTE_PAGE, FilterExpression=Attr('category').eq(category),
        )
        for item in category_access.filter_items(scope, page.get('Items', [])):
            text = _quote_text(item)
            if text and isinstance(item.get('feedback_id'), str):
                quotes.append({'feedback_id': item['feedback_id'], 'text': text})
            if len(quotes) >= QUOTES_PER_CATEGORY:
                return quotes
    return quotes
