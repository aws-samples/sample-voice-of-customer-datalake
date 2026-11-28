"""A project's product context as written, its product proposals and their review, and the extract's lock and limits
(7.104.00, docs/project-workspace.md → Product tab).

Rows in the project's partition (shared/project_keys.py ``project_pk``): every key takes the workspace, a required
keyword (3h-S1b's rule, shared/test/test_project_workspace_keyword.py ``GUARDED``). Since 7.106.00 (3h-S3b) the context's
reader and writer, the latest proposal, an accept, a dismiss and a deleted source's ``forget_source`` act in the
workspace they are given (its project's partition, ``WS#{ws}#PROJECT#{id}``; an accept's audit row is in
``WS#{ws}#AUDIT#product_context`` and names it, ``workspace``); the extract's own stores (``put_proposal``, the lock, ``count_extract``, whose counters take
``WS#{ws}#`` already) still refuse one (``PRODUCT_EXTRACT_STORE``, NotPerWorkspaceError) until the extract's job moves
(3h-S8):

* ``PRODUCT_CONTEXT``: the product context (shared/product_fields.py's 12 fields), with ``field_meta.{field}`` =
  ``{by, sub, at}`` (and an accept's ``proposal_id`` and ``source_ids``): who last wrote each field, ``by`` one of
  ``person``, ``assistant`` (an MCP client, an agent or a plan step) and ``extract`` (an accepted value as the extract
  proposed it). This module is its one reader (``context_state``) and its one writer: ``write_context`` (PUT
  …/product-context, api/product_context.py ``update_context``) and ``accept``.
* ``PRODUCT_PROPOSAL#{stamp}#{hex}`` (``proposal_id`` ``pp_{stamp}_{hex}``, the newest last): one per extract
  (shared/product_extract.py), with its ``status`` (``open``, ``partly_applied``, ``applied``, ``dismissed``,
  ``superseded``), ``job_id``, ``created_by``, ``model`` (the model that answered, the one asked for, the effort and
  the usage), ``prompt_version``, its ``sources`` (``S1``…: ``doc_id``, name, kind, characters sent, ``cut``) and
  ``skipped_sources``, its ``fields`` (each of the 12: ``status``, ``value``, ``citations``, ``confidence``, ``note``,
  ``seen``, ``accepted``) and its ``questions``. A new proposal supersedes every open one before it. A source's delete
  takes its citations, and so its quoted words, out of every proposal (``forget_source``); the values, notes and the
  source's name stay, the source marked deleted.
* ``PRODUCT_EXTRACT``: the lock, held by one extract at a time (its ``lock_id``), stale after ``LOCK_STALE_SECONDS``;
  released by an update, never deleted.

THE ONE RULE of a value a person typed (owner decision 4: an MCP client, an agent or a plan never replaces one):
``person_typed``, a field with a value whose ``field_meta`` says ``by: person``, or that has no ``field_meta`` entry
at all (a value written before 7.104.00 recorded who wrote it is taken for a person's). An autonomous caller's write
(shared/ai_writing.py ``writing_kind``) leaves such a field as it is: a ``person_value`` conflict when it would change
it, and each write's condition holds it to no person having written the field since the read.

Every write is one transaction with the project's writable check, conditional on each written field's stored value as
read: an accept's is the value the reviewer saw (``seen``), a field changed since is a ``changed`` conflict; a PUT's is
the value it just read. A lost race is read again once, then answered 503 ``busy``. An accept also writes the
proposal's ``accepted`` marks and status (conditional on its ``updated_at`` as read, so two accepts never lose each
other's marks) and an audit row (ids only, never content; ``audit_pk``: ``AUDIT#product_context``, a workspace's
under ``WS#{ws}#``), all in the one transaction; an accepted value the reviewer edited is
recorded as theirs (``by`` ``person``, or ``assistant`` for an autonomous caller), the proposal's id and sources kept.

The limits are shared/aws.py ``count_once`` counters in voc-aggregates (``extract_counter_keys``, a workspace's under
``WS#{ws}#``), all three counted at once or none: 1 extract a minute and 10 a day per project, 20 a day per person
(429 ``rate_limited``).
"""
from __future__ import annotations

import re
import secrets
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Final

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import (
    TRANSACTION_CONFLICT,
    Counter,
    cancellation_codes,
    cancelled_by_condition,
    consistent_item,
    count_once,
    update_unless_condition_fails,
)
from shared.dynamo_paging import query_all
from shared.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.logging import logger
from shared.product_fields import ALL_FIELDS, FIELD_LABELS, STRING_FIELDS, clean_patch_value
from shared.project_keys import (
    PRODUCT_CONTEXT_SK,
    PRODUCT_EXTRACT_SK,
    PRODUCT_EXTRACT_STORE,
    PRODUCT_PROPOSAL_SK_PREFIX,
    project_pk,
    require_deployment,
)
from shared.project_writes import NEW_ROW_CONDITION, projects_table_name, transact_project_actions
from shared.scoped_keys import scoped_pk
from shared.timestamps import now_iso

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = [
    'EFFORTS', 'FIELD_ORDER', 'OPEN', 'Actor', 'ContextState', 'accept', 'context_state', 'count_extract', 'dismiss',
    'forget_source', 'latest_row', 'mapping_at', 'new_proposal_key', 'note_lock_job', 'person_typed', 'proposal_dto',
    'put_proposal', 'release_lock', 'take_lock', 'write_context', 'written_by',
]

