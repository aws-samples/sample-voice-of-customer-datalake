"""voc-retention: an erased +1 is RE-KEYED, not just stripped (docs/feature-requests.md -> Erasure).

A +1's id is derived from the supporter's email (``support_id_for``: sha256(request id, email)), so
removing the email alone would leave a key anyone who knows the email can recompute. The boards
phase therefore moves the de-identified +1 to a NEW random support id, in ONE TransactWriteItems:

- Put the de-identified row under ``SUP#{new id}`` (same request, same field values, ``is_reporter``
  and ``created_at`` kept, no email, no name, ``deidentified_at`` set), only where none is;
- Delete the old ``SUP#{old id}`` row, only while it still exists.

The request row stores no support id (its own id is random), so nothing else carries the old id.
The tombstone names the new id only. The request's totals are then recomputed by the store's own
``recompute_totals``: a de-identified +1 still counts as one supporter (``compute_totals``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.engagement_common import new_id
from shared.exceptions import ConflictError, NotFoundError
from shared.feature_boards_store import get_board
from shared.feature_requests_store import (
    DEIDENTIFIED_FIELD,
    SUPPORT_PREFIX,
    board_id_of,
    get_request,
    recompute_totals,
    support_key,
)
from shared.logging import logger
from shared.timestamps import now_iso

# What the re-keyed row drops: the person, and the old key / id it is replaced under.
_DROPPED: Final = frozenset({'email', 'name', 'pk', 'sk', 'support_id'})


def new_support_id() -> str:
    """A random support id (``sup_`` + 16 hex), never derived from the email."""
    return new_id(SUPPORT_PREFIX)


def deidentified_support(row: Mapping[str, Any], support_id: str) -> dict[str, Any]:
    """The +1 under ``support_id``: every value but the person's, the old key and the old id."""
    request_id = str(row.get('request_id') or str(row['pk']).removeprefix('FR#'))
    now = now_iso()
    kept = {key: value for key, value in row.items() if key not in _DROPPED}
    return {**kept, **support_key(request_id, support_id), 'support_id': support_id, 'request_id': request_id,
            DEIDENTIFIED_FIELD: now, 'updated_at': now}


def rekey(table: Any, old_key: Mapping[str, str], support_id: str) -> bool:
    """Move the +1 at ``old_key`` to ``support_id`` without its email and name; False when it is gone meanwhile."""
    row = table.get_item(Key=dict(old_key), ConsistentRead=True).get('Item')
    if not isinstance(row, dict):
        return False
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'Item': deidentified_support(row, support_id),
                     'ConditionExpression': 'attribute_not_exists(pk)'}},
            {'Delete': {'TableName': table.name, 'Key': dict(old_key), 'ConditionExpression': 'attribute_exists(pk)'}},
        ])
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            return False  # the +1 was removed (or re-keyed) meanwhile
        raise
    return True


def recount(table: Any, request_id: str) -> None:
    """Recompute the request's totals with its board's template; a request deleted meanwhile is skipped."""
    request = get_request(table, request_id)
    if request is None:
        return
    board = get_board(table, board_id_of(request))
    template = str((board or {}).get('template', ''))
    try:
        recompute_totals(table, request_id, template)
    except (NotFoundError, ConflictError) as error:
        # The +1 is already re-keyed and still counts; the next change to the request recounts it.
        logger.warning('Board totals not recomputed after an erasure', extra={'request_id': request_id,
                                                                              'reason': type(error).__name__})
