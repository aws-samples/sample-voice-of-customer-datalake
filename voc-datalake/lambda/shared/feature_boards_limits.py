"""Abuse limits of ``anyone`` boards (docs/feature-requests.md -> Rate limits).

A board open to any verified email has no moderation (a post shows at once), so it is capped
instead: per poster per board per UTC day at most 20 new requests and 100 +1s, and per board at
most 500 new requests a day. Over a limit the route answers 429 ``rate_limited``. Admins are
never limited; boards of other audiences are not either (their posters are known people).

Counters are atomic rows in the feature-requests table, ``RATE#{board_id}#{email sha256}#{day}``
(the board-wide one uses ``*`` for the hash) / ``COUNT``, with a ``ttl`` two days out. A new
request charges its poster and the board in ONE transaction, so a refused one counts nowhere.
"""
from __future__ import annotations

import hashlib
import time
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.engagement_identity import BoardViewer
from shared.exceptions import TooManyRequestsError
from shared.feature_boards_audience import audience_of

MAX_REQUESTS_PER_POSTER: Final = 20
MAX_SUPPORTS_PER_POSTER: Final = 100
MAX_REQUESTS_PER_BOARD: Final = 500
RATE_TTL_SECONDS: Final = 2 * 24 * 3600
RATE_LIMITED: Final = 'rate_limited'
_BOARD_WIDE: Final = '*'


def _day() -> str:
    return datetime.now(UTC).strftime('%Y-%m-%d')


def rate_key(board_id: str, email_lc: str | None, day: str) -> dict[str, str]:
    poster = hashlib.sha256(email_lc.encode()).hexdigest() if email_lc else _BOARD_WIDE
    return {'pk': f'RATE#{board_id}#{poster}#{day}', 'sk': 'COUNT'}


def is_limited(board: dict[str, Any], viewer: BoardViewer) -> bool:
    return not viewer.is_admin and audience_of(board)['mode'] == 'anyone'


def _increment(key: dict[str, str], counter: str, cap: int) -> dict[str, Any]:
    """An UpdateItem request (no table name) adding one to ``counter`` while it is below ``cap``."""
    return {'Key': key,
            'UpdateExpression': 'ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)',
            'ConditionExpression': 'attribute_not_exists(#c) OR #c < :cap',
            'ExpressionAttributeNames': {'#c': counter, '#ttl': 'ttl'},
            'ExpressionAttributeValues': {':one': 1, ':cap': cap, ':ttl': int(time.time()) + RATE_TTL_SECONDS}}


def charge_request(table: Any, board: dict[str, Any], viewer: BoardViewer) -> None:
    """Count one new request on an ``anyone`` board, or 429 ``rate_limited``."""
    if not is_limited(board, viewer):
        return
    board_id, day = str(board['board_id']), _day()
    items = [{'Update': {'TableName': table.name, **_increment(rate_key(board_id, email, day), 'requests', cap)}}
             for email, cap in ((viewer.email, MAX_REQUESTS_PER_POSTER), (None, MAX_REQUESTS_PER_BOARD))]
    try:
        table.meta.client.transact_write_items(TransactItems=items)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise TooManyRequestsError(RATE_LIMITED) from error
        raise


def charge_support(table: Any, board: dict[str, Any], viewer: BoardViewer) -> None:
    """Count one new +1 on an ``anyone`` board, or 429 ``rate_limited``."""
    if not is_limited(board, viewer):
        return
    update = _increment(rate_key(str(board['board_id']), viewer.email, _day()), 'supports', MAX_SUPPORTS_PER_POSTER)
    try:
        table.update_item(**update)
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise TooManyRequestsError(RATE_LIMITED) from error
        raise
