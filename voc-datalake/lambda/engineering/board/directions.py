"""A run's direction (7.51.00): what the run coordinator made of people's steering, one short text every agent reads.

The coordinator sets it with ``set_direction`` (the board's op of that name): each set is a new version, a create-only
row ``WS#<ws>#RUN#<run>`` / ``DIRECTION#v<nnnnnn>`` (``{kind: direction, version, text, by, at}``, never changed: D1,
D4), written in one transaction with META's ``direction_version``, which moves only from the version the writer read
(two sets at once: one wins, the other reads again). Every inbox page the board answers names that version
(``direction``), so an agent's harness reads the direction (the ``direction`` op) only when it moved, and at each
session's start: never once per turn. A set whose text is the current version's answers that version (a retry).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.board.store import BoardError
from engineering.quality_gate.text import redact
from engineering.rows import get_row, number_value, run_pk, string_attr
from shared.ids import is_key_collision

PREFIX: Final = 'DIRECTION#v'
DIGITS: Final = 6
MAX_TEXT: Final = 2_000
MAX_VERSION: Final = 10 ** DIGITS - 1
TRIES: Final = 3


@dataclass(frozen=True)
class Direction:
    version: int = 0
    text: str = ''
    by: str = ''
    at: str = ''

    def view(self) -> dict[str, Any]:
        return {'version': self.version, 'text': self.text, 'by': self.by or None, 'at': self.at or None}


def direction_sk(version: int) -> str:
    return f'{PREFIX}{version:0{DIGITS}d}'


def _meta_key(ws: str, run_id: str) -> dict[str, Any]:
    return {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}}


def current_version(meta: dict[str, Any] | None) -> int:
    """META's ``direction_version`` (0: none set)."""
    return number_value((meta or {}).get('direction_version'))


def read(client: Any, table: str, ws: str, run_id: str) -> Direction:
    """The run's current direction (version 0 and no text: none set)."""
    version = current_version(get_row(client, table, _meta_key(ws, run_id)))
    if not version:
        return Direction()
    row = get_row(client, table, {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': direction_sk(version)}})
    if row is None:
        return Direction(version=version)
    return Direction(version=version, text=string_attr(row, 'text'), by=string_attr(row, 'by'),
                     at=string_attr(row, 'at'))


def _text(text: str) -> str:
    cleaned = redact(text.strip())
    if not 0 < len(cleaned) <= MAX_TEXT:
        raise BoardError('invalid', f'a direction is text of 1-{MAX_TEXT} characters')
    return cleaned


def write(client: Any, table: str, ws: str, run_id: str, text: str, *, by: str, at: str) -> Direction:
    """A new version of the run's direction, create-only with META's version moved from the one read; the current one
    when it already says ``text`` (a retry)."""
    cleaned = _text(text)
    pk = run_pk(ws, run_id)
    for _ in range(TRIES):
        current = read(client, table, ws, run_id)
        if current.version and current.text == cleaned:
            return current
        version = current.version + 1
        if version > MAX_VERSION:
            raise BoardError('conflict', 'the run has had all the directions it can have')
        condition = ('attribute_exists(pk) AND attribute_not_exists(direction_version)' if not current.version
                     else 'direction_version = :read')
        values = {':version': {'N': str(version)}, **({':read': {'N': str(current.version)}} if current.version
                                                      else {})}
        item = {'pk': {'S': pk}, 'sk': {'S': direction_sk(version)}, 'kind': {'S': 'direction'},
                'version': {'N': str(version)}, 'text': {'S': cleaned}, 'by': {'S': by}, 'at': {'S': at}}
        try:
            client.transact_write_items(TransactItems=[
                {'Put': {'TableName': table, 'Item': item, 'ConditionExpression': 'attribute_not_exists(sk)'}},
                {'Update': {'TableName': table, 'Key': _meta_key(ws, run_id), 'ConditionExpression': condition,
                            'UpdateExpression': 'SET direction_version = :version',
                            'ExpressionAttributeValues': values}},
            ])
        except ClientError as error:
            if is_key_collision(error, put_index=0) or is_key_collision(error, put_index=1):
                continue   # (another set landed between the read and the write: read again)
            raise
        return Direction(version=version, text=cleaned, by=by, at=at)
    raise BoardError('conflict', 'the run\'s direction moved while it was set: read it and set it again')