#: The 12 fields in the form's PRD-block order (shared/product_fields.py).
FIELD_ORDER: Final = tuple(name for name, _ in FIELD_LABELS)
OPEN: Final = 'open'
PARTLY_APPLIED: Final = 'partly_applied'
APPLIED: Final = 'applied'
DISMISSED: Final = 'dismissed'
SUPERSEDED: Final = 'superseded'
#: The statuses a proposal can still be accepted or dismissed in.
OPEN_STATUSES: Final = (OPEN, PARTLY_APPLIED)
#: The efforts an extract may ask for: ``max`` on every run, ``xhigh`` for a person's retry after a timeout (owner
#: decision 10).
EFFORTS: Final = ('max', 'xhigh')
#: The field statuses an accept may write.
ACCEPTABLE: Final = ('proposed', 'conflict')
BY_EXTRACT: Final = 'extract'
BY_PERSON: Final = 'person'
#: An MCP client, an agent or a plan step (an autonomous caller): its own writes.
BY_ASSISTANT: Final = 'assistant'
#: The conflict of an autonomous caller over a value a person typed (an accept, and PUT …/product-context; owner
#: decision 4).
PERSON_VALUE: Final = 'person_value'
PERSON_VALUE_MESSAGE: Final = ('A person typed every one of these fields: an MCP client, an agent or a plan never '
                               'replaces them')
AUDIT_PK: Final = 'AUDIT#product_context'
AUDIT_KIND: Final = 'product_proposal_accepted'
LOCK_STALE_SECONDS: Final = 16 * 60
EXTRACTS_PER_MINUTE: Final = 1
PROJECT_EXTRACTS_PER_DAY: Final = 10
PERSON_EXTRACTS_PER_DAY: Final = 20
PROPOSAL_CLOSED_MESSAGE: Final = 'This proposal is closed: extract again for a new one'
BUSY_MESSAGE: Final = 'Another change to this product description is being saved. Try again.'
_STAMP: Final = '%Y%m%dT%H%M%S%fZ'
_PROPOSAL_ID: Final = re.compile(r'pp_(\d{8}T\d{12}Z)_([0-9a-f]{12})')
#: Where each transaction entry sits after the project's writable check (index 0).
_CONTEXT_AT: Final = 1
_PROPOSAL_AT: Final = 2


# ── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────────


def new_proposal_key(project_id: str, now: datetime, *,
                     workspace: WorkspaceScope | None) -> tuple[str, dict[str, str]]:
    """A new proposal's id and key: its creation time, then a random suffix, so the newest sorts last."""
    stamp, suffix = now.astimezone(UTC).strftime(_STAMP), secrets.token_hex(6)
    return f'pp_{stamp}_{suffix}', {'pk': project_pk(project_id, workspace=workspace),
                                    'sk': f'{PRODUCT_PROPOSAL_SK_PREFIX}{stamp}#{suffix}'}


def _proposal_key(project_id: str, proposal_id: str, *, workspace: WorkspaceScope | None) -> dict[str, str]:
    """The key ``proposal_id`` names, or 404 for an id shaped like no proposal's."""
    match = _PROPOSAL_ID.fullmatch(proposal_id)
    if match is None:
        raise NotFoundError('Proposal not found')
    return {'pk': project_pk(project_id, workspace=workspace),
            'sk': f'{PRODUCT_PROPOSAL_SK_PREFIX}{match.group(1)}#{match.group(2)}'}


def _context_key(project_id: str, *, workspace: WorkspaceScope | None) -> dict[str, str]:
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': PRODUCT_CONTEXT_SK}


def _lock_key(project_id: str, *, workspace: WorkspaceScope | None) -> dict[str, str]:
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': PRODUCT_EXTRACT_SK}


def _proposals_partition(project_id: str, *, workspace: WorkspaceScope | None) -> Any:
    """The key condition of every proposal row of the project."""
    return (Key('pk').eq(project_pk(project_id, workspace=workspace))
            & Key('sk').begins_with(PRODUCT_PROPOSAL_SK_PREFIX))


# ── The product context as stored ──────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ContextState:
    """The product context's row as read: each field's value as text, its stored attribute (None when absent),
    who wrote each field (``field_meta``), whether the row and its ``field_meta`` exist, and ``updated_at``."""

    values: dict[str, str]
    stored: dict[str, Any]
    meta: dict[str, dict[str, Any]]
    exists: bool
    has_meta: bool
    updated_at: str | None


