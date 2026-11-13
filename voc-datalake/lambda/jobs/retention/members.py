"""voc-retention: an erasure by email also reaches workspace memberships (docs/multi-workspace.md -> Invites).

A member added through the members routes (lambda/shared/workspace_members.py) carries the email and name Cognito
had then, raw, on their ``WS#{ws}`` / ``MEMBER#{sub}`` row in voc-workspaces. An erasure job with ``field: 'email'``
and no source (a membership belongs to no source) reaches those rows the way the boards pass reaches a board
request (``boards.py``): the row is DE-IDENTIFIED, not deleted. Its ``email`` and ``name`` are REMOVEd; the row keeps
the sub, the role, ``invited_by`` and ``joined_at``: it is access configuration, and the person's account (Cognito,
the deployment's directory) is not erased by this job: deleting the account is the users API's
(``DELETE /users/{username}``), which removes the memberships with it. While the account exists, the members list
fills a row without an email from Cognito, as for a workspace's creator (``list_members``).

How the rows are found: voc-workspaces has no email index, and an email can be on a row whose account was renamed
or deleted, so the pass walks the table with a paged Scan (``PAGE_SIZE`` items a page, the projected key and email
only, the job's time budget and hand-over cursor, like the boards pass). It runs once per erasure job, never on a
request path, and voc-workspaces is the control plane's table (workspaces, members, their audit), far smaller than
the feedback tables the job already scans. The match is made here, case-insensitively, because a member's email is
stored as Cognito spelled it (DynamoDB cannot lower-case in a filter).

For each matching row, in order: a tombstone (``AUDIT#tombstone#workspace_members`` / ``{ws}#{sub}#{job}`` in
voc-aggregates; the workspace, the run and the legal basis, never the email), written for the page before any row
changes; then the ``REMOVE`` of email and name, conditional on the row still being there. Counted as
``member_rows_deidentified`` on the job and audit rows. The membership's audit rows (``AUDIT#WS#{ws}``) hold subs
only, never an email (an ``account_created`` row holds the email's sha256), so there is nothing to erase there.

On voc-workspaces the worker may Scan and UpdateItem, the update pinned to ``WS#*`` and to the attributes ``email``
and ``name`` (lib/stacks/retention-worker.ts). IAM cannot pin the sort key, so a workspace's ``META`` (which has a
``name``) is in reach of IAM; the code updates ``MEMBER#`` rows only.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final

from jobs.retention import exports
from jobs.retention.boards import ERASE_FIELD, remove_fields
from jobs.retention.copies import tombstone_record
from jobs.retention.runs import MODE_ERASE
from shared.retention import MEMBER_COUNTER
from shared.timestamps import now_iso
from shared.workspace_ids import is_workspace_id
from shared.workspace_members import MEMBER_PREFIX as _MEMBER_SK_PREFIX
from shared.ws_repo import WORKSPACE_FIELD, scope_from_message

#: The tables key of voc-workspaces in ``Walk.tables``, and the tombstones' source.
STORE_MEMBERS: Final = 'workspace_members'
PAGE_SIZE: Final = 100
_WORKSPACE_PK_PREFIX: Final = 'WS#'
#: What a membership row stores about the person (REMOVEd).
_PERSON_FIELDS: Final = ('email', 'name')
_PROJECTION: Final = ('pk', 'sk', 'email')


def applies(run: Mapping[str, Any]) -> bool:
    """An erasure by email that is not limited to a source."""
    return run.get('mode') == MODE_ERASE and run.get('field') == ERASE_FIELD and not run.get('source')


def _matches(row: Mapping[str, Any], wanted: str) -> bool:
    pk, sk, email = row.get('pk'), row.get('sk'), row.get('email')
    return (isinstance(pk, str) and pk.startswith(_WORKSPACE_PK_PREFIX) and isinstance(sk, str)
            and sk.startswith(_MEMBER_SK_PREFIX) and isinstance(email, str) and email.strip().casefold() == wanted)


def scan_page(table: Any, value: str, cursor: Mapping[str, Any] | None) -> dict[str, Any]:
    """One page of the table, its ``Items`` narrowed to the membership rows that hold the email (any case)."""
    kwargs: dict[str, Any] = {
        'Limit': PAGE_SIZE,
        'FilterExpression': 'begins_with(#sk, :member) AND attribute_exists(#email)',
        'ProjectionExpression': ', '.join(f'#{name}' for name in _PROJECTION),
        'ExpressionAttributeNames': {f'#{name}': name for name in _PROJECTION},
        'ExpressionAttributeValues': {':member': _MEMBER_SK_PREFIX},
    }
    if cursor:
        kwargs['ExclusiveStartKey'] = dict(cursor)
    page = table.scan(**kwargs)
    wanted = value.strip().casefold()
    # Only the keys travel on: the email is not kept past the match.
    items = [{'pk': row['pk'], 'sk': row['sk']} for row in page.get('Items', []) if _matches(row, wanted)]
    return {**page, 'Items': items}


def _membership(row: Mapping[str, Any]) -> tuple[str, str]:
    """``(ws, sub)`` of a membership row's key."""
    return str(row['pk']).removeprefix(_WORKSPACE_PK_PREFIX), str(row['sk']).removeprefix(_MEMBER_SK_PREFIX)


def tombstone(run: Mapping[str, Any], row: Mapping[str, Any], now: str) -> dict[str, Any]:
    """One de-identified membership's record: the workspace, the member's sub, the run and the legal basis.

    Keyed ``{ws}#{sub}#{job}``: each erasure job that reaches the row keeps its own record (a later job never
    overwrites an earlier one's), and a job handed over or retried re-writes its own key.
    """
    ws, sub = _membership(row)
    job = run.get('job_id') or run['run_id']
    return {**tombstone_record(run, STORE_MEMBERS, f'{ws}#{sub}#{job}', STORE_MEMBERS, now),
            'workspace_id': ws, 'action': 'deidentified'}


def deidentify(table: Any, row: Mapping[str, Any]) -> bool:
    """REMOVE the email and name of a membership row; False when the row is gone meanwhile."""
    return remove_fields(table, row, _PERSON_FIELDS)


class MemberEraser:
    """De-identifies the matched membership rows of one page, counting into ``run``."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any]) -> None:
        self._run = run
        self._table = tables[STORE_MEMBERS]
        self._aggregates = tables['aggregates']

    def tombstones(self, rows: Sequence[Mapping[str, Any]]) -> None:
        """One tombstone per matched row, one PutItem each, before any row changes (copies.write_tombstones' rule)."""
        now = now_iso()
        for row in rows:
            self._aggregates.put_item(Item=tombstone(self._run, row, now))

    def erase(self, row: Mapping[str, Any]) -> None:
        # The workspace's exports hold the member's email in members/: closed before the row changes, cleared by
        # the `exports` phase.
        ws = str(row['pk']).removeprefix(_WORKSPACE_PK_PREFIX)
        if is_workspace_id(ws):
            exports.note_workspace(self._run, scope_from_message({WORKSPACE_FIELD: ws}), self._aggregates)
        if deidentify(self._table, row):
            self._run[MEMBER_COUNTER] = int(self._run.get(MEMBER_COUNTER) or 0) + 1
