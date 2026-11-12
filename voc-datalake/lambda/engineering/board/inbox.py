"""An agent's inbox: the notices the delivery function recorded for it, read through the board API's ``inbox`` op.

The delivery function (the runtime's ``voc-engineering-delivery``) writes one row per notice in the run's partition,
create-only, never changed or deleted: ``WS#<ws>#RUN#<run>`` / ``INBOX#<addressee>#<inbox_seq:012d>#<event_id>``,
the addressee ``agent:<agent>`` (a message to that agent), ``role:<role>`` (a posted task: every live agent of the
role reads it) or ``conductor`` (a message to the run's conductor, which the coordinator plays). ``inbox_seq`` is the
run's write-order counter (``ADD inbox_seq`` on its META, taken once per notice behind an ``INBOXEVT#<event_id>``
marker), so a notice delivered late (an asynchronous retry) still numbers above everything already read. Its
attributes: ``event_id``, ``type``, ``from_kind``, ``from_id``, ``task_id`` (when the message has one), ``summary``,
``at`` (epoch seconds), ``refs`` (the message's refs, as JSON), ``inbox_seq`` and ``seq`` (the message's conversation
seq).

A reader reads its own addressees only (the board API takes them from its session), after an ``inbox_seq``: one
cursor for all of them, since the counter is the run's. Two deliveries may commit their numbers out of order, so
every read starts a window below its cursor (``rows.window_start``), on a full page as at the tail, and the next
one's cursor is the last number read (``rows.next_after``); the reader keeps each notice once by its event id.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Final

from engineering.rows import TAIL_WINDOW, next_after, run_pk, string_attr, window_page, window_start
from shared.dynamo_paging import query_all
from shared.logging import logger

SEQ_DIGITS: Final = 12
MAX_LIMIT: Final = 50
#: The role that conducts the run, and so reads the run conductor's notices.
CONDUCTOR_ROLE: Final = 'coordinator'


def addressees(role: str, agent: str) -> tuple[str, ...]:
    """The inboxes an agent reads: its own, its role's, and the conductor's for the coordinator."""
    own = (f'agent:{agent}', f'role:{role}')
    return (*own, 'conductor') if role == CONDUCTOR_ROLE else own


def inbox_prefix(addressee: str, seq: int) -> str:
    """A notice's sort key up to its event id (the delivery function's shape, pinned by the tests on both sides)."""
    return f'INBOX#{addressee}#{seq:0{SEQ_DIGITS}d}#'


def _notice(item: dict[str, Any], seq: int) -> dict[str, Any] | None:
    """The notice a row holds, or None (logged, by its key only) for a row missing what the contract requires."""
    try:
        refs = json.loads(item['refs']['S']) if 'refs' in item else {}
        notice: dict[str, Any] = {
            'seq': seq, 'conversation_seq': int(item['seq']['N']), 'event_id': item['event_id']['S'],
            'type': item['type']['S'],
            'from': {'kind': item['from_kind']['S'], 'id': item['from_id']['S']},
            'summary': string_attr(item, 'summary'), 'at': int(item['at']['N']), 'refs': refs}
    except (KeyError, TypeError, ValueError):
        logger.warning('board inbox: skipped a malformed notice', extra={'sk': string_attr(item, 'sk')})
        return None
    task_id = string_attr(item, 'task_id')
    if task_id:
        notice['task_id'] = task_id
    return notice


def _sequenced(item: dict[str, Any]) -> tuple[int, str, dict[str, Any]] | None:
    """A row with its seq and event id from its key (None, logged, when its key is malformed)."""
    parts = string_attr(item, 'sk').split('#')
    try:
        return int(parts[-2]), parts[-1], item
    except (IndexError, ValueError):
        logger.warning('board inbox: skipped a notice with a malformed key', extra={'sk': string_attr(item, 'sk')})
        return None


@dataclass(frozen=True)
class Inbox:
    #: A low-level DynamoDB client on voc-engineering.
    client: Any
    table: str

    def _after(self, ws: str, run_id: str, addressee: str, after: int, limit: int) -> list[dict[str, Any]]:
        """Up to ``limit`` of one addressee's notices after seq ``after``, following DynamoDB's page cursor."""
        return query_all(self.client, {
            'TableName': self.table, 'ConsistentRead': True, 'Limit': limit,
            'KeyConditionExpression': 'pk = :pk AND sk BETWEEN :from AND :to',
            'ExpressionAttributeValues': {':pk': {'S': run_pk(ws, run_id)},
                                          ':from': {'S': inbox_prefix(addressee, after + 1)},
                                          ':to': {'S': f'INBOX#{addressee}#~'}}}, max_items=limit)

    def read(self, ws: str, run_id: str, *, role: str, agent: str, after: int, limit: int) -> dict[str, Any]:
        """``{messages, next}``: the agent's notices in seq order (then by event id), at most ``limit`` above
        ``after`` and the window below it again (``TAIL_WINDOW``), and where its next read starts."""
        start, size = window_start(after), limit + TAIL_WINDOW
        items = [item for addressee in addressees(role, agent)
                 for item in self._after(ws, run_id, addressee, start, size)]
        # Ordered by the key (seq, then event id); a malformed row still counts for the cursor, never as a message. A
        # row whose key is malformed is dropped before the cut, so its page may read as shorter than it was (the
        # next read re-reads the window, which its event-id dedupe absorbs).
        rows = sorted((row for row in map(_sequenced, items) if row is not None), key=lambda row: row[:2])
        rows = window_page(after, rows, limit, lambda row: row[0])
        notices = [_notice(item, seq) for seq, _, item in rows]
        return {'messages': [notice for notice in notices if notice is not None],
                'next': next_after(after, [seq for seq, _, _ in rows])}
