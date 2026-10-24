"""The earliest-data watermark: the oldest import `date` any feedback item carries.

Stored in the aggregates table at `pk='METRIC#meta'`, `sk='earliest_date'`, attribute
`date` ('YYYY-MM-DD'). The aggregator lowers it on every INSERT with a conditional
update (`set when absent or when the new date is earlier`), so it only ever moves
back in time; `scripts/retention/remove_ttl.py --apply` seeds it for deployments
that predate it. The metrics routes read it to turn `days=0` (all time) — or any
window longer than the data's history — into a concrete day count, see
`shared.api.effective_window_days`.

Data-layer only (no API-resolver imports), so the aggregator can use it.
"""
from collections.abc import Mapping
from datetime import date

EARLIEST_DATE_PK = 'METRIC#meta'
EARLIEST_DATE_SK = 'earliest_date'
EARLIEST_DATE_KEY = {'pk': EARLIEST_DATE_PK, 'sk': EARLIEST_DATE_SK}
EARLIEST_DATE_ATTRIBUTE = 'date'


def parse_iso_date(value: object) -> date | None:
    """`value` as a date if it is a 'YYYY-MM-DD' string, else None."""
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def earliest_date_from_item(item: object) -> str | None:
    """The watermark's date from an item, or None if absent/malformed.

    Accepts both a deserialised item (`get_item` through the Table resource) and
    the low-level wire shape (`{'S': '2025-01-15'}`), which is what a
    `ClientError`'s `ALL_OLD` item carries even through the resource layer.
    """
    if not isinstance(item, Mapping):
        return None
    value = item.get(EARLIEST_DATE_ATTRIBUTE)
    if isinstance(value, Mapping):
        value = value.get('S')
    return value if parse_iso_date(value) is not None else None


def lower_watermark_request(new_date: str, now_iso: str) -> dict:
    """`update_item` arguments that set the watermark to `new_date` iff it is earlier.

    The condition failing is the common, benign outcome (the stored date is already
    as old or older). `ReturnValuesOnConditionCheckFailure='ALL_OLD'` lets the caller
    learn the stored date from the refusal and skip later writes it cannot win.
    """
    return {
        'Key': dict(EARLIEST_DATE_KEY),
        'UpdateExpression': 'SET #date = :date, updated_at = :now',
        'ConditionExpression': 'attribute_not_exists(#date) OR #date > :date',
        'ExpressionAttributeNames': {'#date': EARLIEST_DATE_ATTRIBUTE},
        'ExpressionAttributeValues': {':date': new_date, ':now': now_iso},
        'ReturnValuesOnConditionCheckFailure': 'ALL_OLD',
    }
