"""Channel-filtered reads through ``gsi5-by-channel`` (lib/stacks/core-stack.ts).

Why an index: a ``channel=`` filter on the day walk (``gsi1-by-date``) has to read every
review of every day in the window and keep the channel's few. One CSV import put 25,229
reviews on one day; a channel of 70 among them came back empty, because the day walk stops
at its row caps long before it has read the day (a benchmark on that shape: 14 s to read
the day in full, 0.1 s to read the 70 through this index).

The index is keyed ``source_channel`` + ``gsi1sk`` (the processing time, the same sort key
``gsi1-by-date`` uses), so a window is one key range per channel, newest first, and a read
costs what the CHANNEL holds, not what the day holds. It projects only
``CHANNEL_INDEX_FIELDS``: what the metric routes read off an item. That keeps each row
small (a whole channel of 25,000 reviews reads in about 2 s), so the walk can afford a far
larger cap than the day walk's 5,000. A route that shows full reviews (the feedback list)
reads its page of keys here and fetches those items from the table.

DynamoDB builds the index from existing items by itself: every processed review already
carries both key attributes. Items without a ``source_channel`` are simply not in it, which
is right, since they can never match a channel filter.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import ConditionBase, Key
from botocore.exceptions import ClientError

from shared.indexes import FEEDBACK_BY_CHANNEL_INDEX
from shared.time_budget import ROW_CAP_PARTIAL_REASON, TIME_BUDGET_PARTIAL_REASON, WalkBudget

__all__ = ['CHANNEL_INDEX_FIELDS', 'ChannelIndexUnavailable', 'walk_channel']

# The non-key attributes gsi5-by-channel projects (its `nonKeyAttributes` in core-stack.ts;
# test_channel_index.py pins the two together). Everything a channel-filtered metric reads:
# category / scope (category, subcategory), sentiment, the date bases, urgency, persona,
# issues (problem_summary), dims / tags / stars filters, GitHub metrics (issue_attributes).
# The table keys (pk, sk) and the index keys (source_channel, gsi1sk) come with every row.
CHANNEL_INDEX_FIELDS: Final = (
    'feedback_id', 'source_platform', 'category', 'subcategory', 'sentiment_label', 'sentiment_score',
    'date', 'source_created_at', 'urgency', 'persona_type', 'problem_summary', 'dimensions', 'tags',
    'rating', 'issue_attributes',
)

# Rows one request may hold (a projected row is a few hundred bytes). The walk budget still
# bounds the time; past either limit the answer is marked partial.
CHANNEL_WALK_CAP: Final = 100_000

# Rows per query page. A projected row is small, so a page holds far more than the day walk's 500.
_PAGE_LIMIT: Final = 2_000


class ChannelIndexUnavailable(Exception):
    """The index does not exist yet (a deployment mid-upgrade): the caller falls back to the day walk."""


def _day_after(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def _index_missing(exc: ClientError) -> bool:
    """True only for "no such index".

    DynamoDB answers a ValidationException ("does not have the specified index"); moto a
    ResourceNotFoundException ("Invalid index"). Any other error (a malformed filter, a
    missing table) is a bug and must surface, not fall back.
    """
    error = exc.response.get('Error', {})
    message = str(error.get('Message', ''))
    return ((error.get('Code') == 'ValidationException' and 'specified index' in message)
            or (error.get('Code') == 'ResourceNotFoundException' and 'Invalid index' in message))


def walk_channel(
    table: Any,
    channel: str,
    cutoff_date: str,
    budget: WalkBudget,
    *,
    row_filter: ConditionBase | None = None,
    cap: int = CHANNEL_WALK_CAP,
) -> tuple[list[dict[str, Any]], bool]:
    """The channel's rows processed on or after ``cutoff_date`` (YYYY-MM-DD), newest first.

    Returns ``(rows, is_partial)``. ``row_filter`` (source, scope, ...) is pushed down as the
    FilterExpression. Partial when ``cap`` rows were collected or the request's walk budget ran
    out with rows left; the budget then records the oldest day read in full, as the day walk
    does, with the reason (``row_cap`` when the cap cut it, else ``time_budget``). Raises :class:`ChannelIndexUnavailable` when the index is missing.
    """
    kwargs: dict[str, Any] = {
        'IndexName': FEEDBACK_BY_CHANNEL_INDEX,
        # gsi1sk starts with the ISO processing time, so a date compares as its prefix.
        'KeyConditionExpression': Key('source_channel').eq(channel) & Key('gsi1sk').gte(cutoff_date),
        'ScanIndexForward': False,
        'Limit': _PAGE_LIMIT,
    }
    if row_filter is not None:
        kwargs['FilterExpression'] = row_filter
    rows: list[dict[str, Any]] = []
    while True:
        try:
            response = table.query(**kwargs)
        except ClientError as exc:
            if _index_missing(exc):
                raise ChannelIndexUnavailable(str(exc)) from exc
            raise
        rows.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return rows, False
        if len(rows) >= cap or budget.exhausted():
            reason = ROW_CAP_PARTIAL_REASON if len(rows) >= cap else TIME_BUDGET_PARTIAL_REASON
            rows = rows[:cap]
            oldest = str(rows[-1].get('gsi1sk', ''))[:10] if rows else ''
            # The oldest day may be cut part-way: claim completeness only from the day after it.
            budget.record_stop(_day_after(oldest) if oldest else cutoff_date, reason)
            return rows, True
        kwargs['ExclusiveStartKey'] = last_key
