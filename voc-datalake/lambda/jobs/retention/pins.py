"""voc-retention: an erasure by email reaches the prototype pins' replies (7.98.00, projects 3g-pin; TENETS.md D5;
docs/multi-workspace.md, the project plan's 3g-pin).

A tester's pin on a prototype (shared/prototype_pins.py) lives in voc-aggregates, ``PINS#{form}`` / ``PIN#{pin}`` (a
workspace's ``WS#{ws}#PINS#{form}``, which no route writes before the switch, 3h), its thread in ``replies``. Until
7.48.00 a member's reply named its writer by their username, else their address (api/projects_handler.py
``_pin_actor``); since then by the username, else "Team member". A reply written before may still hold the address,
in its ``name`` (cut to ``MAX_NAME_CHARS``, as every name the API stored). The tester's own comment, console and route
are redacted of addresses when they are stored; a reply's ``by`` is a sub or an agent's id, an AI reply's
``approved_by`` a ``{sub, kind}``: none holds an address.

What an erasure does to a pin, the threads' rule (project_people.py): the row is DE-IDENTIFIED, never deleted. Each
reply whose ``name`` is the address (``casefold``, or its first ``MAX_NAME_CHARS`` characters) gets ``TEAM_MEMBER_NAME``
instead; its text, writer id and time stay (the thread is the team's review of the prototype, and the replies around
it are other people's). The writes, for one pin (``PinReplyEraser.erase``): its change is worked out from the row as
read; a record of the attempt is put (the projects walk's records, ``AUDIT#tombstone#deployment_projects`` or
``…#workspace_projects``, ``kind`` ``pin``, the form and pin ids: never the address); ONE UpdateItem sets ``replies``,
conditioned on ``replies`` being as read; on success the outcome is put beside it (``#done``) and the pin counts once
(``pin_replies_deidentified``). A pin that changed meanwhile (a reply appended) is read again, whole, at most
``MAX_TRIES`` times; past that, if a reply still holds the address, the job fails (``RowKeptChanging``) and an admin
runs it again (every step is idempotent). A workspace's pins are read and written through the workspace layer
(shared/ws_repo.py ``ws_table``), the deployment's as the table itself; the deployment's walk refuses a workspace's
row. No workspace export carries a pin, so a change closes no workspace's exports (an operator's project bundle
does: scripts/project_bundle/exporter.py, 3g-bundle).

How the pins are found, without a Scan (project_people.py walks them as parts of its own walk, and hands over with
its cursor):

- each walked project's prototypes: its ``PROTOTYPE#{document}`` rows (a page of keys, by Query of its partition),
  each prototype's pin form being ``pin_form_id(document)``, then that form's pins, a page at a time (``PIN_PAGE``);
- the scope's pin forms (``FORM#pf_…`` of its forms partition, ``FEEDBACK_FORM`` / ``WS#{ws}#FEEDBACK_FORM``, keys only),
  after its projects: a project's or a prototype's delete leaves its pin form and its pins (only the forms page's delete
  removes a form, and it leaves the pins). A live prototype's form is reached both ways and its pins read twice; the
  second walk finds nothing left to change (3g-pin-once).

What it cannot reach: a pin whose prototype row is gone AND whose form was deleted from the forms page (3g-pin2: since
7.55.00 that delete's ``AUDIT#delete`` row, ``feedback_form#{form}``, still names it, which the walk does not read yet);
and a reply's text that names the person (never searched).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.retention import workspaces
from jobs.retention.deidentify import MAX_TRIES, RowKeptChanging, id_page, same_name
from shared.aws import is_conditional_check_failure
from shared.digests import sha256_hex
from shared.document_comments import TEAM_MEMBER_NAME
from shared.ingest_tables import table_view
from shared.project_keys import PROTOTYPE_SK_PREFIX, project_pk
from shared.project_walk import ID_PAGE, checked_ids, checked_key, is_project_id, merged, query_page, sort_key
from shared.prototype_pins import (
    PIN_FORM_SK_PREFIX,
    is_pin_form_id,
    is_pin_id,
    pin_form_id,
    pin_forms_pk,
    pins_pk,
)
from shared.retention import PIN_COUNTER
from shared.scoped_query import SK_BEGINS, SK_EQUALS
from shared.ws_repo import FORM_LOOKUP_PREFIX, WORKSPACE_KEY_PREFIX, OutOfScopeError, WorkspaceScope

#: The records' kind of a pin's change (beside project_people.py's thread, link, project and persona).
KIND: Final = 'pin'
#: The pins one step reads at most (a pin holds up to 50 replies of up to 2,000 characters each).
PIN_PAGE: Final = 25
#: The attribute the write names (besides the key): the voc-aggregates grant is the table's, no attribute limit.
REPLIES: Final = 'replies'
_PIN_SK_PREFIX: Final = 'PIN#'
_PROJECTION: Final = {'ProjectionExpression': '#pk, #sk, #r',
                      'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk', '#r': REPLIES}}

#: Records one step of a pin's de-identification: ``(scope, sort key, action)`` (project_people.py ``_record``).
Record = Callable[[WorkspaceScope | None, str, str], None]


def replies_without(replies: object, value: str) -> list[Any] | None:
    """The thread with each reply whose ``name`` is the address (``value``) renamed ``TEAM_MEMBER_NAME``, every other
    field and reply as it was; None when no reply's name is the address."""
    if not isinstance(replies, list):
        return None
    wanted = value.strip().casefold()
    hit = [isinstance(reply, Mapping) and same_name(reply.get('name'), wanted) for reply in replies]
    if not any(hit):
        return None
    return [{**reply, 'name': TEAM_MEMBER_NAME} if matched else reply
            for reply, matched in zip(replies, hit, strict=True)]