def _text(value: object) -> str:
    """A stored field as text: a list (the schema before the fields were text) joined by lines."""
    if isinstance(value, list):
        return '\n'.join(str(entry) for entry in value if entry).strip()
    return value if isinstance(value, str) else ''


def context_state(table: Any, project_id: str, *, workspace: WorkspaceScope | None) -> ContextState:
    """The product context's row, read strongly: the one reader of it (the routes, the PRD / PR-FAQ block, the
    extract, the voice interviewer), in ``workspace`` (None: the deployment)."""
    item = consistent_item(table, _context_key(project_id, workspace=workspace)) or {}
    meta = item.get('field_meta')
    return ContextState(
        values={name: _text(item.get(name)) for name in FIELD_ORDER},
        stored={name: item[name] for name in FIELD_ORDER if name in item},
        meta={name: dict(entry) for name, entry in meta.items() if name in ALL_FIELDS and isinstance(entry, Mapping)}
        if isinstance(meta, Mapping) else {},
        exists=bool(item), has_meta=isinstance(meta, Mapping),
        updated_at=item.get('updated_at') if isinstance(item.get('updated_at'), str) else None)


def written_by(state: ContextState, name: str) -> str | None:
    """Who wrote field ``name`` as the one rule reads it: its ``field_meta`` entry's ``by``, ``person`` for a value with
    no entry (written before 7.104.00 recorded who wrote it), None for an empty field."""
    if not state.values[name]:
        return None
    by = state.meta.get(name, {}).get('by')
    return by if isinstance(by, str) and by else BY_PERSON


def person_typed(state: ContextState, name: str) -> bool:
    """Whether field ``name`` holds a value a person typed (``written_by``): one an autonomous caller never replaces."""
    return written_by(state, name) == BY_PERSON


# ── Proposals ──────────────────────────────────────────────────────────────────────────────────────────────────


def put_proposal(table: Any, project_id: str, item: Mapping[str, Any], *, workspace: WorkspaceScope | None) -> None:
    """Put a new proposal (refused for a deleted project) and supersede every open one before it. The extract's
    (refused in a workspace until its job moves, 3h-S8)."""
    require_deployment(workspace, PRODUCT_EXTRACT_STORE)
    transact_project_actions(table, project_id, [{'Put': {
        'TableName': projects_table_name(table), 'Item': dict(item), 'ConditionExpression': NEW_ROW_CONDITION}}],
        workspace=workspace)
    older = query_all(table, {
        'KeyConditionExpression': _proposals_partition(project_id, workspace=workspace),
        'FilterExpression': Attr('status').is_in(list(OPEN_STATUSES)),
        'ProjectionExpression': 'pk, sk', 'ConsistentRead': True,
    })
    for row in older:
        if row['sk'] != item['sk']:
            update_unless_condition_fails(
                table, Key={'pk': row['pk'], 'sk': row['sk']},
                UpdateExpression='SET #status = :superseded, updated_at = :now',
                ConditionExpression='#status IN (:open, :partly)', ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':superseded': SUPERSEDED, ':now': item['created_at'], ':open': OPEN,
                                           ':partly': PARTLY_APPLIED})


def latest_row(table: Any, project_id: str, *, workspace: WorkspaceScope | None) -> dict[str, Any] | None:
    """The project's newest proposal row, whatever its status, or None."""
    response = table.query(KeyConditionExpression=_proposals_partition(project_id, workspace=workspace),
                           ScanIndexForward=False, Limit=1, ConsistentRead=True)
    items = response.get('Items') or []
    return items[0] if items else None


def _plain(value: object) -> object:
    """A stored value as JSON reads it: DynamoDB's Decimals as ints, in maps and lists too."""
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, Mapping):
        return {key: _plain(inner) for key, inner in value.items()}
    if isinstance(value, list):
        return [_plain(inner) for inner in value]
    return value


