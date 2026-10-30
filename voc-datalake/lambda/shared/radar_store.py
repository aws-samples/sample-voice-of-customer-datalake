"""The ``voc-radar`` table: other brands' reviews and their counters (docs/radar.md).

Kept apart from ``voc-feedback`` / ``voc-aggregates`` on purpose: every existing
reader of our own numbers (dashboards, metrics, search, agents, MCP, research,
memory) reads those tables only, so a Radar item can never leak into them.

Key layout (``brand`` = ``shared.radar_brands.brand_key``)::

    RADAR#{brand}#ITEMS#{YYYY-MM} / {day}#{feedback_id}    enriched review (month partition)
    RADARID#{brand}               / {feedback_id}          dedupe marker (one per review)
    RADAR#{brand}#{metric}        / {day}                  daily counter {count[, sentiment_sum]}

``{day}`` is the day the review was WRITTEN (``radar_day``: ``source_created_at``, else the
import day), so a backfill of another brand's history keeps its real trend.
        metric = daily_total | daily_sentiment#{label} | daily_category#{category}
               | category_sentiment#{category}#{label}

Love / hate themes are read from the reviews themselves (``recent_items``), not counted.

A review, its marker and its counters are written in ONE transaction guarded by
the marker, so an SQS redelivery never double-counts and a half-written review
never exists.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Mapping
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import dynamo_paging
from shared.aws import is_conditional_check_failure
from shared.feedback import DATE_BASIS_REVIEW, basis_date

__all__ = [
    'SENTIMENT_LABELS',
    'THEME_POLARITIES',
    'counter_pk',
    'daily_rows',
    'is_stored',
    'item_partitions',
    'marker_key',
    'query_all',
    'radar_day',
    'radar_item',
    'recent_items',
    'store_item',
    'sum_counter',
]

SENTIMENT_LABELS: Final = ('positive', 'negative', 'neutral', 'mixed')
# Love = positive themes, hate = negative ones; neutral/mixed reviews make no theme.
THEME_POLARITIES: Final = ('positive', 'negative')
TRANSACT_ATTEMPTS: Final = 3
# The latest Radar scan's outcome: written by the scan job, read by the Radar page.
LAST_SCAN_KEY: Final = {'pk': 'RADARSCAN', 'sk': 'LAST'}
# The GSI keys of a feedback item: the radar table has no index, so they are dropped.
_FEEDBACK_INDEX_KEYS: Final = ('gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk')


def _items_pk(brand: str, month: str) -> str:
    return f'RADAR#{brand}#ITEMS#{month}'


def marker_key(brand: str, feedback_id: str) -> dict[str, str]:
    """The key of one review's dedupe marker; it also points at the review (``item_pk`` / ``item_sk``)."""
    return {'pk': f'RADARID#{brand}', 'sk': feedback_id}


def counter_pk(brand: str, metric: str) -> str:
    """The partition of one of ``brand``'s daily counters (``metric`` as in the module docstring)."""
    return f'RADAR#{brand}#{metric}'


def is_stored(table: Any, brand: str, feedback_id: str) -> bool:
    """True when this review of ``brand`` is already in the table (checked before paying for enrichment)."""
    response = table.get_item(Key=marker_key(brand, feedback_id), ProjectionExpression='pk')
    return 'Item' in response


def radar_day(item: Mapping[str, Any]) -> str:
    """The day a Radar review is bucketed under: when the customer WROTE it.

    A Radar source usually starts with a backfill of another brand's reviews; bucketing by the
    import day (``date``) would pile every one of them onto that day and flatten the trend. The
    review date (``source_created_at``) is used when it is a valid date not after the import day,
    else the import day.
    """
    imported = str(item['date'])
    written = basis_date(dict(item), DATE_BASIS_REVIEW)
    return min(written, imported)


def radar_item(item: Mapping[str, Any], brand: str, brand_label: str) -> dict[str, Any]:
    """The processor's enriched feedback ``item`` re-keyed for the radar table (no GSI keys).

    ``radar_day`` (the review date, see ``radar_day``) keys the row and its counters; ``date``
    keeps the import day.
    """
    day = radar_day(item)
    stored = {key: value for key, value in item.items() if key not in _FEEDBACK_INDEX_KEYS}
    stored.update({
        'pk': _items_pk(brand, day[:7]),
        'sk': f"{day}#{item['feedback_id']}",
        'radar_day': day,
        'radar_brand': brand,
        'radar_brand_label': brand_label,
    })
    return stored


def _metrics(item: Mapping[str, Any]) -> list[str]:
    category = str(item.get('category') or 'other')
    label = str(item.get('sentiment_label') or 'neutral')
    return [
        f'daily_sentiment#{label}',
        f'daily_category#{category}',
        f'category_sentiment#{category}#{label}',
    ]


