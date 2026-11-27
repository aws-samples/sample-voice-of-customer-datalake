"""People in voc-participants (docs/participants.md -> Data model).

``PERSON#{id}`` / ``META`` is the person; ``EMAIL#{sha256(email_lc)}`` / ``PERSON``
is the uniqueness guard, written in the SAME TransactWrite, so two people can never
share an address. Two sets on META are bookkeeping for erasure and never leave
this module's views: ``project_ids`` (the projects linking the person) and
``token_hashes`` (every response / unsubscribe token minted for them).

Emails and tokens are personal data: never log them (log ids and counts).

Every store takes a keyword-only ``workspace`` (plumbing since 7.31.00, docs/multi-workspace.md, the project plan,
3d; no route passes one yet): without one each request is the one sent before; in one the person, its guard and its
``gsi1`` partition are the workspace's (shared/participants_keys.py), every call goes through the workspace layer
(shared/participants_tables.py), and a new person's partition and guard are listed in the workspace's index
(``WS#{ws}#PARTICIPANTS``) in the person's own transaction, so the hard delete finds them. A person's tokens are the asks' (deployment-wide): minting
one in a workspace is refused (``PARTICIPANT_ASKS_STORE``).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import cancelled_by_condition
from shared.engagement_common import (
    conditional_write,
    new_id,
    normalize_email,
    now_iso,
    optional_text,
    public_fields,
    string_list,
    update_existing,
)
from shared.exceptions import ConflictError, NotFoundError
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.ingest_tables import scoped_calls
from shared.participants_keys import (
    PARTICIPANT_ASKS_STORE,
    PARTICIPANT_SETTINGS_STORE,
    email_guard_key,
    participants_index_key,
    people_index_pk,
    person_key,
)
from shared.participants_settings import may_add_person
from shared.participants_tables import rows_by_id_in, scoped_rows, transact
from shared.project_keys import require_deployment
from shared.ws_repo import WorkspaceScope

PERSON_PREFIX: Final = 'per'
STATUS_ACTIVE: Final = 'active'
STATUS_UNSUBSCRIBED: Final = 'unsubscribed'
ORIGINS: Final = frozenset({'manual', 'assistant', 'feature_request'})
MAX_PEOPLE_LISTED: Final = 500
# How many PEOPLE rows a search reads at most before it stops looking for matches.
MAX_PEOPLE_SCANNED: Final = 10_000
TEXT_LIMITS: Final = {'name': 160, 'company': 160, 'title': 160, 'notes': 2000}
MAX_TAGS: Final = 20
MAX_TAG_CHARS: Final = 40
PERSON_NOT_FOUND: Final = 'Person not found'
_HIDDEN: Final = frozenset({'email_lc', 'unsub_token_hash', 'token_hashes', 'project_ids'})
REASON_INVALID_EMAIL: Final = 'invalid_email'
REASON_EXTERNAL: Final = 'external_not_allowed'


class EmailTakenError(ConflictError):
    def __init__(self) -> None:
        super().__init__('A person with this email already exists')


def person_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """The person as the API answers it; ``list_ids`` (the lists they belong to) always present, sorted."""
    view = public_fields(item, _HIDDEN)
    view.setdefault('tags', [])
    view.setdefault('list_ids', [])
    return view


def person_fields(body: Mapping[str, Any]) -> dict[str, Any]:
    """The editable fields present in ``body`` (name, company, title, notes, tags), validated."""
    fields: dict[str, Any] = {}
    for field, limit in TEXT_LIMITS.items():
        if field in body:
            fields[field] = optional_text(body, field, limit) or ''
    if 'tags' in body:
        fields['tags'] = string_list(body.get('tags'), 'tags', max_items=MAX_TAGS, max_chars=MAX_TAG_CHARS)
    return fields


def find_person_id(table: Any, email_lc: str, *, workspace: WorkspaceScope | None = None) -> str | None:
    item = scoped_calls(table, workspace).get_item(Key=email_guard_key(email_lc, workspace=workspace),
                                            ConsistentRead=True).get('Item')
    person_id = item.get('person_id') if item else None
    return person_id if isinstance(person_id, str) else None


def get_person(table: Any, person_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, Any] | None:
    item = scoped_calls(table, workspace).get_item(Key=person_key(person_id, workspace=workspace)).get('Item')
    return item if isinstance(item, dict) else None


def require_person(table: Any, person_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    item = get_person(table, person_id, workspace=workspace)
    if item is None:
        raise NotFoundError(PERSON_NOT_FOUND)
    return item


def get_people(table: Any, person_ids: Iterable[str], *,
               workspace: WorkspaceScope | None = None) -> dict[str, dict[str, Any]]:
    """``{person_id: META}`` for the ids that exist (erased people are simply absent)."""
    return rows_by_id_in(table, workspace, [person_key(pid, workspace=workspace) for pid in dict.fromkeys(person_ids)],
                         'person_id', 'people')


def _index_rows(item: Mapping[str, Any], guard: Mapping[str, Any], workspace: WorkspaceScope) -> list[dict[str, str]]:
    """The workspace index's rows of a new person's partition and of its address guard (the hard delete finds them
    from it), written in the person's own transaction."""
    return [participants_index_key(str(row['pk']), workspace=workspace) for row in (item, guard)]