def mapping_at(row: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    """``row[key]`` when it is a map, else an empty one (a stored row read by a later release: never trusted)."""
    value = row.get(key)
    return value if isinstance(value, Mapping) else {}


def proposal_dto(row: Mapping[str, Any], state: ContextState, live_doc_ids: Iterable[str]) -> dict[str, Any]:
    """A proposal as GET …/product-proposals/latest answers it: each field with its ``current`` value and whether it
    changed since the extract, each source with whether it was deleted since."""
    live = set(live_doc_ids)
    stored_fields = mapping_at(row, 'fields')
    fields = {}
    for name in FIELD_ORDER:
        plain = _plain(mapping_at(stored_fields, name))
        entry: Mapping[str, Any] = plain if isinstance(plain, dict) else {}
        seen = str(entry.get('seen') or '')
        fields[name] = {'status': entry.get('status', 'gap'), 'value': str(entry.get('value') or ''),
                        'citations': entry.get('citations') or [], 'confidence': entry.get('confidence', 'low'),
                        'note': str(entry.get('note') or ''), 'seen': seen, 'accepted': bool(entry.get('accepted')),
                        'current': state.values[name], 'changed_since': state.values[name] != seen}
    model = mapping_at(row, 'model')
    listed = _plain(row.get('sources') or [])
    sources = [{**source, 'deleted': source.get('doc_id') not in live}
               for source in (listed if isinstance(listed, list) else []) if isinstance(source, dict)]
    return {'proposal_id': row.get('proposal_id'), 'status': row.get('status'), 'job_id': row.get('job_id'),
            'created_at': row.get('created_at'), 'model_id': model.get('id'), 'effort': model.get('effort'),
            'sources': sources, 'skipped_sources': _plain(row.get('skipped_sources') or []), 'fields': fields,
            'questions': _plain(row.get('questions') or [])}


def _proposal(table: Any, project_id: str, proposal_id: str, *,
              workspace: WorkspaceScope | None) -> tuple[dict[str, str], dict[str, Any]]:
    key = _proposal_key(project_id, proposal_id, workspace=workspace)
    row = consistent_item(table, key)
    if row is None:
        raise NotFoundError('Proposal not found')
    return key, row


def dismiss(table: Any, project_id: str, proposal_id: str, now: str | None = None, *,
            workspace: WorkspaceScope | None) -> dict[str, str]:
    """Dismiss an open proposal (again: the same answer); 409 ``proposal_closed`` once applied or superseded."""
    key, row = _proposal(table, project_id, proposal_id, workspace=workspace)
    if row.get('status') != DISMISSED and not update_unless_condition_fails(
            table, Key=key, UpdateExpression='SET #status = :dismissed, updated_at = :now',
            ConditionExpression='#status IN (:open, :partly)', ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':dismissed': DISMISSED, ':now': now or now_iso(), ':open': OPEN,
                                       ':partly': PARTLY_APPLIED}):
        raise ConflictError(PROPOSAL_CLOSED_MESSAGE, code='proposal_closed')
    return {'proposal_id': proposal_id, 'status': DISMISSED}


# ── Accept ────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Actor:
    """Who accepts: the caller's subject and kind (shared/delete_audit.py ``actor_from_event``), and whether the call
    is autonomous (an MCP client, an agent or a plan: shared/ai_writing.py ``writing_kind``)."""

    sub: str
    kind: str
    autonomous: bool

    @property
    def by(self) -> str:
        """``field_meta.by`` of a value this caller wrote itself: an assistant's, or a person's."""
        return BY_ASSISTANT if self.autonomous else BY_PERSON

    def meta(self, now: str, by: str | None = None) -> dict[str, str]:
        return {'by': by or self.by, 'sub': self.sub, 'at': now}


def _requested(body: Mapping[str, Any], fields: Mapping[str, Any]) -> dict[str, tuple[str, str]]:
    """Each requested field and its (seen, value): the proposal's value, or the reviewer's edit, capped."""
    requested = body.get('fields')
    if not isinstance(requested, Mapping) or not requested or len(requested) > len(FIELD_ORDER):
        raise ValidationError(f'fields must map 1 to {len(FIELD_ORDER)} product fields to {{seen, value?}}')
    out: dict[str, tuple[str, str]] = {}
    for name, entry in requested.items():
        if name not in ALL_FIELDS:
            raise ValidationError(f'Unknown field: {str(name)[:40]}')
        proposed = mapping_at(fields, name)
        if not isinstance(entry, Mapping) or not isinstance(entry.get('seen'), str):
            raise ValidationError(f'{name} needs the value it was seen at (seen)')
        if proposed.get('status') not in ACCEPTABLE:
            raise ValidationError(f'{name} has no proposed value to accept')
        value = clean_patch_value(name, entry.get('value', proposed.get('value')))
        if not value or not value.strip():
            raise ValidationError(f'{name} needs a value')
        out[name] = (entry['seen'], value.strip() if name in STRING_FIELDS else value)
    return out


def _conflicts(requested: Mapping[str, tuple[str, str]], state: ContextState,
               actor: Actor) -> list[dict[str, str]]:
    conflicts = []
    for name, (seen, _value) in requested.items():
        if state.values[name] != seen:
            conflicts.append({'field': name, 'reason': 'changed'})
        elif actor.autonomous and person_typed(state, name):
            conflicts.append({'field': name, 'reason': PERSON_VALUE})
    return conflicts


def _source_ids(proposed: Mapping[str, Any], sources: Iterable[Mapping[str, Any]]) -> list[str]:
    by_id = {source.get('source_id'): source.get('doc_id') for source in sources}
    cited = [by_id.get(citation.get('source_id')) for citation in proposed.get('citations') or []
             if isinstance(citation, Mapping)]
    return list(dict.fromkeys(doc_id for doc_id in cited if isinstance(doc_id, str)))


@dataclass(frozen=True)
class _Write:
    """One accept's writes: the fields and their values, their ``field_meta`` entries, the time."""

    values: dict[str, str]
    meta: dict[str, dict[str, Any]]
    now: str


