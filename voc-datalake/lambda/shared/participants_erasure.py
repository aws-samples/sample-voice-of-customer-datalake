"""Erase one person from voc-participants (``DELETE /participants/people/{id}``, admin).

Deleted: the person (META), its email guard, every membership on both sides (each
list's ``member_count`` down by one), its project links, every token minted for it,
and the person's ask mirrors. Each recipient row it had keeps ONLY ``person_id`` and
its delivery status (the response token hash and any error code are removed), so an
ask's counts stay true while nothing on it can identify the person any more.
Feedback a person already submitted is customer data in voc-feedback: erase it with
Administration -> Privacy (``POST /settings/erasure``), docs/source-policies.md.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from shared.dynamo_paging import query_all
from shared.engagement_common import conditional_write
from shared.logging import logger
from shared.participants_asks import RESPONSE_SK, UNSUBSCRIBE_SK, hashed_token_key, recipient_key
from shared.participants_lists import remove_member
from shared.participants_store import email_guard_key, require_person


def _ids(rows: list[dict[str, Any]], prefix: str, field: str) -> list[str]:
    return [str(row[field]) for row in rows if str(row.get('sk', '')).startswith(prefix) and row.get(field)]


def _strip_recipient(table: Any, ask_id: str, person_id: str) -> None:
    """Keep the recipient row's person_id and status only (a row already gone is fine)."""
    conditional_write(table.update_item, Key=recipient_key(ask_id, person_id),
                      UpdateExpression='REMOVE response_token_hash, #e', ConditionExpression='attribute_exists(pk)',
                      ExpressionAttributeNames={'#e': 'error'})


def _delete_rows(table: Any, person: Mapping[str, Any], rows: list[dict[str, Any]]) -> tuple[int, int]:
    """Tokens, project links, the person's own partition (list mirrors excepted) and the guard."""
    person_id = str(person['person_id'])
    token_hashes = [str(h) for h in person.get('token_hashes') or ()]
    projects = [str(p) for p in person.get('project_ids') or ()]
    with table.batch_writer() as batch:
        for token_hash in token_hashes:
            for kind in (RESPONSE_SK, UNSUBSCRIBE_SK):
                batch.delete_item(Key=hashed_token_key(token_hash, kind))
        for project_id in projects:
            batch.delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSON#{person_id}'})
        for row in rows:
            if not str(row.get('sk', '')).startswith('LIST#'):  # remove_member already took the list mirrors
                batch.delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
        email_lc = person.get('email_lc')
        if isinstance(email_lc, str) and email_lc:
            batch.delete_item(Key=email_guard_key(email_lc))
    return len(token_hashes), len(projects)


def erase_person(table: Any, person_id: str) -> dict[str, int]:
    """Erase ``person_id``; NotFoundError when absent. Returns what was removed (counts only)."""
    person = require_person(table, person_id)
    rows = query_all(table, {'KeyConditionExpression': 'pk = :pk',
                             'ExpressionAttributeValues': {':pk': f'PERSON#{person_id}'}})
    lists = _ids(rows, 'LIST#', 'list_id')
    asks = _ids(rows, 'ASK#', 'ask_id')
    for list_id in lists:
        remove_member(table, list_id, person_id)
    for ask_id in asks:
        _strip_recipient(table, ask_id, person_id)
    tokens, projects = _delete_rows(table, person, rows)
    removed = {'lists': len(lists), 'asks': len(asks), 'tokens': tokens, 'projects': projects}
    logger.info('Participant erased', extra={'person_id': person_id, **removed})
    return removed
