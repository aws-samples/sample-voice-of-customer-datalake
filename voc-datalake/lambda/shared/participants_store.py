"""People in voc-participants (docs/participants.md -> Data model).

``PERSON#{id}`` / ``META`` is the person; ``EMAIL#{sha256(email_lc)}`` / ``PERSON``
is the uniqueness guard, written in the SAME TransactWrite, so two people can never
share an address. Two sets on META are bookkeeping for erasure and never leave
this module's views: ``project_ids`` (the projects linking the person) and
``token_hashes`` (every response / unsubscribe token minted for them).

Emails and tokens are personal data: never log them (log ids and counts).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.digests import sha256_hex
from shared.dynamo_paging import iter_query
from shared.engagement_common import (
    conditional_write,
    new_id,
    normalize_email,
    now_iso,
    optional_text,
    public_fields,
    rows_by_id,
    string_list,
    update_existing,
)
from shared.exceptions import ConflictError, NotFoundError
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.participants_settings import may_add_person

PERSON_PREFIX: Final = 'per'
PEOPLE_PARTITION: Final = 'PEOPLE'
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


def person_key(person_id: str) -> dict[str, str]:
    return {'pk': f'PERSON#{person_id}', 'sk': 'META'}


def email_guard_key(email_lc: str) -> dict[str, str]:
    return {'pk': f'EMAIL#{sha256_hex(email_lc)}', 'sk': 'PERSON'}


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


def find_person_id(table: Any, email_lc: str) -> str | None:
    item = table.get_item(Key=email_guard_key(email_lc), ConsistentRead=True).get('Item')
    person_id = item.get('person_id') if item else None
    return person_id if isinstance(person_id, str) else None


def get_person(table: Any, person_id: str) -> dict[str, Any] | None:
    item = table.get_item(Key=person_key(person_id)).get('Item')
    return item if isinstance(item, dict) else None


def require_person(table: Any, person_id: str) -> dict[str, Any]:
    item = get_person(table, person_id)
    if item is None:
        raise NotFoundError(PERSON_NOT_FOUND)
    return item


def get_people(table: Any, person_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    """``{person_id: META}`` for the ids that exist (erased people are simply absent)."""
    return rows_by_id(table, [person_key(pid) for pid in dict.fromkeys(person_ids)], 'person_id', 'people')


def _is_cancelled_by_condition(error: ClientError) -> bool:
    if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
        return False
    reasons = error.response.get('CancellationReasons') or []
    return any(reason.get('Code') == 'ConditionalCheckFailed' for reason in reasons)


def create_person(table: Any, *, email: str, email_lc: str, fields: Mapping[str, Any], origin: str,
                  created_by: str) -> dict[str, Any]:
    """Write the person and its email guard together; EmailTakenError when the address is known."""
    person_id = new_id(PERSON_PREFIX)
    now = now_iso()
    item: dict[str, Any] = {
        **person_key(person_id), 'person_id': person_id, 'email': email, 'email_lc': email_lc,
        'name': '', 'company': '', 'title': '', 'notes': '', 'tags': [], **fields,
        'status': STATUS_ACTIVE, 'origin': origin if origin in ORIGINS else 'manual',
        'created_at': now, 'created_by': created_by, 'updated_at': now,
        'gsi1pk': PEOPLE_PARTITION, 'gsi1sk': email_lc,
    }
    absent = 'attribute_not_exists(pk)'
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'Item': item, 'ConditionExpression': absent}},
            {'Put': {'TableName': table.name, 'ConditionExpression': absent,
                     'Item': {**email_guard_key(email_lc), 'person_id': person_id}}},
        ])
    except ClientError as error:
        if _is_cancelled_by_condition(error):
            raise EmailTakenError from error
        raise
    return item


def upsert_person(table: Any, settings: Mapping[str, Any], raw: Mapping[str, Any], *, origin: str,
                  created_by: str) -> tuple[str, bool]:
    """``(person_id, created)`` for the email in ``raw``: the known person, else a new one.

    ValueError(reason) when the address is invalid or a NEW external person is not allowed
    (an existing person is always returned, unsubscribed or not; they are skipped at send).
    """
    email, email_lc = normalize_email(raw.get('email'))
    existing = find_person_id(table, email_lc)
    if existing:
        return existing, False
    if not may_add_person(settings, email_lc):
        raise ValueError(REASON_EXTERNAL)
    try:
        item = create_person(table, email=email, email_lc=email_lc, fields=person_fields(raw), origin=origin,
                             created_by=created_by)
    except EmailTakenError:
        # Created concurrently: the guard now names the winner.
        winner = find_person_id(table, email_lc)
        if winner is None:
            raise
        return winner, False
    return item['person_id'], True


def update_person(table: Any, person_id: str, fields: Mapping[str, Any]) -> dict[str, Any]:
    return update_existing(table, person_key(person_id), fields, PERSON_NOT_FOUND)


def matches_query(item: Mapping[str, Any], needle: str) -> bool:
    return any(needle in str(item.get(field) or '').lower() for field in ('email_lc', 'name', 'company'))


def list_people(table: Any, query: str = '') -> list[dict[str, Any]]:
    """People by email, matching ``query`` (email / name / company, case-insensitive)."""
    needle = query.strip().lower()
    found: list[dict[str, Any]] = []
    rows = iter_query(table, {
        'IndexName': PARTICIPANTS_LISTING_INDEX,
        'KeyConditionExpression': 'gsi1pk = :p',
        'ExpressionAttributeValues': {':p': PEOPLE_PARTITION},
    }, max_items=MAX_PEOPLE_SCANNED)
    for item in rows:
        if not needle or matches_query(item, needle):
            found.append(item)
            if len(found) >= MAX_PEOPLE_LISTED:
                break
    return found


def remember_token(table: Any, person_id: str, token_hash: str, *, unsubscribe: bool) -> None:
    """Record a minted token's hash on the person (erasure deletes every one of them)."""
    expression = 'ADD token_hashes :h'
    values: dict[str, Any] = {':h': {token_hash}}
    if unsubscribe:
        expression += ' SET unsub_token_hash = :t'
        values[':t'] = token_hash
    table.update_item(Key=person_key(person_id), UpdateExpression=expression,
                      ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues=values)


def mark_unsubscribed(table: Any, person_id: str) -> bool:
    """Set the person ``unsubscribed`` (idempotent); False when the person no longer exists."""
    return conditional_write(
        table.update_item,
        Key=person_key(person_id),
        UpdateExpression='SET #s = :u, unsubscribed_at = if_not_exists(unsubscribed_at, :now), updated_at = :now',
        ConditionExpression='attribute_exists(pk)',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':u': STATUS_UNSUBSCRIBED, ':now': now_iso()},
    )


def is_active(item: Mapping[str, Any] | None) -> bool:
    return item is not None and item.get('status') == STATUS_ACTIVE