def _context_entry(table_name: str, project_id: str, state: ContextState, write: _Write,
                   actor: Actor, *, workspace: WorkspaceScope | None) -> dict[str, Any]:
    """The context's write: an update conditional on every written field's stored value as read (and, for an
    autonomous caller, on no person having written a field it replaces since: ``person_typed``'s rule, a written
    field that had a value having a ``field_meta`` entry not ``by`` a person), or the row's put when it does not
    exist yet."""
    if not state.exists:
        item = {**_context_key(project_id, workspace=workspace), 'created_at': write.now, 'updated_at': write.now,
                **dict.fromkeys(FIELD_ORDER, ''), **write.values, 'field_meta': write.meta}
        return {'Put': {'TableName': table_name, 'Item': item, 'ConditionExpression': NEW_ROW_CONDITION}}
    names: dict[str, str] = {}
    values: dict[str, Any] = {':now': write.now}
    sets, conditions = ['updated_at = :now'], ['attribute_exists(pk)']
    for index, (name, value) in enumerate(write.values.items()):
        names[f'#f{index}'], values[f':v{index}'] = name, value
        sets.append(f'#f{index} = :v{index}')
        if name in state.stored:
            values[f':s{index}'] = state.stored[name]
            conditions.append(f'#f{index} = :s{index}')
        else:
            conditions.append(f'attribute_not_exists(#f{index})')
        if state.has_meta:
            values[f':m{index}'] = write.meta[name]
            sets.append(f'#meta.#f{index} = :m{index}')
        if actor.autonomous and state.values[name]:
            names['#by'], values[':person'] = 'by', BY_PERSON
            conditions.append(f'attribute_exists(#meta.#f{index}.#by) AND #meta.#f{index}.#by <> :person')
    if write.values:
        names['#meta'] = 'field_meta'
        if state.has_meta:
            conditions.append('attribute_exists(#meta)')
        else:
            values[':meta'] = write.meta
            sets.append('#meta = :meta')
            conditions.append('attribute_not_exists(#meta)')
    update: dict[str, Any] = {'TableName': table_name, 'Key': _context_key(project_id, workspace=workspace),
                              'UpdateExpression': 'SET ' + ', '.join(sets),
                              'ConditionExpression': ' AND '.join(conditions), 'ExpressionAttributeValues': values}
    if names:
        update['ExpressionAttributeNames'] = names
    return {'Update': update}


def _cancelled(error: ClientError, *retried: int) -> bool:
    """A cancelled transaction (shared/aws.py's one reader): True when one of the ``retried`` entries' conditions lost
    a race (read again); the project's writable check is a 404 and contention (another transaction on these rows, no
    condition failed) a 503 ``busy``, never taken for a changed field; anything else is raised."""
    if any(cancelled_by_condition(error, index) for index in retried):
        return True
    if cancelled_by_condition(error, 0):
        raise NotFoundError('Project not found') from error
    if TRANSACTION_CONFLICT in cancellation_codes(error):
        raise ServiceUnavailableError(BUSY_MESSAGE, code='busy') from error
    raise error


def _twice(attempt: Any) -> Any:
    """``attempt()`` until it answers (not None), at most twice: a race lost twice is 503 ``busy``."""
    for _ in range(2):
        result = attempt()
        if result is not None:
            return result
    raise ServiceUnavailableError(BUSY_MESSAGE, code='busy')


# ── PUT …/product-context ──────────────────────────────────────────────────────────────────────────────────────


def _patch_once(table: Any, project_id: str, patch: Mapping[str, str], actor: Actor, *,
                workspace: WorkspaceScope | None) -> list[dict[str, str]] | None:
    state = context_state(table, project_id, workspace=workspace)
    conflicts: list[dict[str, str]] = []
    written: dict[str, str] = {}
    for name, value in patch.items():
        if actor.autonomous and person_typed(state, name):
            # A person's value the patch would change is a conflict; one it would leave as it is is not written either
            # (its author stays the person).
            if value != state.values[name]:
                conflicts.append({'field': name, 'reason': PERSON_VALUE})
            continue
        written[name] = value
    if conflicts and not written:
        raise ConflictError(PERSON_VALUE_MESSAGE, code='conflict', details={'conflicts': conflicts})
    now = now_iso()
    write = _Write(written, {name: actor.meta(now) for name in written}, now)
    try:
        transact_project_actions(table, project_id, [
            _context_entry(projects_table_name(table), project_id, state, write, actor, workspace=workspace)],
            workspace=workspace)
    except ClientError as error:
        if _cancelled(error, _CONTEXT_AT):
            return None
    return conflicts


def write_context(table: Any, project_id: str, patch: Mapping[str, str], actor: Actor, *,
                  workspace: WorkspaceScope | None) -> list[dict[str, str]]:
    """Write a validated patch (each field's value as PUT …/product-context sends it), creating the row on its first
    write: an accept of the values as they are now. Each field written is recorded as ``actor``'s (``field_meta``).
    An autonomous caller never replaces a value a person typed (``person_typed``): those fields are answered as
    ``person_value`` conflicts and the rest is written; when every field is one, 409 ``conflict`` carrying them. A
    write in between (a person typing) is caught by the write's condition and read again once."""
    return _twice(lambda: _patch_once(table, project_id, patch, actor, workspace=workspace))