def create_person(table: Any, *, email: str, email_lc: str, fields: Mapping[str, Any], origin: str,
                  created_by: str, workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    """Write the person and its email guard together; EmailTakenError when the address is known."""
    person_id = new_id(PERSON_PREFIX)
    now = now_iso()
    item: dict[str, Any] = {
        **person_key(person_id, workspace=workspace), 'person_id': person_id, 'email': email, 'email_lc': email_lc,
        'name': '', 'company': '', 'title': '', 'notes': '', 'tags': [], **fields,
        'status': STATUS_ACTIVE, 'origin': origin if origin in ORIGINS else 'manual',
        'created_at': now, 'created_by': created_by, 'updated_at': now,
        'gsi1pk': people_index_pk(workspace=workspace), 'gsi1sk': email_lc,
    }
    absent = 'attribute_not_exists(pk)'
    guard = {**email_guard_key(email_lc, workspace=workspace), 'person_id': person_id}
    try:
        # In a workspace, the person, its guard and their two index rows in ONE transaction: an erasure's conditional
        # unlisting of the guard (shared/participants_tables.py unlist_if_empty) is serialised against it, so a guard
        # is never written unlisted.
        index_rows = [] if workspace is None else _index_rows(item, guard, workspace)
        transact(table, workspace, [{'Put': {'Item': item, 'ConditionExpression': absent}},
                                    {'Put': {'ConditionExpression': absent, 'Item': guard}},
                                    *({'Put': {'Item': row}} for row in index_rows)])
    except ClientError as error:
        if cancelled_by_condition(error):
            raise EmailTakenError from error
        raise
    return item


def upsert_person(table: Any, settings: Mapping[str, Any], raw: Mapping[str, Any], *, origin: str,
                  created_by: str, workspace: WorkspaceScope | None = None) -> tuple[str, bool]:
    """``(person_id, created)`` for the email in ``raw``: the known person, else a new one.

    ValueError(reason) when the address is invalid or a NEW external person is not allowed
    (an existing person is always returned, unsubscribed or not; they are skipped at send).

    ``settings`` decide who may be added, and they are the deployment's (shared/participants_settings.py): a NEW
    person in a workspace is refused (``NotPerWorkspaceError``, ``PARTICIPANT_SETTINGS_STORE``) until the settings move
    into their workspace (an erasure by email reaches a workspace's people since 7.72.00, the project plan's 3g2, so
    only that move is left); an existing person of the workspace is still returned.
    """
    email, email_lc = normalize_email(raw.get('email'))
    existing = find_person_id(table, email_lc, workspace=workspace)
    if existing:
        return existing, False
    require_deployment(workspace, PARTICIPANT_SETTINGS_STORE)
    if not may_add_person(settings, email_lc):
        raise ValueError(REASON_EXTERNAL)
    try:
        item = create_person(table, email=email, email_lc=email_lc, fields=person_fields(raw), origin=origin,
                             created_by=created_by, workspace=workspace)
    except EmailTakenError:
        # Created concurrently: the guard now names the winner.
        winner = find_person_id(table, email_lc, workspace=workspace)
        if winner is None:
            raise
        return winner, False
    return item['person_id'], True


def update_person(table: Any, person_id: str, fields: Mapping[str, Any], *,
                  workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    return update_existing(scoped_calls(table, workspace), person_key(person_id, workspace=workspace), fields,
                           PERSON_NOT_FOUND)


def matches_query(item: Mapping[str, Any], needle: str) -> bool:
    return any(needle in str(item.get(field) or '').lower() for field in ('email_lc', 'name', 'company'))


def list_people(table: Any, query: str = '', *, workspace: WorkspaceScope | None = None) -> list[dict[str, Any]]:
    """People by email, matching ``query`` (email / name / company, case-insensitive)."""
    needle = query.strip().lower()
    found: list[dict[str, Any]] = []
    rows = scoped_rows(table, workspace, people_index_pk(workspace=workspace), attribute='gsi1pk',
                       limit=MAX_PEOPLE_SCANNED, index=PARTICIPANTS_LISTING_INDEX, placeholders=(':p', ':s'))
    for item in rows:
        if not needle or matches_query(item, needle):
            found.append(item)
            if len(found) >= MAX_PEOPLE_LISTED:
                break
    return found


def remember_token(table: Any, person_id: str, token_hash: str, *, unsubscribe: bool,
                   workspace: WorkspaceScope | None = None) -> None:
    """Record a minted token's hash on the person (erasure deletes every one of them). The tokens are the asks'
    (deployment-wide): a workspace is refused."""
    require_deployment(workspace, PARTICIPANT_ASKS_STORE)
    expression = 'ADD token_hashes :h'
    values: dict[str, Any] = {':h': {token_hash}}
    if unsubscribe:
        expression += ' SET unsub_token_hash = :t'
        values[':t'] = token_hash
    table.update_item(Key=person_key(person_id), UpdateExpression=expression,
                      ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues=values)


def mark_unsubscribed(table: Any, person_id: str, *, workspace: WorkspaceScope | None = None) -> bool:
    """Set the person ``unsubscribed`` (idempotent); False when the person no longer exists (the condition writes
    nothing then, so no row is ever made)."""
    return conditional_write(
        scoped_calls(table, workspace).update_item,
        Key=person_key(person_id, workspace=workspace),
        UpdateExpression='SET #s = :u, unsubscribed_at = if_not_exists(unsubscribed_at, :now), updated_at = :now',
        ConditionExpression='attribute_exists(pk)',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':u': STATUS_UNSUBSCRIBED, ':now': now_iso()},
    )


def is_active(item: Mapping[str, Any] | None) -> bool:
    return item is not None and item.get('status') == STATUS_ACTIVE
