"""Closing a room vote whose row or project is being deleted.

A room vote (``ballots_handler``) is a PUBLIC write window onto one prioritization row.
Deleting the row (``DELETE /projects/prioritization/rows/{row_id}``) or the project
(``DELETE /projects/{id}``) used to leave its open session readable and open: the public
config still answered 200 with the deleted row's title, and the facilitator status read
still showed it running. Both deletes now close the row's open session here.

The keys are declared ONCE here for both bundles (``ballots_handler`` writes the session and
the per-row pointer; ``projects_handler`` closes them on delete), the same arrangement as
``shared.prioritization_keys``.

    pk = VOTING_SESSION       sk = SESSION#{session_id}   the session
    pk = VOTING_SESSION_ROW   sk = ROW#{row_id}           the row's open vote (a pointer)

BEST EFFORT, by design: a failure is logged and the delete it rides on still succeeds,
because the delete is the user's request and the session is already harmless — the ballot
routes refuse any session whose row or project is gone (``ballots_handler`` reads them on
every public request). Closing it here is what makes the record SAY so, for the facilitator
status read and for the audit trail.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared.dynamo_paging import iter_query
from shared.engagement_common import conditional_write
from shared.logging import logger
from shared.prioritization_keys import PRIORITIZATION_PK, ROW_SK_PREFIX
from shared.timestamps import now_iso

VOTING_SESSION_PK: Final = 'VOTING_SESSION'
SESSION_SK_PREFIX: Final = 'SESSION#'
OPEN_ROW_SESSION_PK: Final = 'VOTING_SESSION_ROW'
OPEN_ROW_SESSION_SK_PREFIX: Final = 'ROW#'
STATUS_OPEN: Final = 'open'
STATUS_CLOSED: Final = 'closed'

# Rows of every project, scanned to find one project's: the bound keeps a corrupt
# partition from turning a project delete into an unbounded walk.
MAX_ROWS_SCANNED: Final = 5000


def open_row_session_key(row_id: str) -> dict[str, str]:
    """The key of a row's open-vote pointer."""
    return {'pk': OPEN_ROW_SESSION_PK, 'sk': f'{OPEN_ROW_SESSION_SK_PREFIX}{row_id}'}


def session_key(session_id: str) -> dict[str, str]:
    """The key of one session record."""
    return {'pk': VOTING_SESSION_PK, 'sk': f'{SESSION_SK_PREFIX}{session_id}'}


def _close_session(table: Any, session_id: str, now: str) -> bool:
    """Mark one session closed if it exists and is open; True when this call closed it
    (False: already closed, or gone — nothing to do)."""
    return conditional_write(
        table.update_item,
        Key=session_key(session_id),
        UpdateExpression='SET #status = :closed, closed_at = :now, updated_at = :now',
        ConditionExpression='attribute_exists(sk) AND #status = :open',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':closed': STATUS_CLOSED, ':open': STATUS_OPEN, ':now': now},
    )


def _close_one_row(table: Any, row_id: str, now: str) -> bool:
    pointer = table.get_item(Key=open_row_session_key(row_id), ConsistentRead=True).get('Item')
    session_id = pointer.get('session_id') if isinstance(pointer, dict) else None
    if not isinstance(session_id, str) or not session_id:
        return False
    closed = _close_session(table, session_id, now)
    # The pointer goes too: it names a vote that can no longer be the row's.
    table.delete_item(Key=open_row_session_key(row_id))
    return closed


def close_row_sessions(table: Any, row_ids: Iterable[str]) -> int:
    """Close the open room vote of each row; how many were closed. Never raises."""
    now = now_iso()
    closed = 0
    for row_id in row_ids:
        try:
            closed += int(_close_one_row(table, row_id, now))
        except (ClientError, BotoCoreError) as e:
            # The row id is server-minted; the session id is a credential and is not logged.
            logger.warning(f'Could not close the room vote of deleted row {row_id}: {e}')
    return closed


def project_row_ids(table: Any, project_id: str) -> list[str]:
    """Every prioritization row of one project (the rows carry ``project_id``)."""
    query = {
        'KeyConditionExpression': Key('pk').eq(PRIORITIZATION_PK) & Key('sk').begins_with(ROW_SK_PREFIX),
        'ProjectionExpression': 'sk, project_id',
        'ConsistentRead': True,
    }
    return [
        str(item['sk'])[len(ROW_SK_PREFIX):] for item in iter_query(table, query, max_items=MAX_ROWS_SCANNED)
        if item.get('project_id') == project_id
    ]


def close_project_sessions(table: Any, project_id: str) -> int:
    """Close the open room vote of every row of a project being deleted. Never raises."""
    if table is None:
        return 0
    try:
        row_ids = project_row_ids(table, project_id)
    except (ClientError, BotoCoreError) as e:
        logger.warning(f'Could not list the prioritization rows of deleted project {project_id}: {e}')
        return 0
    return close_row_sessions(table, row_ids)