def _status_after(fields: Mapping[str, Any], accepted: Iterable[str]) -> str:
    done = set(accepted) | {name for name, entry in fields.items()
                            if isinstance(entry, Mapping) and entry.get('accepted')}
    wanted = {name for name, entry in fields.items() if isinstance(entry, Mapping) and entry.get('status') in ACCEPTABLE}
    return APPLIED if wanted <= done else PARTLY_APPLIED


def _proposal_entry(table_name: str, key: Mapping[str, str], applied: Iterable[str], status: str,
                    now: str) -> dict[str, Any]:
    names = {'#status': 'status', '#fields': 'fields', '#accepted': 'accepted'}
    values: dict[str, Any] = {':status': status, ':now': now, ':true': True, ':open': OPEN, ':partly': PARTLY_APPLIED}
    sets = ['#status = :status', 'updated_at = :now']
    for index, name in enumerate(applied):
        names[f'#a{index}'] = name
        sets.append(f'#fields.#a{index}.#accepted = :true')
    return {'Update': {'TableName': table_name, 'Key': dict(key), 'UpdateExpression': 'SET ' + ', '.join(sets),
                       'ConditionExpression': '#status IN (:open, :partly)',
                       'ExpressionAttributeNames': names, 'ExpressionAttributeValues': values}}


def _audit_item(project_id: str, proposal: Mapping[str, Any], applied: list[str], actor: Actor,
                now: str, *, workspace: WorkspaceScope | None) -> dict[str, Any]:
    """The accept's audit row (ids only, never content) in ``audit_pk``'s partition, naming its workspace
    (``workspace``) when it is one's, as a deleted product document's ``AUDIT#delete`` row does."""
    model = mapping_at(proposal, 'model')
    item = {'pk': audit_pk(workspace=workspace), 'sk': f'{now}#{secrets.token_hex(8)}', 'kind': AUDIT_KIND,
            'project_id': project_id, 'proposal_id': proposal.get('proposal_id'), 'fields': applied,
            'actor': {'sub': actor.sub, 'kind': actor.kind}, 'model_id': model.get('id'), 'at': now}
    if workspace is not None:
        item['workspace'] = workspace.ws
    return item


def audit_pk(*, workspace: WorkspaceScope | None) -> str:
    """The accepts' audit partition: ``AUDIT#product_context`` for the deployment, ``WS#{ws}#AUDIT#product_context``
    for a workspace (since 7.106.00), inside the workspace, so its row is one of the accept's own transaction entries
    (a workspace's transaction writes only its own rows, shared/ws_repo.py), atomic with the accept in both scopes. No
    role may change or remove a row there, nor put one but this one's writer: the audit-row guard denies both patterns,
    `AUDIT#*` and `WS#{one id}#AUDIT#*` (lib/utils/audit-row-guard.ts). Kept when the workspace is deleted
    (jobs/workspace_delete/test/families.py: ids only, as the deployment's are)."""
    return scoped_pk(workspace, AUDIT_PK)


def _audit_entry(table_name: str, item: Mapping[str, Any]) -> dict[str, Any]:
    return {'Put': {'TableName': table_name, 'Item': dict(item), 'ConditionExpression': 'attribute_not_exists(pk)'}}


def _proposal_entry_of(table_name: str, key: Mapping[str, str], proposal: Mapping[str, Any], applied: list[str],
                       status: str, now: str) -> dict[str, Any]:
    """The proposal's write: the ``accepted`` marks and the status, conditional on the proposal still being open and
    on its ``updated_at`` as read (another accept meanwhile is read again, so its marks count)."""
    entry = _proposal_entry(table_name, key, applied, status, now)
    update = entry['Update']
    read_at = proposal.get('updated_at')
    if isinstance(read_at, str):
        update['ConditionExpression'] += ' AND updated_at = :read_at'
        update['ExpressionAttributeValues'][':read_at'] = read_at
    else:
        update['ConditionExpression'] += ' AND attribute_not_exists(updated_at)'
    return entry


def _by(actor: Actor, value: str, proposed: Mapping[str, Any]) -> str:
    """Who an accepted field is written as: the extract, for its own value; the reviewer, for a value they edited."""
    return BY_EXTRACT if value == proposed.get('value') else actor.by


