"""voc-retention: an erased +1 is RE-KEYED, not just stripped (docs/feature-requests.md -> Erasure).

A +1's id is derived from the supporter's email (``support_id_for``: sha256(request id, email)), so
removing the email alone would leave a key anyone who knows the email can recompute. The boards
phase therefore moves the de-identified +1 to a NEW random support id, in ONE TransactWriteItems:

- Put the de-identified row under ``SUP#{new id}`` (same request, same field values, ``is_reporter``
  and ``created_at`` kept, no email, no name, ``deidentified_at`` set), only where none is;
- Delete the old ``SUP#{old id}`` row, only while it is still the row as read (since 7.72.03: its ``updated_at``
  unchanged, so an edit between the read and the write is never lost; the boards phase reads it again and tries
  again, at most ``boards.MAX_TRIES`` times, then fails the job, ``SupportKeptChanging``).

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
    get_support,
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


def deidentified_support(row: Mapping[str, Any], support_id: str,
                         also: frozenset[str] = frozenset()) -> dict[str, Any]:
    """The +1 under ``support_id``: every value but the person's (and ``also``: its ``contact_email`` when the erased
    address is that too, 7.72.00), the old key and the old id."""
    request_id = str(row.get('request_id') or str(row['pk']).removeprefix('FR#'))
    now = now_iso()
    kept = {key: value for key, value in row.items() if key not in _DROPPED | also}
    return {**kept, **support_key(request_id, support_id), 'support_id': support_id, 'request_id': request_id,
            DEIDENTIFIED_FIELD: now, 'updated_at': now}


def current_support(table: Any, request_id: str, support_id: str) -> dict[str, Any] | None:
    """The +1 as stored now (the store's consistent read), or None when it is gone."""
    try:
        return get_support(table, request_id, support_id)
    except NotFoundError:
        return None


class SupportKeptChanging(RuntimeError):
    """A +1 changed between its read and every one of the boards phase's re-key tries: the job fails, naming its
    request (never the +1's id, which derives from the supporter's address, nor the address), and an admin reruns it."""


#: ``rekey``'s outcomes: moved; the old row gone (removed or re-keyed meanwhile: nothing to do); the old row changed
#: since it was read (or the transaction met a concurrent write, or the new id was taken: read it again and retry).
SUPPORT_REKEYED: Final = 'support_rekeyed'
SUPPORT_GONE: Final = 'support_gone'
SUPPORT_CHANGED: Final = 'support_changed'
_OLD_ROW: Final = 1  # the Delete's place in the transaction, and so in ``CancellationReasons``
_RETRIED: Final = frozenset({'None', 'ConditionalCheckFailed', 'TransactionConflict'})


def _cancelled(error: ClientError) -> str:
    """What a cancelled re-key's ``CancellationReasons`` say: ``SUPPORT_GONE`` when the Delete's condition failed with
    no old row returned (``ReturnValuesOnConditionCheckFailure``: the row is not there), ``SUPPORT_CHANGED`` for every
    other condition failure or conflict, and missing or short reasons (the caller's next read decides); any other code
    raises the error."""
    reasons = list(error.response.get('CancellationReasons') or [])
    if not {str(reason.get('Code') or 'None') for reason in reasons} <= _RETRIED:
        raise error
    old = reasons[_OLD_ROW] if len(reasons) > _OLD_ROW else {}
    if old.get('Code') == 'ConditionalCheckFailed' and not old.get('Item'):
        return SUPPORT_GONE
    return SUPPORT_CHANGED


def rekey(table: Any, row: Mapping[str, Any], support_id: str, also: frozenset[str] = frozenset()) -> str:
    """Move the +1 ``row`` (read by ``current_support``) to ``support_id`` without its email and name (and ``also``):
    ``SUPPORT_REKEYED``, ``SUPPORT_GONE`` or ``SUPPORT_CHANGED``.

    The Delete of the old row holds only while it is the row as read (7.72.03): its ``updated_at`` the one read
    (``attribute_not_exists`` when it had none; the store's writers of a +1 set it), so an edit landing after the read
    cancels the move instead of being overwritten by the read's values; the cancellation's reasons tell a gone row
    from a changed one (``_cancelled``)."""
    old_key = {'pk': row['pk'], 'sk': row['sk']}
    seen = row.get('updated_at')
    unchanged = ('attribute_exists(pk) AND updated_at = :seen' if seen is not None
                 else 'attribute_exists(pk) AND attribute_not_exists(updated_at)')
    delete: dict[str, Any] = {'TableName': table.name, 'Key': old_key, 'ConditionExpression': unchanged,
                              'ReturnValuesOnConditionCheckFailure': 'ALL_OLD'}
    if seen is not None:
        delete['ExpressionAttributeValues'] = {':seen': seen}
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'Item': deidentified_support(row, support_id, also),
                     'ConditionExpression': 'attribute_not_exists(pk)'}},
            {'Delete': delete},
        ])
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            return _cancelled(error)
        raise
    return SUPPORT_REKEYED


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