class PinReplyEraser:
    """One erasure's de-identification of the pins' replies (the module docstring): the steps project_people.py's walk
    takes, each one Query page with its writes."""

    def __init__(self, run: dict[str, Any], aggregates: Any, value: str, *, record: Record,
                 time_left: Callable[[], bool] = lambda: True) -> None:
        self.run = run
        self._aggregates = aggregates
        self._value = value
        self._record = record
        self._time_left = time_left

    # ── The steps ─────────────────────────────────────────────────────────────────────────────────────────────────

    def prototype_page(self, view: Any, scope: WorkspaceScope | None, project_id: str,
                       at: dict[str, Any]) -> dict[str, Any]:
        """The next page of the project's prototypes (``PROTOTYPE#`` rows of its partition in voc-projects, ``view``,
        keys only): their pin forms to walk; a document id not shaped like one counted (``project_ids_malformed``)."""
        shaped, following = id_page(view, project_pk(project_id, workspace=scope), at.get('prototypes_from'),
                                    PROTOTYPE_SK_PREFIX, is_project_id, self.run)
        return {**at, 'prototypes': [pin_form_id(document) for document in shaped], 'prototypes_from': following,
                'prototypes_listed': following is None, 'prototype_pins_from': None}

    def form_page(self, scope: WorkspaceScope | None, at: dict[str, Any]) -> dict[str, Any]:
        """The next page of the scope's pin forms (``FORM#pf_…`` of its forms partition, keys only)."""
        rows, following = query_page(table_view(scope, self._aggregates), pin_forms_pk(workspace=scope),
                                     checked_key(at.get('pin_forms_from')), Limit=ID_PAGE, ConsistentRead=True,
                                     **merged(sort_key(SK_BEGINS, {':sk': PIN_FORM_SK_PREFIX}),
                                              {'ProjectionExpression': '#sk'}))
        forms = [str(row.get('sk', '')).removeprefix(FORM_LOOKUP_PREFIX) for row in rows]
        # A hand-made form id that only starts like a pin form's is no pin form: skipped, not counted.
        return {**at, 'pin_forms': [form for form in forms if is_pin_form_id(form)], 'pin_forms_from': following,
                'pin_forms_done': following is None, 'pins_from': None}

    def pins_step(self, scope: WorkspaceScope | None, at: dict[str, Any], listed: str,
                  start: str) -> dict[str, Any]:
        """One page of the pins of the first form ``at[listed]`` names, from ``at[start]``; that form off the list once
        its pins are done."""
        forms = checked_ids(at.get(listed), is_pin_form_id, listed)
        following, done = self.pin_page(scope, forms[0], at.get(start))
        return {**at, listed: forms[1:], start: None} if done else {**at, start: following}

    def pin_page(self, scope: WorkspaceScope | None, form_id: str,
                 start: object) -> tuple[dict[str, Any] | None, bool]:
        """One page of a form's pins (``PIN_PAGE``, strongly consistent, each pin's key and replies), each
        de-identified; cut after a pin when the time runs low. The key the next page starts from, and whether the
        form's pins are done."""
        rows, following = query_page(table_view(scope, self._aggregates), pins_pk(form_id, workspace=scope), checked_key(start),
                                     Limit=PIN_PAGE, ConsistentRead=True,
                                     **merged(sort_key(SK_BEGINS, {':sk': _PIN_SK_PREFIX}), _PROJECTION))
        for n, row in enumerate(rows):
            self.erase(scope, row, form_id)
            if n < len(rows) - 1 and not self._time_left():
                return {'pk': row['pk'], 'sk': row['sk']}, False
        return following, following is None

    # ── The writes ────────────────────────────────────────────────────────────────────────────────────────────────

    def erase(self, scope: WorkspaceScope | None, row: Mapping[str, Any], form_id: str) -> None:
        """De-identify one pin (the module docstring, "The writes")."""
        key = {'pk': str(row['pk']), 'sk': str(row['sk'])}
        pin_id = key['sk'].removeprefix(_PIN_SK_PREFIX)
        # A pin id names a time and random hex, never a person; anything else is named by a digest of its key.
        ref = f'{form_id}#{pin_id if is_pin_id(pin_id) else sha256_hex(key["sk"])[:24]}'
        job = self.run.get('job_id') or self.run['run_id']
        # A workspace's record names it first, as the threads' do: the workspaces share one record partition.
        record = f'{scope.ws}#{KIND}#{ref}#{job}' if scope is not None else f'{KIND}#{ref}#{job}'
        current: Mapping[str, Any] = row
        for _try in range(MAX_TRIES):
            replies = replies_without(current.get(REPLIES), self._value)
            if replies is None:
                return
            self._record(scope, record, 'deidentifying')
            if self._write(scope, current, replies):
                self._record(scope, f'{record}#done', 'deidentified')
                workspaces.count(self.run, PIN_COUNTER)
                return
            rows, _ = query_page(table_view(scope, self._aggregates), key['pk'], None, ConsistentRead=True,
                                 **merged(sort_key(SK_EQUALS, {':sk': key['sk']}), _PROJECTION))
            if not rows:
                return
            current = rows[0]
        if replies_without(current.get(REPLIES), self._value) is not None:
            raise RowKeptChanging('A pin kept changing while an address was being erased from its replies')

    def _write(self, scope: WorkspaceScope | None, row: Mapping[str, Any], replies: list[Any]) -> bool:
        """One UpdateItem of ``replies``, conditioned on them being as read; False when the pin changed meanwhile."""
        if scope is None and str(row['pk']).startswith(WORKSPACE_KEY_PREFIX):
            # The deployment's walk writes the deployment's pins only (a workspace's go through its own layer).
            raise OutOfScopeError("the deployment's erasure writes no workspace's pin")
        try:
            table_view(scope, self._aggregates).update_item({'pk': row['pk'], 'sk': row['sk']}, UpdateExpression='SET #r = :new',
                                          ConditionExpression='attribute_exists(pk) AND #r = :old',
                                          ExpressionAttributeNames={'#r': REPLIES},
                                          ExpressionAttributeValues={':new': replies, ':old': row[REPLIES]})
        except ClientError as error:
            if is_conditional_check_failure(error):
                return False
            raise
        return True