def _write_once(table: Any, project_id: str, key: Mapping[str, str], body: Mapping[str, Any],
                actor: Actor, *, workspace: WorkspaceScope | None) -> dict[str, Any] | None:
    """One attempt against a fresh read of the proposal and the context: the conflicts, then the transaction; None
    when one of its conditions lost a race (the context's or the proposal's)."""
    proposal = consistent_item(table, key)
    if proposal is None:
        raise NotFoundError('Proposal not found')
    if proposal.get('status') not in OPEN_STATUSES:
        raise ConflictError(PROPOSAL_CLOSED_MESSAGE, code='proposal_closed')
    fields = mapping_at(proposal, 'fields')
    requested = _requested(body, fields)
    state = context_state(table, project_id, workspace=workspace)
    conflicts = _conflicts(requested, state, actor)
    refused = {conflict['field'] for conflict in conflicts}
    applied = [name for name in requested if name not in refused]
    status = _status_after(fields, applied)
    if not applied:
        return {'applied': [], 'conflicts': conflicts, 'status': proposal.get('status')}
    now = now_iso()
    sources = proposal.get('sources') or []
    write = _Write({name: requested[name][1] for name in applied},
                   {name: {**actor.meta(now, _by(actor, requested[name][1], mapping_at(fields, name))),
                           'proposal_id': proposal.get('proposal_id'),
                           'source_ids': _source_ids(mapping_at(fields, name), sources)} for name in applied}, now)
    table_name = projects_table_name(table)
    try:
        transact_project_actions(table, project_id, [
            _context_entry(table_name, project_id, state, write, actor, workspace=workspace),
            _proposal_entry_of(table_name, key, proposal, applied, status, now),
            _audit_entry(table_name, _audit_item(project_id, proposal, applied, actor, now, workspace=workspace))],
            workspace=workspace)
    except ClientError as error:
        if _cancelled(error, _CONTEXT_AT, _PROPOSAL_AT):
            return None
    return {'applied': applied, 'conflicts': conflicts, 'status': status}


def accept(table: Any, project_id: str, proposal_id: str, body: Mapping[str, Any], actor: Actor, *,
           workspace: WorkspaceScope | None) -> dict[str, Any]:
    """Write the requested fields whose stored value is still the one seen: ``{applied, conflicts, status}``; 409
    carrying ``conflicts`` when none could be written, 409 ``proposal_closed`` once the proposal is not open."""
    key = _proposal_key(project_id, proposal_id, workspace=workspace)
    result = _twice(lambda: _write_once(table, project_id, key, body, actor, workspace=workspace))
    if not result['applied']:
        raise ConflictError('Every field changed since the extract, or is a value a person typed',
                            code='conflict', details={'conflicts': result['conflicts'], 'applied': [],
                                                      'status': result['status']})
    return result


# ── A deleted source ──────────────────────────────────────────────────────────────────────────────────────────

#: A proposal changed meanwhile (another source's delete, an accept) is read again at most this many times.
_FORGET_TRIES: Final = 3


def _without(fields: Mapping[str, Any], cited: set[str]) -> dict[str, tuple[list[Any], list[Any]]]:
    """Each field of ``fields`` that cites one of ``cited`` (source ids): its citations as read, and without those."""
    out = {}
    for name, entry in fields.items():
        citations = entry.get('citations') if isinstance(entry, Mapping) else None
        if not isinstance(citations, list):
            continue
        kept = [one for one in citations if not (isinstance(one, Mapping) and one.get('source_id') in cited)]
        if len(kept) != len(citations):
            out[str(name)] = (citations, kept)
    return out


def _forget_in(table: Any, key: Mapping[str, str], doc_id: str) -> bool:
    """Take ``doc_id``'s citations out of one proposal; False when it changed under every try (logged)."""
    for _ in range(_FORGET_TRIES):
        row = consistent_item(table, key) or {}
        cited = {str(source.get('source_id')) for source in row.get('sources') or []
                 if isinstance(source, Mapping) and source.get('doc_id') == doc_id}
        changed = _without(mapping_at(row, 'fields'), cited) if cited else {}
        if not changed:
            return True
        names = {'#fields': 'fields', '#citations': 'citations'}
        values: dict[str, Any] = {}
        sets, conditions = [], ['attribute_exists(pk)']
        for index, (name, (read, kept)) in enumerate(changed.items()):
            names[f'#f{index}'] = name
            values[f':r{index}'], values[f':k{index}'] = read, kept
            sets.append(f'#fields.#f{index}.#citations = :k{index}')
            conditions.append(f'#fields.#f{index}.#citations = :r{index}')
        if update_unless_condition_fails(table, Key=dict(key), UpdateExpression='SET ' + ', '.join(sets),
                                         ConditionExpression=' AND '.join(conditions),
                                         ExpressionAttributeNames=names, ExpressionAttributeValues=values):
            return True
    logger.warning('A product proposal kept changing; the deleted source\'s citations are left in it')
    return False


