"""Put one new audit row, never overwriting one (TENETS.md D4).

An audit row (``pk`` starting ``AUDIT#``, ``sk`` a time plus a random suffix) is written with
``attribute_not_exists(pk)``, so an existing row is never replaced. botocore retries a put whose answer was lost
(a timeout, a dropped connection); when the first attempt had landed, the retry fails that condition although the
row is ours. So a ``ConditionalCheckFailedException`` counts as already written ONLY when the row now stored at that
exact key is the item we put, read strongly consistent; any other row there (a collision, a forged row) re-raises.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from botocore.exceptions import ClientError

_CONDITION_FAILED = 'ConditionalCheckFailedException'


def put_new_audit_row(table: Any, item: Mapping[str, Any]) -> None:
    """Put ``item`` (keys ``pk`` and ``sk``) unless a row is stored at its key; a retried put of the same item passes."""
    try:
        table.put_item(Item=dict(item), ConditionExpression='attribute_not_exists(pk)')
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') != _CONDITION_FAILED:
            raise
        stored = table.get_item(Key={'pk': item['pk'], 'sk': item['sk']}, ConsistentRead=True).get('Item')
        if stored != dict(item):
            raise