def _counter_update(table_name: str, pk: str, day: str, score: Decimal | None = None) -> dict[str, Any]:
    """``ADD count 1`` on one daily row; the daily total also adds the review's sentiment score.

    Plain Python values: the table resource's client serializes transaction
    items itself (as it does for ``update_item``).
    """
    expression, names = 'ADD #c :one', {'#c': 'count'}
    values: dict[str, int | Decimal] = {':one': 1}
    if score is not None:
        expression += ', #s :score'
        names['#s'] = 'sentiment_sum'
        values[':score'] = score
    return {'Update': {
        'TableName': table_name,
        'Key': {'pk': pk, 'sk': day},
        'UpdateExpression': expression,
        'ExpressionAttributeNames': names,
        'ExpressionAttributeValues': values,
    }}


def _transaction(table_name: str, brand: str, stored: Mapping[str, Any]) -> list[dict[str, Any]]:
    day = str(stored.get('radar_day') or stored['date'])
    marker = {**marker_key(brand, str(stored['feedback_id'])), 'item_pk': stored['pk'], 'item_sk': stored['sk']}
    score = stored.get('sentiment_score')
    return [
        {'Put': {'TableName': table_name, 'Item': marker, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'Put': {'TableName': table_name, 'Item': dict(stored)}},
        _counter_update(table_name, counter_pk(brand, 'daily_total'), day,
                        score if isinstance(score, Decimal) else Decimal(0)),
        *(_counter_update(table_name, counter_pk(brand, metric), day) for metric in _metrics(stored)),
    ]


def store_item(table: Any, brand: str, stored: Mapping[str, Any]) -> bool:
    """Write one radar review with its marker and counters; False when it was already stored.

    ``stored`` is a ``radar_item`` result. Two reviews of one brand and day move
    the same counters, so a transaction cancelled by that contention is tried
    again here (up to ``TRANSACT_ATTEMPTS``) rather than re-paying enrichment
    through an SQS retry; any other failure propagates and SQS retries.
    """
    actions = _transaction(table.name, brand, stored)
    for attempt in range(1, TRANSACT_ATTEMPTS + 1):
        try:
            table.meta.client.transact_write_items(TransactItems=actions)
        except ClientError as e:
            if _marker_existed(e):
                return False
            if attempt == TRANSACT_ATTEMPTS or not _contended(e):
                raise
            time.sleep((0.05 + secrets.randbelow(150) / 1000) * attempt)
            continue
        return True
    return False


def _reasons(error: ClientError) -> list[str]:
    return [str(reason.get('Code') or '') for reason in error.response.get('CancellationReasons') or []]


def _marker_existed(error: ClientError) -> bool:
    """A cancelled transaction whose FIRST action (the marker put) failed its condition."""
    if is_conditional_check_failure(error):
        return True
    reasons = _reasons(error)
    return bool(reasons) and reasons[0] == 'ConditionalCheckFailed'


def _contended(error: ClientError) -> bool:
    return any(code in ('TransactionConflict', 'ThrottlingError') for code in _reasons(error))


def sum_counter(table: Any, pk: str, start: date, end: date, attribute: str = 'count') -> Decimal:
    """The sum of ``attribute`` over the daily rows of ``pk`` from ``start`` to ``end`` (inclusive)."""
    return sum((Decimal(str(row.get(attribute, 0))) for row in daily_rows(table, pk, start, end)), Decimal(0))


def query_all(table: Any, key_condition: Any) -> list[dict[str, Any]]:
    """Every row matching ``key_condition``, following the pagination to the end."""
    return dynamo_paging.query_all(table, {'KeyConditionExpression': key_condition})


def daily_rows(table: Any, pk: str, start: date, end: date) -> list[dict[str, Any]]:
    """The daily rows of ``pk`` from ``start`` to ``end``, oldest first."""
    return query_all(table, Key('pk').eq(pk) & Key('sk').between(start.isoformat(), end.isoformat()))


def item_partitions(brand: str, start: date, end: date) -> list[str]:
    """The month partitions holding ``brand``'s reviews from ``start`` to ``end``, newest first."""
    months: list[str] = []
    cursor = end.replace(day=1)
    while cursor >= start.replace(day=1):
        months.append(_items_pk(brand, cursor.strftime('%Y-%m')))
        cursor = (cursor - timedelta(days=1)).replace(day=1)
    return months


def recent_items(table: Any, brand: str, start: date, end: date, limit: int) -> list[dict[str, Any]]:
    """Up to ``limit`` of ``brand``'s reviews dated ``start``..``end``, newest first."""
    low, high = start.isoformat(), f'{end.isoformat()}#~'
    out: list[dict[str, Any]] = []
    for pk in item_partitions(brand, start, end):
        kwargs: dict[str, Any] = {
            'KeyConditionExpression': Key('pk').eq(pk) & Key('sk').between(low, high),
            'ScanIndexForward': False,
        }
        while len(out) < limit:
            page = table.query(**kwargs, Limit=limit - len(out))
            out.extend(page.get('Items', []))
            if 'LastEvaluatedKey' not in page:
                break
            kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
        if len(out) >= limit:
            break
    return out