def forget_source(table: Any, project_id: str, doc_id: str, *, workspace: WorkspaceScope | None) -> int:
    """After a source's delete (api/product_context.py ``delete_doc``, and an extract that finished after it,
    shared/product_extract.py): take its citations, and so the words they quote from it, out of every proposal of the
    project, whatever its status. That is all it removes: each proposal keeps its values and notes (which may restate
    the source), its questions, and its ``sources`` entry for the source, the source's name included, which GET
    …/latest marks ``deleted``; an erasure by email lists a proposal whose remaining words hold the address for review
    (jobs/retention/project_people.py). Each update is conditional on the citations as read, so a concurrent delete
    of another source or an accept is read again. Never raises (the source is deleted either way): a failure is
    logged. Answers how many proposals of ``workspace``'s project (None: the deployment's) cited it."""
    try:
        rows = query_all(table, {
            'KeyConditionExpression': _proposals_partition(project_id, workspace=workspace),
            'ProjectionExpression': 'pk, sk, #sources', 'ExpressionAttributeNames': {'#sources': 'sources'},
            'ConsistentRead': True,
        })
        citing = [row for row in rows if any(isinstance(source, Mapping) and source.get('doc_id') == doc_id
                                             for source in row.get('sources') or [])]
        for row in citing:
            _forget_in(table, {'pk': row['pk'], 'sk': row['sk']}, doc_id)
    except (ClientError, BotoCoreError) as error:
        logger.warning('The proposals citing a deleted product source could not be read or changed',
                       extra={'error_class': type(error).__name__})
        return 0
    return len(citing)


# ── The lock and the limits ────────────────────────────────────────────────────────────────────────────────────


def take_lock(table: Any, project_id: str, lock_id: str, started_by: str, now: datetime, *,
              workspace: WorkspaceScope | None) -> bool:
    """Hold the project's extract lock as ``lock_id``: False while another extract holds it (and is not stale)."""
    require_deployment(workspace, PRODUCT_EXTRACT_STORE)
    epoch = int(now.timestamp())
    return update_unless_condition_fails(
        table, Key=_lock_key(project_id, workspace=workspace),
        UpdateExpression='SET lock_id = :id, started_at = :at, started_epoch = :epoch, started_by = :by '
                         'REMOVE job_id, released_at',
        ConditionExpression='attribute_not_exists(lock_id) OR started_epoch < :stale',
        ExpressionAttributeValues={':id': lock_id, ':at': now_iso(now), ':epoch': epoch, ':by': started_by,
                                   ':stale': epoch - LOCK_STALE_SECONDS})


def note_lock_job(table: Any, project_id: str, lock_id: str, job_id: str, *, workspace: WorkspaceScope | None) -> None:
    """Name the job holding the lock (best effort: the lock holds either way)."""
    require_deployment(workspace, PRODUCT_EXTRACT_STORE)
    update_unless_condition_fails(table, Key=_lock_key(project_id, workspace=workspace),
                                  UpdateExpression='SET job_id = :job',
                                  ConditionExpression='lock_id = :id',
                                  ExpressionAttributeValues={':job': job_id, ':id': lock_id})


def release_lock(table: Any, project_id: str, lock_id: str, *, workspace: WorkspaceScope | None) -> None:
    """Release the lock if ``lock_id`` still holds it (a stale one taken over is the new holder's)."""
    require_deployment(workspace, PRODUCT_EXTRACT_STORE)
    update_unless_condition_fails(table, Key=_lock_key(project_id, workspace=workspace),
                                  UpdateExpression='REMOVE lock_id SET released_at = :now',
                                  ConditionExpression='lock_id = :id',
                                  ExpressionAttributeValues={':id': lock_id, ':now': now_iso()})


def extract_counter_keys(project_id: str, subject: str, now: datetime, *,
                         workspace: WorkspaceScope | None) -> tuple[tuple[dict[str, str], int], ...]:
    """The extract limits' counters and their limits in voc-aggregates: the project's of ``now``'s UTC minute and day
    and the person's of its day, in ``workspace`` (``WS#{ws}#…``; None: the deployment's)."""
    day = f'{now:%Y-%m-%d}'
    return (({'pk': scoped_pk(workspace, f'PRODUCTX#PROJECT#{project_id}#{now:%Y%m%d%H%M}'), 'sk': 'COUNT'},
             EXTRACTS_PER_MINUTE),
            ({'pk': scoped_pk(workspace, f'PRODUCTX#PROJECT#{project_id}#{day}'), 'sk': 'COUNT'},
             PROJECT_EXTRACTS_PER_DAY),
            ({'pk': scoped_pk(workspace, f'PRODUCTX#USER#{subject}#{day}'), 'sk': 'COUNT'}, PERSON_EXTRACTS_PER_DAY))


def count_extract(aggregates: Any, project_id: str, subject: str, now: datetime, *,
                  workspace: WorkspaceScope | None) -> None:
    """Count one extract against each limit, all three at once or none (shared/aws.py ``count_once``), or 429
    ``rate_limited`` when one is reached (nothing counted). Refused in a workspace until the extract's job moves
    (3h-S8), before anything is counted."""
    require_deployment(workspace, PRODUCT_EXTRACT_STORE)
    message = (f'Too many extracts: at most {EXTRACTS_PER_MINUTE} a minute and {PROJECT_EXTRACTS_PER_DAY} a day per '
               f'project, {PERSON_EXTRACTS_PER_DAY} a day per person. Try again later.')
    count_once(aggregates, [Counter(key, limit, 'rate_limited', message)
                            for key, limit in extract_counter_keys(project_id, subject, now, workspace=workspace)],
               now)
